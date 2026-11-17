// Where an address opens (decision 0248: the app opens in itself only Lazurio's addresses and
// hands every other address to the system's browser; ADR 0002 for the sign-in). Pure, so every
// case is a unit test.

export const LOCAL_SCHEME = "lazurio-app";
export const LOCAL_HOST = "shell";
export const LOCAL_ORIGIN = `${LOCAL_SCHEME}://${LOCAL_HOST}`;

export type Destination =
  // A window of the app itself, served from the app's own files.
  | { readonly _tag: "Local" }
  // A page of the web Lazurio, shown in a remote view without any access to the app.
  | { readonly _tag: "Lazurio" }
  // Anything else on the web, which the system's browser opens.
  | { readonly _tag: "SystemBrowser" }
  // An address the app never opens anywhere (credentials, file:, javascript:, data:, unknown).
  | { readonly _tag: "Blocked" };

// What a view of the app shows, fixed when the app creates the view.
export type ViewKind = "Local" | "Lazurio";

export type Frame = "main" | "sub";

// A view as the guard sees it: what it is for, and whether a page or a navigation of its main
// frame is inside a sign-in that Lazurio Auth started.
export interface ViewState {
  readonly kind: ViewKind;
  readonly signingIn: boolean;
}

export const newView = (kind: ViewKind): ViewState => ({ kind, signingIn: false });

const LAZURIO_DOMAIN = "lazurio.io";
// An Organization's production applications (`<application>.<organization>.lazurio.app`,
// decision 0239), which a tab shows without a frame (decision 0248, addendum 2026-11-15).
const LAZURIO_APPS_DOMAIN = "lazurio.app";
// Lazurio Auth, which signs a person in to Environments, and the Dashboard. Nothing else on
// lazurio.ai is Lazurio's page for the app.
const LAZURIO_AUTH_HOST = "auth.lazurio.ai";
// The issuer of the app's own public client (docs/adr/0008, point 7), and of nothing else.
export const LAZURIO_AUTH_ISSUER = `https://${LAZURIO_AUTH_HOST}/realms/workspace`;
const LAZURIO_HOSTS: ReadonlySet<string> = new Set([LAZURIO_AUTH_HOST, "dashboard.lazurio.ai"]);
// Lazurio Auth signs in with GitHub. When GitHub does not know the person yet, they sign in on
// these pages of github.com: the sign-in form, its POST, two-factor, passkeys, device checks and
// the OAuth authorization.
const GITHUB_HOST = "github.com";
const isGitHubSignInPath = (path: string): boolean =>
  path === "/login" ||
  path.startsWith("/login/") ||
  path === "/session" ||
  path.startsWith("/sessions/");

// A name may end with the root's dot and is still the same name.
const nameOf = (hostname: string): string => hostname.replace(/\.+$/u, "");

// The domain itself or a name below it, never a look-alike such as `evil-lazurio.io`.
const isUnder = (name: string, domain: string): boolean =>
  name === domain || name.endsWith(`.${domain}`);

const isLazurioHost = (hostname: string): boolean => {
  const name = nameOf(hostname);
  return (
    isUnder(name, LAZURIO_DOMAIN) || isUnder(name, LAZURIO_APPS_DOMAIN) || LAZURIO_HOSTS.has(name)
  );
};

