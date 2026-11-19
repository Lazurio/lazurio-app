import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { APP_NAME } from "../shared/appName.ts";
import { STATUS_CHANNEL, type AppStatus, type PageOutcome } from "../shared/bridge.ts";
import { problemQuery, type PageProblem } from "../shared/pageProblem.ts";
import { hardenSession, hostOf, onMainFrameRefused, registerView } from "./Hardening.ts";
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
  // Learns each page the remote view's main frame shows (Agent Desktop offers to add its
  // Environment).
  readonly pageShown: (url: string) => void;
  // How each navigation of the page ended, for Copy status.
  readonly pageOutcome: (outcome: PageOutcome) => void;
  // Whether a tailnet serves the address (Tailnet.Tailnets.proxyFor): only such a page waits for
  // its Environment to become reachable, for example for the Organization to approve the Device.
  readonly servedByTailnet: (address: string) => boolean;
  // The window, as soon as it exists, so the tray, a second start or the Dock can show it.
  readonly created: (window: Electron.BaseWindow) => void;
  // Whether the window shows once its page loaded: not at a start with --hidden, unless a second
  // start or the tray asked for it meanwhile.
  readonly showOnLoad: () => boolean;
  // What closing the window does (Lifecycle.closeStep), and what follows when it hides.
  readonly closeStep: () => "hide" | "close" | "keep";
  readonly hidden: () => void;
  // Windows ends the person's session (log off, restart): the app quits.
  readonly sessionEnds: () => void;
  // Whether the app's status column shows beside the page; hidden by default (2026-11-18).
  readonly statusShown: () => boolean;
  // A bar above the page, laid out with the window (Agent Desktop's "an agent works" bar).
  readonly topBar?: { readonly view: Electron.WebContentsView; readonly height: () => number };
  // The window's controls once its views exist: lay them out again, reload the page.
  readonly controls: (controls: MainWindowControls) => void;
}

