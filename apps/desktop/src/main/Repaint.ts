import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as Electron from "electron";

// A shown window whose pages say hidden stays blank (#36: the display was off). On Windows, for the
// window in front only, its views are attached again, at most every RETRY_AFTER_MS, which keeps
// their state; nothing loads again (review of #77). A person reloads with View > Reload page.

export interface WatchedView {
  // For the log only: column, page, waiting, bar, agent-desktop.
  readonly name: string;
  readonly view: Electron.WebContentsView;
}

// What the check needs from Electron, so that its decisions are unit-tested (Repaint.test.ts).
export interface RepaintPort<View> {
  // Whether the window is in front: shown, not minimized and focused.
  readonly windowInFront: () => boolean;
  // The views the window means to show now, read again after every wait.
  readonly views: () => ReadonlyArray<{ readonly name: string; readonly view: View }>;
  readonly usable: (view: View) => boolean;
  readonly visibilityOf: (view: View) => Promise<string>;
  readonly reattach: (view: View) => void;
  // When each view was last attached again, in milliseconds of `now`: a view that stays hidden
  // (covered, or the display still off) is tried again only after RETRY_AFTER_MS, so the display
  // waking later still gets its attempt (review of #77).
  readonly attached: Map<View, number>;
  readonly now: () => number;
  readonly log: (fields: Readonly<Record<string, string>>) => void;
}

// Whether the view is still one the window means to show, in a window in front.
const stillShown = <View>(port: RepaintPort<View>, name: string, view: View): boolean =>
  port.windowInFront() &&
  port.usable(view) &&
  port.views().some((entry) => entry.name === name && entry.view === view);

// Long enough that a covered window is not touched every five seconds, short enough that a page
// is shown again soon after the display wakes.
export const RETRY_AFTER_MS = 15_000;

export const checkViews = async <View>(port: RepaintPort<View>, reason: string): Promise<void> => {
  for (const { name, view } of port.views()) {
    if (!stillShown(port, name, view)) continue;
    const before = await port.visibilityOf(view);
    if (before === "visible") port.attached.delete(view);
    const last = port.attached.get(view);
    const recent = last !== undefined && port.now() - last < RETRY_AFTER_MS;
    if (before !== "hidden" || recent || !stillShown(port, name, view)) continue;
    port.attached.set(view, port.now());
    port.reattach(view);
    const after = await port.visibilityOf(view);
    if (after === "visible") port.attached.delete(view);
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
  const clock = yield* Clock.Clock;
  const port: RepaintPort<Electron.WebContentsView> = {
    windowInFront: () =>
      !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused(),
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
    attached: new Map(),
    now: () => clock.currentTimeMillisUnsafe(),
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
  // The display wakes without any event: while the person uses the computer, the window in front
  // is wrong to have a hidden page.
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
