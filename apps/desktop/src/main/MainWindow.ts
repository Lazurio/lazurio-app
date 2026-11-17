import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { APP_NAME } from "../shared/appName.ts";
import { STATUS_CHANNEL, type AppStatus } from "../shared/bridge.ts";
import { hardenSession, registerView } from "./Hardening.ts";
import { LOCAL_ENTRY } from "./LocalScheme.ts";
import { destinationOf } from "./Navigation.ts";

// The main window: the local view with the preload bridge in a column, and beside it at most one
// remote view for a page of the web Lazurio, without preload and in its own session. The two views
// of a BaseWindow never overlap, so neither page is laid out under the other.

// The session of every remote view; the tailnet gives it its PAC script (Tailnet.ts).
export const REMOTE_PARTITION = "persist:lazurio-remote";
const LOCAL_COLUMN_WIDTH = 360;
// The local page's background, shown before a page paints instead of white.
const WINDOW_BACKGROUND = "#111318";

export interface MainWindowOptions {
  readonly preloadPath: string;
  // Reads the app's current status whenever a local window asks.
  readonly status: () => AppStatus;
  readonly remoteUrl: Option.Option<string>;
  // Waits until the remote page's tailnet can reach it (Tailnet.Tailnets.whenReachable).
  readonly whenReachable: (url: string) => Effect.Effect<void>;
  // Whether a tailnet serves the address (Tailnet.Tailnets.proxyFor): only such a page waits for
  // its Environment to become reachable, for example for the Organization to approve the Device.
  readonly servedByTailnet: (address: string) => boolean;
}

// The first remote page loads again after these failures, which a network that changed or a
// tailnet node that started a moment ago gives (Lazurio/lazurio-app#5), up to three times in all.
const RETRIED_FAILURES: ReadonlySet<string> = new Set([
  "ERR_NETWORK_CHANGED",
  "ERR_TUNNEL_CONNECTION_FAILED",
]);
const codeOf = (failure: unknown): string =>
  typeof failure === "object" &&
  failure !== null &&
  "code" in failure &&
  typeof failure.code === "string"
    ? failure.code
    : "";

class RemoteLoadError extends Schema.TaggedError<RemoteLoadError>()("RemoteLoadError", {
  code: Schema.String,
}) {}

// The sender's frame must be a local window of the app. Compared through destinationOf, not URL
// origins: Node's URL gives a custom scheme the opaque origin "null".
const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

const serveStatus = (status: () => AppStatus) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Electron.ipcMain.handle(STATUS_CHANNEL, (event) => {
        if (!isLocalSender(event)) throw new Error("refused: not a local window of the app");
        return status();
      }),
    ),
    () => Effect.sync(() => Electron.ipcMain.removeHandler(STATUS_CHANNEL)),
  );

// What the remote page's renderer sees, for the log. A page is hidden to it while the system's
// display is off, and the window then stays blank (the trial of 2026-11-17), so the log also gives
// the seconds since the last input, which a long idle time points to.
const PAGE_STATE = `({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })`;

const viewOptions = (
  preferences: Electron.WebPreferences,
): Electron.WebContentsViewConstructorOptions => ({
  webPreferences: {
    ...preferences,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  },
});

// A view and its page live as long as the scope; a closed window does not close a view's page.
const acquireView = (options: Electron.WebContentsViewConstructorOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => new Electron.WebContentsView(options)),
    (view) =>
      Effect.sync(() => {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }),
  );

const loadRemote = Effect.fn("MainWindow.loadRemote")(function* (
  window: Electron.BaseWindow,
  view: Electron.WebContentsView,
  url: string,
  whenReachable: (url: string) => Effect.Effect<void>,
) {
  // The page loads only once its tailnet runs, so the first load does not fail while the node
  // starts.
  yield* whenReachable(url).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => view.webContents.loadURL(url),
        catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
      }),
    ),
    Effect.retry({ times: 2, while: (failure) => RETRIED_FAILURES.has(failure.code) }),
    Effect.ignore,
  );
  const page = yield* Effect.tryPromise({
    try: () => view.webContents.executeJavaScript(PAGE_STATE) as Promise<unknown>,
    catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
  }).pipe(Effect.orElseSucceed(() => "unknown"));
  yield* Effect.logInfo("remote view", {
    windowVisible: window.isVisible(),
    viewVisible: view.getVisible(),
    bounds: view.getBounds(),
    page,
    idleSeconds: Electron.powerMonitor.getSystemIdleTime(),
  });
});

