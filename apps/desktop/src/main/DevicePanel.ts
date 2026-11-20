import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Electron from "electron";

import { registerView } from "./Hardening.ts";
import { LOCAL_ENTRY } from "./LocalScheme.ts";
import { localViewOptions } from "./MainWindow.ts";

// The Agent Desktop window (docs/adr/0006, point 5): a small native window of the app's own page
// `?view=agent-desktop`, with the Environments, their switches, the account and Stop. One at a time;
// opening it again brings it to the front. Its view is a local one, hardened like the column's.

const AGENT_DESKTOP_PAGE = `${LOCAL_ENTRY}?view=agent-desktop`;
const WIDTH = 420;
const HEIGHT = 560;
const BACKGROUND = "#111318";

export interface DevicePanelOptions {
  readonly preloadPath: string;
  readonly title: string;
  // The main window, when it exists: the panel's parent.
  readonly parent: () => Option.Option<Electron.BaseWindow>;
  // The window got the focus: macOS's permissions are read again (MacPermissions.refresh).
  readonly focused: () => void;
}

export interface DevicePanel {
  // Opens the window, or brings the open one to the front; `anchor` places a new one's corner.
  readonly open: (anchor?: { readonly x: number; readonly y: number }) => void;
  // Removes the menu again: on Windows and Linux Menu.setApplicationMenu sets the app's menu on
  // every window, this one too. The app calls it after each.
  readonly removeMenu: () => void;
  // Whether the window is open and shown.
  readonly visible: () => boolean;
}

// The window lives at most as long as the scope.
export const make = Effect.fn("DevicePanel.make")(function* (options: DevicePanelOptions) {
  let current = Option.none<Electron.BaseWindow>();
  const close = () => {
    if (Option.isSome(current) && !current.value.isDestroyed()) current.value.destroy();
    current = Option.none();
  };
  yield* Effect.addFinalizer(() => Effect.sync(close));

  const open: DevicePanel["open"] = (anchor) => {
    if (Option.isSome(current) && !current.value.isDestroyed()) {
      const window = current.value;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    const parent = Option.getOrUndefined(options.parent());
    const window = new Electron.BaseWindow({
      width: WIDTH,
      height: HEIGHT,
      ...(anchor === undefined ? {} : { x: anchor.x, y: anchor.y }),
      ...(parent === undefined || parent.isDestroyed() ? {} : { parent }),
      show: false,
      title: options.title,
      backgroundColor: BACKGROUND,
      minimizable: false,
      fullscreenable: false,
    });
    // A small window of one purpose has no menu of its own (Windows, Linux); Chromium's editing
    // keys (copy, paste, select all) work without one.
    window.removeMenu();
    window.on("focus", options.focused);
    const view = new Electron.WebContentsView(localViewOptions(options.preloadPath));
    view.setBackgroundColor(BACKGROUND);
    registerView(view.webContents, "Local");
    window.contentView.addChildView(view);
    const layout = () => {
      const { width, height } = window.contentView.getBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    window.contentView.on("bounds-changed", layout);
    // A BaseWindow does not close its view's page.
    window.on("closed", () => {
      if (!view.webContents.isDestroyed()) view.webContents.close();
      current = Option.none();
    });
    current = Option.some(window);
    view.webContents.once("did-finish-load", () => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    void view.webContents.loadURL(AGENT_DESKTOP_PAGE);
  };
  const removeMenu = () => {
    if (Option.isSome(current) && !current.value.isDestroyed()) current.value.removeMenu();
  };
  const visible = () =>
    Option.isSome(current) &&
    !current.value.isDestroyed() &&
    current.value.isVisible() &&
    !current.value.isMinimized();
  const panel: DevicePanel = { open, removeMenu, visible };
  return panel;
});
