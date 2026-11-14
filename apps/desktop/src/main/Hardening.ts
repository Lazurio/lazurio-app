import * as Effect from "effect/Effect";

import * as Electron from "electron";

import { destinationOf, mayNavigate } from "./Navigation.ts";

// Pages hold no power (decision 0248). Every permission is refused unless a later decision names
// it, no page opens a window, a view never leaves its kind of content, and an address outside
// Lazurio goes to the system's browser.

export interface SystemBrowser {
  readonly open: (url: string) => void;
}

export const electronSystemBrowser: SystemBrowser = {
  open: (url) => {
    void Electron.shell.openExternal(url);
  },
};

export const hardenSession = (session: Electron.Session): Effect.Effect<void> =>
  Effect.sync(() => {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  });

const guard = (systemBrowser: SystemBrowser) => (contents: Electron.WebContents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (destinationOf(url)._tag === "SystemBrowser") systemBrowser.open(url);
    return { action: "deny" };
  });
  const onNavigation = (event: Electron.Event, url: string) => {
    const to = destinationOf(url);
    if (mayNavigate(destinationOf(contents.getURL()), to)) return;
    event.preventDefault();
    if (to._tag === "SystemBrowser") systemBrowser.open(url);
  };
  contents.on("will-navigate", (event) => onNavigation(event, event.url));
  contents.on("will-redirect", (event) => onNavigation(event, event.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
};

// Guards every web contents the app creates, for as long as the scope lives.
export const guardAllWebContents = (systemBrowser: SystemBrowser) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (_event: Electron.Event, contents: Electron.WebContents) =>
        guard(systemBrowser)(contents);
      Electron.app.on("web-contents-created", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => Electron.app.off("web-contents-created", listener)),
  );