// Chromium's errors for a tailnet's page its node cannot reach yet (the Device waits for approval,
// or the network is not up): NETWORK_CHANGED, CONNECTION_REFUSED, NAME_NOT_RESOLVED,
// ADDRESS_UNREACHABLE, TUNNEL_CONNECTION_FAILED, CONNECTION_TIMED_OUT, PROXY_CONNECTION_FAILED.
const UNREACHABLE: ReadonlySet<number> = new Set([-21, -102, -105, -109, -111, -118, -130]);
// How often a waiting page tries its address again.
const RETRY_EVERY = "5 seconds";

// While a tailnet's page cannot be reached, the waiting view takes the remote view's place instead
// of a blank page and the address loads again every few seconds, until it shows (plan task 648).
const waitForReachable = Effect.fn("MainWindow.waitForReachable")(function* (
  remote: Electron.WebContentsView,
  waiting: Electron.WebContentsView,
  servedByTailnet: (address: string) => boolean,
) {
  let pending: string | undefined;
  const showWaiting = (shown: boolean) => {
    waiting.setVisible(shown);
    remote.setVisible(!shown);
  };
  remote.webContents.on("did-fail-load", (_event, code, _description, address, isMainFrame) => {
    if (!isMainFrame || !UNREACHABLE.has(code) || !servedByTailnet(address)) return;
    pending = address;
    showWaiting(true);
  });
  remote.webContents.on("did-navigate", (_event, _address, responseCode) => {
    if (pending === undefined || responseCode <= 0) return;
    pending = undefined;
    showWaiting(false);
  });
  // One attempt at a time: the next waits until the previous load has finished or failed, so a
  // reachable Environment that answers slowly is not cancelled by the next attempt.
  yield* Effect.sleep(RETRY_EVERY).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const address = pending;
        if (address === undefined || remote.webContents.isDestroyed()) return Effect.void;
        return Effect.tryPromise({
          try: () => remote.webContents.loadURL(address),
          catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
        }).pipe(Effect.ignore);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
});

export const open = Effect.fn("MainWindow.open")(function* (options: MainWindowOptions) {
  yield* serveStatus(options.status);
  const window = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Electron.BaseWindow({
          width: 1280,
          height: 800,
          show: false,
          title: APP_NAME,
          backgroundColor: WINDOW_BACKGROUND,
        }),
    ),
    (window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) window.destroy();
      }),
  );
  const local = yield* acquireView(viewOptions({ preload: options.preloadPath }));
  local.setBackgroundColor(WINDOW_BACKGROUND);
  registerView(local.webContents, "Local");
  window.contentView.addChildView(local);

  let remote: Electron.WebContentsView | undefined;
  let waiting: Electron.WebContentsView | undefined;
  if (Option.isSome(options.remoteUrl)) {
    remote = yield* acquireView(viewOptions({ partition: REMOTE_PARTITION }));
    registerView(remote.webContents, "Lazurio");
    yield* hardenSession(remote.webContents.session);
    window.contentView.addChildView(remote);
    // The app's own page in the remote view's place while a tailnet's page cannot be reached.
    waiting = yield* acquireView(viewOptions({}));
    waiting.setBackgroundColor(WINDOW_BACKGROUND);
    registerView(waiting.webContents, "Local");
    waiting.setVisible(false);
    window.contentView.addChildView(waiting);
  }
  // The column and the page side by side; without a page the local view takes the window.
  const layout = () => {
    // The content view's own size: on Linux the menu bar takes part of the content size.
    const { width, height } = window.contentView.getBounds();
    const column = remote === undefined ? width : Math.min(LOCAL_COLUMN_WIDTH, width);
    local.setBounds({ x: 0, y: 0, width: column, height });
    const page = { x: column, y: 0, width: Math.max(0, width - column), height };
    remote?.setBounds(page);
    waiting?.setBounds(page);
  };
  layout();
  // The content view changes size with the window and, on Linux, when the menu bar appears.
  window.contentView.on("bounds-changed", layout);
  // A BaseWindow does not close its views' pages; they close with the scope that ends here.
  if (remote !== undefined && waiting !== undefined) {
    yield* waitForReachable(remote, waiting, options.servedByTailnet);
  }
  window.on("closed", () => {
    for (const view of [local, remote, waiting]) {
      if (view !== undefined && !view.webContents.isDestroyed()) view.webContents.close();
    }
  });

  yield* Effect.promise(() => local.webContents.loadURL(LOCAL_ENTRY));
  if (waiting !== undefined) {
    const view = waiting;
    yield* Effect.promise(() => view.webContents.loadURL(`${LOCAL_ENTRY}#waiting`));
  }
  window.show();
  if (remote !== undefined && Option.isSome(options.remoteUrl)) {
    yield* loadRemote(window, remote, options.remoteUrl.value, options.whenReachable);
  }
  return window;
});
