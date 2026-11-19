import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";

import * as Electron from "electron";

// A window that shows while its pages count themselves hidden stays blank: after a start with the
// display off and after the display woke (#36, 2026-11-19). Only on Windows, where the app turns
// off Chromium's native occlusion (main.ts): there a page of a shown, unminimized window is never
// rightly hidden. On a Mac a covered window's page is hidden by design and stays as it is.

export interface WatchedView {
  // For the log only: column, page, waiting, bar, agent-desktop.
  readonly name: string;
  readonly view: Electron.WebContentsView;
  // Only the app's own pages load again; a page of the web Lazurio may hold unsaved work.
  readonly reloadable: boolean;
}

// What the check needs from Electron, so that its decisions are unit-tested (Repaint.test.ts).
export interface RepaintPort<View> {
  readonly windowShowing: () => boolean;
  // The views the window means to show now, read again after every wait.
  readonly views: () => ReadonlyArray<{
    readonly name: string;
    readonly view: View;
    readonly reloadable: boolean;
  }>;
  readonly usable: (view: View) => boolean;
  readonly visibilityOf: (view: View) => Promise<string>;
  readonly reattach: (view: View) => void;
  readonly reload: (view: View) => void;
  readonly log: (fields: Readonly<Record<string, string>>) => void;
}

// Whether the view is still one the window means to show, in a window that shows.
const stillShown = <View>(port: RepaintPort<View>, name: string, view: View): boolean =>
  port.windowShowing() &&
  port.usable(view) &&
  port.views().some((entry) => entry.name === name && entry.view === view);

export const checkViews = async <View>(port: RepaintPort<View>, reason: string): Promise<void> => {
  for (const { name, view, reloadable } of port.views()) {
    if (!stillShown(port, name, view)) continue;
    const before = await port.visibilityOf(view);
    if (before !== "hidden" || !stillShown(port, name, view)) continue;
    port.reattach(view);
    let after = await port.visibilityOf(view);
    if (after === "hidden" && reloadable && stillShown(port, name, view)) {
      port.reload(view);
      after = "reloaded";
    }
    port.log({ view: name, reason, before, after });
  }
};

// The page's visibility once it settled: a page that just became visible again says so within a
// moment; one that stays hidden answers after the wait.
const SETTLED_VISIBILITY = `new Promise((resolve) => {
  if (document.visibilityState === "visible") return resolve("visible");
  const done = () => resolve(document.visibilityState);
  const timer = setTimeout(done, 1000);
  document.addEventListener("visibilitychange", () => { clearTimeout(timer); done(); }, { once: true });
})`;

const usable = (view: Electron.WebContentsView): boolean =>
  view.getVisible() &&
  !view.webContents.isDestroyed() &&
  !view.webContents.isCrashed() &&
  view.webContents.getURL() !== "";

// How often a shown window is checked, for a display that wakes without any event, and how recent
// the person's last input must be: with the display off, a hidden page is right.
const CHECK_EVERY_MS = 5000;
const ACTIVE_WITHIN_SECONDS = 10;

export const keepPainted = Effect.fn("Repaint.keepPainted")(function* (
  window: Electron.BaseWindow,
  views: () => ReadonlyArray<WatchedView>,
) {
  if ((yield* HostProcess.Platform) !== "win32") return;
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const port: RepaintPort<Electron.WebContentsView> = {
    windowShowing: () => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
    views,
    usable,
    visibilityOf: async (view) => {
      if (!usable(view)) return "none";
      try {
        return String(await view.webContents.executeJavaScript(SETTLED_VISIBILITY));
      } catch {
        return "unknown";
      }
    },
    reattach: (view) => {
      view.setVisible(false);
      view.setVisible(true);
      view.webContents.invalidate();
    },
    reload: (view) => view.webContents.reload(),
    log: (fields) => run(Effect.logWarning("view shown again", fields)),
  };
  let checking = false;
  const check = (reason: string) => () => {
    if (checking) return;
    checking = true;
    void checkViews(port, reason).finally(() => {
      checking = false;
    });
  };
  const resumed = check("resume");
  const unlocked = check("unlock-screen");
  window.on("show", check("show"));
  window.on("restore", check("restore"));
  window.on("focus", check("focus"));
  Electron.powerMonitor.on("resume", resumed);
  Electron.powerMonitor.on("unlock-screen", unlocked);
  // The display wakes without any event: while the person uses the computer, a shown window
  // whose page says hidden is wrong.
  const active = check("active");
  // @effect-diagnostics-next-line globalTimersInEffect:off - It lives as long as the window, past any scope.
  const timer = setInterval(() => {
    if (Electron.powerMonitor.getSystemIdleTime() <= ACTIVE_WITHIN_SECONDS) active();
  }, CHECK_EVERY_MS);
  window.once("closed", () => {
    clearInterval(timer);
    Electron.powerMonitor.off("resume", resumed);
    Electron.powerMonitor.off("unlock-screen", unlocked);
  });
});