const httpsUrl = (address: string): URL | undefined => {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

// The origin `https://<host>` of a page of an Environment's Lazurio, for Agent Desktop's list: HTTPS
// on the default port, a `launchpad.` name below lazurio.io; never lazurio.app, Auth or
// the Dashboard. Only Lazurio Auth's hand-over says whether it is the person's Environment (404,
// 403).
export const environmentOriginOf = (address: string): string | undefined => {
  const url = httpsUrl(address);
  if (url === undefined || url.port !== "") return undefined;
  const name = nameOf(url.hostname);
  // An Environment's Lazurio is its `launchpad.` host; a module's app on another host of the same
  // Environment would only get Auth's 404.
  return name.startsWith("launchpad.") &&
    isUnder(name, LAZURIO_DOMAIN) &&
    /^[a-z0-9.-]+$/u.test(name)
    ? `https://${name}`
    : undefined;
};

// Every other service, Composio's connection of an Integration among them, opens in the system's
// browser: the person is signed in there, providers such as Google refuse embedded browsers, and
// the connection lives at the service, not in the app's session.
export const destinationOf = (address: string): Destination => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { _tag: "Blocked" };
  }
  if (url.protocol === `${LOCAL_SCHEME}:`) {
    return url.host === LOCAL_HOST ? { _tag: "Local" } : { _tag: "Blocked" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { _tag: "Blocked" };
  if (url.username !== "" || url.password !== "") return { _tag: "Blocked" };
  if (url.protocol === "https:" && isLazurioHost(url.hostname)) return { _tag: "Lazurio" };
  return { _tag: "SystemBrowser" };
};

const isLazurioAuth = (address: string): boolean => {
  const url = httpsUrl(address);
  return url !== undefined && url.port === "" && nameOf(url.hostname) === LAZURIO_AUTH_HOST;
};

const isGitHubSignIn = (address: string): boolean => {
  const url = httpsUrl(address);
  return (
    url !== undefined &&
    url.port === "" &&
    nameOf(url.hostname) === GITHUB_HOST &&
    isGitHubSignInPath(url.pathname)
  );
};

// An empty frame a page creates for itself; it shares the page's origin and loads nothing.
const isEmptyFrame = (address: string): boolean =>
  address === "about:blank" || address === "about:srcdoc";

// Whether a frame of a view may load the address: only what the view is for, in every frame. A
// subframe may also be an empty frame of its page. The main frame of a Lazurio view may also show
// GitHub's sign-in pages, but only inside a sign-in of Lazurio Auth. Everything else is refused,
// in the main frame and in every subframe alike.
export const mayLoad = (view: ViewState | undefined, address: string, frame: Frame): boolean => {
  if (view === undefined) return false;
  if (frame === "sub" && isEmptyFrame(address)) return true;
  if (destinationOf(address)._tag === view.kind) return true;
  return frame === "main" && view.kind === "Lazurio" && view.signingIn && isGitHubSignIn(address);
};

// The view after its main frame was allowed to go to the address. A sign-in starts on Lazurio
// Auth, continues on GitHub's sign-in pages and ends on any other page.
export const afterNavigation = (view: ViewState, address: string, frame: Frame): ViewState => {
  if (frame === "sub" || view.kind !== "Lazurio") return view;
  const signingIn = isLazurioAuth(address) || (view.signingIn && isGitHubSignIn(address));
  return signingIn === view.signingIn ? view : { ...view, signingIn };
};

const notSigningIn = (view: ViewState): ViewState =>
  view.signingIn ? { ...view, signingIn: false } : view;

// The page a view's main frame shows, and its navigation under way from start through redirects.
// A sign-in exists only where Lazurio Auth answered (ADR 0002). Electron reports nothing for a
// navigation that ends without a page, so its state lives only until the next Start; Chromium
// runs one cross-document navigation per frame at a time.
export interface Tracked {
  readonly shown: ViewState;
  readonly underWay: { readonly address: string; readonly view: ViewState } | undefined;
}

export const track = (kind: ViewKind): Tracked => ({ shown: newView(kind), underWay: undefined });

// What Electron reports of a view's navigations, in its own order: a navigation's Start comes
// before a page's request to navigate (Navigate), then every Redirect, then its page.
export type NavigationStep =
  // A frame's cross-document navigation starts, whoever started it (did-start-navigation).
  | { readonly _tag: "Start"; readonly address: string; readonly frame: Frame }
  // A page asks to navigate a frame (will-frame-navigate). The guard may refuse it.
  | { readonly _tag: "Navigate"; readonly address: string; readonly frame: Frame }
  // A server redirects a frame's navigation (will-redirect). The guard may refuse it.
  | { readonly _tag: "Redirect"; readonly address: string; readonly frame: Frame }
  // The main frame shows the page at the address (did-navigate).
  | { readonly _tag: "Show"; readonly address: string }
  // The main frame shows an error page for the address (did-fail-provisional-load).
  | { readonly _tag: "ShowError"; readonly address: string };

export interface StepOutcome {
  readonly allowed: boolean;
  readonly tracked: Tracked;
  // The main frame left a sign-in for another page; the view forgets the sign-in's pages.
  readonly signInEnded: boolean;
}

export const step = (tracked: Tracked, event: NavigationStep): StepOutcome => {
  const outcome = (allowed: boolean, next: Tracked, signInEnded = false): StepOutcome => ({
    allowed,
    tracked: next,
    signInEnded,
  });
  switch (event._tag) {
    case "Start":
      if (event.frame === "sub") return outcome(true, tracked);
      return outcome(true, {
        ...tracked,
        underWay: {
          address: event.address,
          view: afterNavigation(tracked.shown, event.address, "main"),
        },
      });
    case "Navigate": {
      // A page navigates from the page its view shows, never from a navigation under way.
      if (mayLoad(tracked.shown, event.address, event.frame)) return outcome(true, tracked);
      // Its Start came just before; a refused navigation never runs.
      const refusedStart = event.frame === "main" && tracked.underWay?.address === event.address;
      return outcome(false, refusedStart ? { ...tracked, underWay: undefined } : tracked);
    }
    case "Redirect": {
      if (event.frame === "sub")
        return outcome(mayLoad(tracked.shown, event.address, "sub"), tracked);
      // A redirect continues the navigation under way. Without one, no sign-in carries over.
      const from = tracked.underWay?.view ?? notSigningIn(tracked.shown);
      if (!mayLoad(from, event.address, "main")) {
        return outcome(false, { ...tracked, underWay: undefined });
      }
      return outcome(true, {
        ...tracked,
        underWay: { address: event.address, view: afterNavigation(from, event.address, "main") },
      });
    }
    case "Show": {
      // The page is the navigation's only if the navigation under way ended at its address.
      const view =
        tracked.underWay?.address === event.address
          ? tracked.underWay.view
          : afterNavigation(notSigningIn(tracked.shown), event.address, "main");
      return outcome(
        true,
        { shown: view, underWay: undefined },
        tracked.shown.signingIn && !view.signingIn,
      );
    }
    case "ShowError":
      return outcome(
        true,
        {
          shown: notSigningIn(tracked.shown),
          underWay: tracked.underWay?.address === event.address ? undefined : tracked.underWay,
        },
        tracked.shown.signingIn,
      );
  }
};
