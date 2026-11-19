import * as Effect from "effect/Effect";

import * as Electron from "electron";

import { APP_NAME } from "../shared/appName.ts";
import { localeOf, messages } from "../ui/messages.ts";

import {
  destinationOf,
  step,
  track,
  type Frame,
  type NavigationStep,
  type Tracked,
  type ViewKind,
} from "./Navigation.ts";

// Pages hold no power (decision 0248). Every permission is refused unless a later decision names
// it, no page opens a window, every frame of a view stays on what the view is for (with GitHub's
// sign-in of ADR 0002), and an address outside Lazurio goes to the system's browser.

export interface NavigationObserver {
  // Opens an address outside Lazurio in the system's browser.
  readonly openExternally: (url: string) => void;
  // Learns that a frame was refused an address; only end-to-end tests listen.
  readonly refused: (url: string, frame: Frame) => void;
}

// The system could not open the address (on Windows, for example, an account with no application
// for links): the person gets the address to copy instead of nothing happening.
export const browserFailed = (url: string) => {
  const text = messages[localeOf(Electron.app.getLocale())].browser;
  void Electron.dialog
    .showMessageBox({
      type: "warning",
      title: APP_NAME,
      message: text.failed,
      detail: url,
      buttons: [text.copy, text.close],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) Electron.clipboard.writeText(url);
    });
};

export const electronObserver: NavigationObserver = {
  openExternally: (url) => {
    Electron.shell.openExternal(url).catch(() => browserFailed(url));
  },
  refused: () => {},
};

// What each view the app created is for, the page it shows and its navigation under way
// (Navigation.step). A web contents the app did not register loads nothing.
const views = new WeakMap<Electron.WebContents, Tracked>();

// Who learns that a view's main frame was refused an address (MainWindow): a refused redirect
// ends the load with ERR_ABORTED, which alone does not say why.
export interface MainFrameRefusal {
  readonly address: string;
  readonly step: "Navigate" | "Redirect";
}
const refusalListeners = new WeakMap<Electron.WebContents, (refusal: MainFrameRefusal) => void>();

export const onMainFrameRefused = (
  contents: Electron.WebContents,
  listener: (refusal: MainFrameRefusal) => void,
): void => {
  refusalListeners.set(contents, listener);
};

// An address's host for a log line, never its path, query or fragment.
export const hostOf = (address: string): string => URL.parse(address)?.hostname ?? "";

export const registerView = (contents: Electron.WebContents, kind: ViewKind): void => {
  views.set(contents, track(kind));
};

// The app's own windows that are still open, the only ones that get the bridge's messages.
export const localViews = (): ReadonlyArray<Electron.WebContents> =>
  Electron.webContents
    .getAllWebContents()
    .filter((contents) => !contents.isDestroyed() && views.get(contents)?.shown.kind === "Local");

export const hardenSession = (session: Electron.Session): Effect.Effect<void> =>
  Effect.sync(() => {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  });

const guard = (observer: NavigationObserver) => (contents: Electron.WebContents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (destinationOf(url)._tag === "SystemBrowser") observer.openExternally(url);
    return { action: "deny" };
  });
  const frameOf = (isMainFrame: boolean): Frame => (isMainFrame ? "main" : "sub");
  // Moves the view's state on by one of Electron's reports and says whether it may proceed.
  const advance = (event: NavigationStep): boolean => {
    const tracked = views.get(contents);
    if (tracked === undefined) return false;
    const outcome = step(tracked, event);
    views.set(contents, outcome.tracked);
    // No page of a finished sign-in stays in the view's history, for a page's history.back().
    if (outcome.signInEnded) contents.navigationHistory.clear();
    return outcome.allowed;
  };
  const check = (
    event: Electron.Event,
    request: Extract<NavigationStep, { readonly _tag: "Navigate" | "Redirect" }>,
  ) => {
    if (advance(request)) return;
    event.preventDefault();
    observer.refused(request.address, request.frame);
    if (request.frame === "main") {
      refusalListeners.get(contents)?.({ address: request.address, step: request._tag });
    }
    Effect.runFork(
      Effect.logWarning("navigation refused", {
        host: hostOf(request.address),
        frame: request.frame,
        step: request._tag,
      }),
    );
    if (request.frame === "main" && destinationOf(request.address)._tag === "SystemBrowser") {
      observer.openExternally(request.address);
    }
  };
  // Electron reports a navigation's start before a page's request for it (will-frame-navigate),
  // which covers the main frame and every subframe; will-redirect covers server redirects in any
  // frame. A navigation that ends without a page is never reported (Navigation.Tracked).
  contents.on("did-start-navigation", (event) => {
    if (event.isSameDocument) return;
    advance({ _tag: "Start", address: event.url, frame: frameOf(event.isMainFrame) });
  });
  contents.on("will-frame-navigate", (event) =>
    check(event, { _tag: "Navigate", address: event.url, frame: frameOf(event.isMainFrame) }),
  );
  contents.on("will-redirect", (event) =>
    check(event, { _tag: "Redirect", address: event.url, frame: frameOf(event.isMainFrame) }),
  );
  contents.on("did-navigate", (_event, url) => {
    advance({ _tag: "Show", address: url });
  });
  contents.on("did-fail-provisional-load", (_event, _code, _description, url, isMainFrame) => {
    if (isMainFrame) advance({ _tag: "ShowError", address: url });
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
};

// Guards every web contents the app creates, for as long as the scope lives.
export const guardAllWebContents = (observer: NavigationObserver) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (_event: Electron.Event, contents: Electron.WebContents) =>
        guard(observer)(contents);
      Electron.app.on("web-contents-created", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => Electron.app.off("web-contents-created", listener)),
  );
