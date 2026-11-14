import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Electron from "electron";

import { STATUS_CHANNEL, type AppStatus } from "../shared/bridge.ts";
import { hardenSession, registerView } from "./Hardening.ts";
import { LOCAL_ENTRY } from "./LocalScheme.ts";
import { destinationOf } from "./Navigation.ts";

// The main window: a local window with the preload bridge, and below it at most one remote view
// for a page of the web Lazurio, which gets no preload and its own session.

// The session of every remote view; the tailnet gives it its PAC script (Tailnet.ts).
export const REMOTE_PARTITION = "persist:lazurio-remote";
const HEADER_HEIGHT = 120;

export interface MainWindowOptions {
  readonly preloadPath: string;
  // Reads the app's current status whenever a local window asks.
  readonly status: () => AppStatus;
  readonly remoteUrl: Option.Option<string>;
}

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
    view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) });
  };
  layout();
  window.on("resize", layout);
  yield* Effect.promise(() => view.webContents.loadURL(url).catch(() => undefined));
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
  if (Option.isSome(options.remoteUrl)) yield* attachRemoteView(window, options.remoteUrl.value);
  return window;
});
