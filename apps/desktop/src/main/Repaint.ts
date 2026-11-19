import * as Effect from "effect/Effect";

import * as Electron from "electron";

// A window that shows while its pages count themselves hidden stays blank: after a start with the
// display off, after the display woke, and, the trial of 2026-11-19 suggests, after a start with
// --hidden (#36). Whenever a window can be seen again, each of its views that shows yet says it
// is hidden is attached again, and loaded again if that does not help; each such case is logged.

export interface WatchedView {
  // For the log only: column, page, waiting, bar, agent-desktop.
  readonly name: string;
  readonly view: Electron.WebContentsView;
}

// The page's visibility once it settled: a page that just became visible again says so within a
// moment; one that stays hidden answers after the wait.
const SETTLED_VISIBILITY = `new Promise((resolve) => {
  if (document.visibilityState === "visible") return resolve("visible");
  const done = () => resolve(document.visibilityState);
  const timer = setTimeout(done, 1000);
  document.addEventListener("visibilitychange", () => { clearTimeout(timer); done(); }, { once: true });
})`;

const visibilityOf = async (contents: Electron.WebContents): Promise<string> => {
  if (contents.isDestroyed() || contents.getURL() === "" || contents.isCrashed()) return "none";
  try {
    return String(await contents.executeJavaScript(SETTLED_VISIBILITY));
  } catch {
    return "unknown";
  }
};

// How often a shown window is checked, for a display that wakes without any event, and how recent
// the person's last input must be: with the display off, a hidden page is right.
const CHECK_EVERY_MS = 5000;
const ACTIVE_WITHIN_SECONDS = 10;

export const keepPainted = Effect.fn("Repaint.keepPainted")(function* (
  window: Electron.BaseWindow,
  views: () => ReadonlyArray<WatchedView>,
) {
  const run = Effect.runForkWith(yield* Effect.context<never>());
  let checking = false;
  const check = async (reason: string) => {
    if (checking || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
    checking = true;
    try {
      for (const { name, view } of views()) {
        if (!view.getVisible() || view.webContents.isDestroyed()) continue;
        const before = await visibilityOf(view.webContents);
        if (before !== "hidden") continue;
        view.setVisible(false);
        view.setVisible(true);
        view.webContents.invalidate();
        let after = await visibilityOf(view.webContents);
        if (after === "hidden") {
          view.webContents.reload();
          after = "reloaded";
        }
        run(Effect.logWarning("view shown again", { view: name, reason, before, after }));
      }
    } finally {
      checking = false;
    }
  };
  const on = (reason: string) => () => void check(reason);
  const resumed = on("resume");
  const unlocked = on("unlock-screen");
  window.on("show", on("show"));
  window.on("restore", on("restore"));
  window.on("focus", on("focus"));
  Electron.powerMonitor.on("resume", resumed);
  Electron.powerMonitor.on("unlock-screen", unlocked);
  // The display wakes without any event: while the person uses the computer, a visible window
  // whose page says hidden is wrong.
  // @effect-diagnostics-next-line globalTimersInEffect:off - It lives as long as the window, past any scope.
  const timer = setInterval(() => {
    if (Electron.powerMonitor.getSystemIdleTime() <= ACTIVE_WITHIN_SECONDS) void check("active");
  }, CHECK_EVERY_MS);
  window.once("closed", () => {
    clearInterval(timer);
    Electron.powerMonitor.off("resume", resumed);
    Electron.powerMonitor.off("unlock-screen", unlocked);
  });
});
