import * as Effect from "effect/Effect";

import * as Electron from "electron";

import { destinationOf, mayLoad, type Frame, type ViewKind } from "./Navigation.ts";

// Pages hold no power (decision 0248). Every permission is refused unless a later decision names
// it, no page opens a window, every frame of a view stays on what the view is for, and an address
// outside Lazurio goes to the system's browser.

export interface NavigationObserver {
  // Opens an address outside Lazurio in the system's browser.
  readonly openExternally: (url: string) => void;
  // Learns that a frame was refused an address; only end-to-end tests listen.
  readonly refused: (url: string, frame: Frame) => void;
}

export const electronObserver: NavigationObserver = {
  openExternally: (url) => {
    void Electron.shell.openExternal(url);
  },
  refused: () => {},
};

// What each view the app created is for. A web contents the app did not register loads nothing.
const viewKinds = new WeakMap<Electron.WebContents, ViewKind>();

export const registerView = (contents: Electron.WebContents, kind: ViewKind): void => {
  viewKinds.set(contents, kind);
};

// The app's own windows that are still open, the only ones that get the bridge's messages.
export const localViews = (): ReadonlyArray<Electron.WebContents> =>
  Electron.webContents
    .getAllWebContents()
    .filter((contents) => !contents.isDestroyed() && viewKinds.get(contents) === "Local");

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
  const check = (event: Electron.Event, url: string, isMainFrame: boolean) => {
    const frame: Frame = isMainFrame ? "main" : "sub";
    if (mayLoad(viewKinds.get(contents), url, frame)) return;
    event.preventDefault();
    observer.refused(url, frame);
    if (frame === "main" && destinationOf(url)._tag === "SystemBrowser") {
      observer.openExternally(url);
    }
  };
  // will-frame-navigate covers the main frame and every subframe, including a frame's first load;
  // will-redirect covers server redirects in any frame.
  contents.on("will-frame-navigate", (event) => check(event, event.url, event.isMainFrame));
  contents.on("will-redirect", (event) => check(event, event.url, event.isMainFrame));
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
