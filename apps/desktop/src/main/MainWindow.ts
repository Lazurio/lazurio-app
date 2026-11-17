import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { STATUS_CHANNEL, type AppStatus } from "../shared/bridge.ts";
import { hardenSession, registerView } from "./Hardening.ts";
import { LOCAL_ENTRY } from "./LocalScheme.ts";
import { destinationOf } from "./Navigation.ts";

// The main window: a local window with the preload bridge in a column on the left, and beside it
// at most one remote view for a page of the web Lazurio, which gets no preload and its own session.
// The column keeps the tailnets' status, their advice and the update controls in sight while a
// page is open (until the GEN4 window replaces this layout).

// The session of every remote view; the tailnet gives it its PAC script (Tailnet.ts).
export const REMOTE_PARTITION = "persist:lazurio-remote";
const LOCAL_COLUMN_WIDTH = 360;

export interface MainWindowOptions {
  readonly preloadPath: string;
  // Reads the app's current status whenever a local window asks.
  readonly status: () => AppStatus;
  readonly remoteUrl: Option.Option<string>;
  // Waits until the remote page's tailnet can reach it (Tailnet.Tailnets.whenReachable).
  readonly whenReachable: (url: string) => Effect.Effect<void>;
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

// Resolves once the window is shown, at once when it already is.
const whenShown = (window: Electron.BrowserWindow) =>
  Effect.callback<void>((resume) => {
    if (window.isVisible()) {
      resume(Effect.void);
      return;
    }
    const listener = () => resume(Effect.void);
    window.once("show", listener);
    return Effect.sync(() => window.off("show", listener));
  });

// What the remote page's renderer sees, for the log: a page hidden to it stays blank in the
// window (the trial of the proof of concept on Windows, 2026-11-17).
const PAGE_STATE = `({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })`;

const attachRemoteView = Effect.fn("MainWindow.attachRemoteView")(function* (
  window: Electron.BrowserWindow,
  url: string,
  whenReachable: (url: string) => Effect.Effect<void>,
) {
  // The view joins a window that is already shown. On Windows a view added to the window while
  // it was still hidden stayed blank after the window was shown.
  yield* whenShown(window);
  const view = new Electron.WebContentsView({
    webPreferences: {
      partition: REMOTE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  registerView(view.webContents, "Lazurio");
  yield* hardenSession(view.webContents.session);
  window.contentView.addChildView(view);
  const layout = () => {
    const [width = 0, height = 0] = window.getContentSize();
    view.setBounds({
      x: LOCAL_COLUMN_WIDTH,
      y: 0,
      width: Math.max(0, width - LOCAL_COLUMN_WIDTH),
      height,
    });
  };
  layout();
  window.on("resize", layout);
  window.on("show", layout);
  window.on("restore", layout);
  window.on("maximize", layout);
  window.on("unmaximize", layout);
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
  });
});

export const open = Effect.fn("MainWindow.open")(function* (options: MainWindowOptions) {
  yield* serveStatus(options.status);
  const window = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Electron.BrowserWindow({
          width: 1280,
          height: 800,
          show: false,
          title: "Lazurio App",
          webPreferences: {
            preload: options.preloadPath,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
          },
        }),
    ),
    (window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) window.destroy();
      }),
  );
  registerView(window.webContents, "Local");
  window.once("ready-to-show", () => window.show());
  yield* Effect.promise(() => window.loadURL(LOCAL_ENTRY));
  if (Option.isSome(options.remoteUrl)) {
    yield* attachRemoteView(window, options.remoteUrl.value, options.whenReachable);
  }
  return window;
});
