import * as Effect from "effect/Effect";

import * as Electron from "electron";

import type { TrayText } from "../ui/messages.ts";
import { trayMenu, trayTooltip } from "./Lifecycle.ts";

// The app's icon in the notification area (Windows and Linux) for as long as the scope lives:
// the tooltip names the app, its menu opens the window or quits, and a click or double-click shows
// the window. Quit is app.quit(), so it goes through the app's before-quit like any other quit.

export interface TrayOptions {
  readonly text: TrayText;
  readonly show: () => void;
  readonly showStatus: () => void;
  readonly agentDesktop: () => void;
  readonly stopAgent: () => void;
  readonly quit: () => void;
  // Whether an agent works now, and every change of that: the menu and tooltip follow it.
  readonly agentWorking: () => boolean;
  readonly changes: (listener: () => void) => () => void;
  // Each menu the tray shows, for the end-to-end tests.
  readonly menuBuilt: (menu: Electron.Menu) => void;
}

// The package carries no image of its own (electron-builder.yml names no icon), so the tray takes
// the icon of the app's own executable: on Windows the one inside Lazurio App.exe. Where the system
// gives none, the icon is empty and the tray still works.
const executableIcon = Effect.tryPromise({
  try: () => Electron.app.getFileIcon(process.execPath, { size: "small" }),
  catch: () => "no icon",
}).pipe(Effect.orElseSucceed(() => Electron.nativeImage.createEmpty()));

export const serve = Effect.fn("Tray.serve")(function* (options: TrayOptions) {
  const icon = yield* executableIcon;
  const tray = yield* Effect.acquireRelease(
    Effect.sync(() => new Electron.Tray(icon)),
    (tray) =>
      Effect.sync(() => {
        if (!tray.isDestroyed()) tray.destroy();
      }),
  );
  let shownWorking: boolean | undefined;
  const update = () => {
    const working = options.agentWorking();
    if (working === shownWorking || tray.isDestroyed()) return;
    shownWorking = working;
    tray.setToolTip(trayTooltip(options.text, working));
    const menu = Electron.Menu.buildFromTemplate(
      trayMenu(options.text, options, working).map((item) => ({
        label: item.label,
        click: item.click,
      })),
    );
    tray.setContextMenu(menu);
    options.menuBuilt(menu);
  };
  update();
  yield* Effect.acquireRelease(
    Effect.sync(() => options.changes(update)),
    (stop) => Effect.sync(stop),
  );
  tray.on("click", options.show);
  tray.on("double-click", options.show);
});