export interface MainWindowControls {
  // Lays the views out again, after the status column or the top bar showed or hid.
  readonly relayout: () => void;
  readonly reloadPage: () => void;
  // Loads the page again from the app's page that says why it did not show; settles once the
  // attempt has shown or failed.
  readonly retryPage: () => Promise<void>;
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

// A view of the app's own pages with the bridge: sandboxed, isolated, no Node (DevicePanel.ts).
export const localViewOptions = (preloadPath: string): Electron.WebContentsViewConstructorOptions =>
  viewOptions({ preload: preloadPath });

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

interface PageWatch {
  readonly retry: () => Promise<void>;
  readonly reload: () => void;
}

// The page never stays blank (#36): an unreachable tailnet's page waits and loads again every few
// seconds (task 648); any other failed load, refused redirect, proxy 407 or gone renderer shows
// the reason and Retry. Each outcome is logged (host and code) and kept for Copy status (code).
const watchPage = Effect.fn("MainWindow.watchPage")(function* (options: {
  readonly remote: Electron.WebContentsView;
  readonly cover: Electron.WebContentsView;
  readonly firstAddress: string;
  readonly servedByTailnet: (address: string) => boolean;
  readonly outcome: (outcome: PageOutcome) => void;
}) {
  const { remote, cover } = options;
  const contents = remote.webContents;
  const log = Effect.runForkWith(yield* Effect.context<never>());
  // A tailnet's address that waits to become reachable.
  let pending: string | undefined;
  // The address Retry loads, while the app's page shows instead of the page.
  let retryAddress: string | undefined;
  // The address of the app's page in the page's place, while it shows or loads.
  let covered: string | undefined;
  let lastShown: string | undefined;

  const uncover = () => {
    covered = undefined;
    cover.setVisible(false);
    remote.setVisible(true);
  };
  // It shows once its page has loaded, so a previous reason never flashes, unless the page
  // showed meanwhile.
  const showCover = (address: string) => {
    covered = address;
    const show = () => {
      if (covered !== address) return;
      cover.setVisible(true);
      remote.setVisible(false);
    };
    if (cover.webContents.getURL() === address) show();
    else void cover.webContents.loadURL(address).then(show, show);
  };
  const showProblem = (problem: PageProblem, outcome: PageOutcome, retry: string) => {
    pending = undefined;
    retryAddress = retry;
    showCover(`${LOCAL_ENTRY}${problemQuery(problem)}#waiting`);
    options.outcome(outcome);
  };
  // A refused navigation ends without any failure: a page that shows stays as it is, but in place
  // of nothing or of the app's page (a Retry refused, review of #66) the reason must show.
  onMainFrameRefused(contents, (refused) => {
    const inBrowser = destinationOf(refused.address)._tag === "SystemBrowser";
    if (lastShown !== undefined && covered === undefined) {
      return options.outcome({ outcome: "refused", inBrowser });
    }
    showProblem(
      { kind: inBrowser ? "browser" : "refused", host: hostOf(refused.address) },
      { outcome: "refused", inBrowser },
      lastShown ?? options.firstAddress,
    );
  });
  contents.on("did-navigate", (_event, address, responseCode) => {
    const host = hostOf(address);
    // The tailnet helper's proxy answered instead of the page: never an Environment's own page.
    if (responseCode === 407) {
      log(Effect.logWarning("page refused by the proxy", { host }));
      showProblem({ kind: "proxy", host }, { outcome: "proxy-refused" }, address);
      return;
    }
    if (responseCode <= 0) return;
    lastShown = address;
    pending = undefined;
    retryAddress = undefined;
    log(Effect.logInfo("page shown", { host, responseCode }));
    options.outcome({ outcome: "shown", responseCode });
    if (covered !== undefined) uncover();
  });
  contents.on("did-fail-load", (_event, code, description, address, isMainFrame) => {
    if (!isMainFrame) return;
    // An abort follows a newer navigation, a page's stop or a download, or the proxy's 407 above.
    if (code === -3) return;
    const host = hostOf(address);
    if (UNREACHABLE.has(code) && options.servedByTailnet(address)) {
      log(Effect.logWarning("page waits for its tailnet", { host, code }));
      pending = address;
      retryAddress = address;
      showCover(`${LOCAL_ENTRY}${problemQuery({ kind: "waiting", code, host })}#waiting`);
      options.outcome({ outcome: "waiting", code });
      return;
    }
    log(Effect.logWarning("page failed", { host, code, description }));
    showProblem({ kind: "failed", code, host }, { outcome: "failed", code }, address);
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log(Effect.logError("page renderer gone", { reason: details.reason }));
    showProblem(
      { kind: "crashed" },
      { outcome: "crashed", reason: details.reason },
      lastShown ?? options.firstAddress,
    );
  });
  // One attempt at a time: the next waits until the previous load has finished or failed, so a
  // reachable Environment that answers slowly is not cancelled by the next attempt.
  yield* Effect.sleep(RETRY_EVERY).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const address = pending;
        if (address === undefined || contents.isDestroyed()) return Effect.void;
        return Effect.tryPromise({
          try: () => contents.loadURL(address),
          catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
        }).pipe(Effect.ignore);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  const retry = async () => {
    if (contents.isDestroyed()) return;
    const address = retryAddress ?? (contents.getURL() || options.firstAddress);
    await contents.loadURL(address).catch(() => undefined);
  };
  return {
    retry,
    reload: () => {
      if (contents.isDestroyed()) return;
      if (covered !== undefined) void retry();
      else contents.reload();
    },
  } satisfies PageWatch;
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
  options.created(window);
  // Closing the window hides it, so the app and Agent Desktop run on (Tray.ts); only a quit closes it.
  // While an agent works it stays where it is.
  window.on("close", (event) => {
    const step = options.closeStep();
    if (step === "close") return;
    event.preventDefault();
    if (step === "keep") return;
    window.hide();
    options.hidden();
  });
  window.on("session-end", options.sessionEnds);
  const local = yield* acquireView(viewOptions({ preload: options.preloadPath }));
  local.setBackgroundColor(WINDOW_BACKGROUND);
  registerView(local.webContents, "Local");
  window.contentView.addChildView(local);

  let remote: Electron.WebContentsView | undefined;
  let waiting: Electron.WebContentsView | undefined;
  if (Option.isSome(options.remoteUrl)) {
    remote = yield* acquireView(viewOptions({ partition: REMOTE_PARTITION }));
    registerView(remote.webContents, "Lazurio");
    remote.webContents.on("did-navigate", (_event, url) => options.pageShown(url));
    yield* hardenSession(remote.webContents.session);
    window.contentView.addChildView(remote);
    // The app's own page in the remote view's place while a tailnet's page cannot be reached. It
    // has the bridge, so it can open the status column.
    waiting = yield* acquireView(viewOptions({ preload: options.preloadPath }));
    waiting.setBackgroundColor(WINDOW_BACKGROUND);
    registerView(waiting.webContents, "Local");
    waiting.setVisible(false);
    window.contentView.addChildView(waiting);
  }
  if (options.topBar !== undefined) window.contentView.addChildView(options.topBar.view);
  // The status column, when shown, and the page side by side, with the top bar over the page;
  // without a page the local view takes the window.
  const layout = () => {
    // The content view's own size: on Linux the menu bar takes part of the content size.
    const { width, height } = window.contentView.getBounds();
    const shown = remote === undefined || options.statusShown();
    const column = remote === undefined ? width : shown ? Math.min(LOCAL_COLUMN_WIDTH, width) : 0;
    // The bar spans the whole width over the column and the page, so its message, Stop and Agent
    // Desktop stay usable in a narrow window and without a remote page (review of #62).
    const bar = Math.min(options.topBar?.height() ?? 0, height);
    options.topBar?.view.setBounds({ x: 0, y: 0, width, height: bar });
    local.setVisible(shown);
    local.setBounds({ x: 0, y: bar, width: column, height: height - bar });
    const page = { x: column, y: bar, width: Math.max(0, width - column), height: height - bar };
    remote?.setBounds(page);
    waiting?.setBounds(page);
  };
  layout();
  // The content view changes size with the window and, on Linux, when the menu bar appears.
  window.contentView.on("bounds-changed", layout);
  const watch =
    remote !== undefined && waiting !== undefined && Option.isSome(options.remoteUrl)
      ? yield* watchPage({
          remote,
          cover: waiting,
          firstAddress: options.remoteUrl.value,
          servedByTailnet: options.servedByTailnet,
          outcome: options.pageOutcome,
        })
      : undefined;
  options.controls({
    relayout: layout,
    reloadPage: () => watch?.reload(),
    retryPage: () => watch?.retry() ?? Promise.resolve(),
  });
  // A BaseWindow does not close its views' pages; they close here or with the scope.
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
  if (options.showOnLoad()) window.show();
  if (remote !== undefined && Option.isSome(options.remoteUrl)) {
    yield* loadRemote(window, remote, options.remoteUrl.value, options.whenReachable);
  }
  return window;
});
