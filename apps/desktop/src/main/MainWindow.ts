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

const attachRemoteView = Effect.fn("MainWindow.attachRemoteView")(function* (
  window: Electron.BrowserWindow,
  url: string,
  whenReachable: (url: string) => Effect.Effect<void>,
) {
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
