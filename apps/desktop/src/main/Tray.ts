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
  // Lazurio's own icon (build/icon.png, packaged under resources/icons), and the image the tray
  // shows, for the end-to-end tests.
  readonly iconPath: string;
  readonly iconBuilt: (image: Electron.NativeImage) => void;
}

// Lazurio's icon at the notification area's size, 16 pixels, and 32 for a display scaled 200 %.
// Not the executable's icon: on Windows app.getFileIcon gives the generic icon of an .exe (#80).
// Where the file is missing, the image is empty and the tray still works.
const TRAY_SIZES: ReadonlyArray<{ readonly scaleFactor: number; readonly size: number }> = [
  { scaleFactor: 1, size: 16 },
  { scaleFactor: 1.5, size: 24 },
  { scaleFactor: 2, size: 32 },
];

const trayIcon = (iconPath: string): Electron.NativeImage => {
  const source = Electron.nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) return source;
  const image = Electron.nativeImage.createEmpty();
  for (const { scaleFactor, size } of TRAY_SIZES) {
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: source.resize({ width: size, height: size, quality: "best" }).toPNG(),
    });
  }
  return image;
};

export const serve = Effect.fn("Tray.serve")(function* (options: TrayOptions) {
  const icon = trayIcon(options.iconPath);
  options.iconBuilt(icon);
  yield* Effect.logInfo("tray icon", { empty: icon.isEmpty(), scales: icon.getScaleFactors() });
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
