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

// A view as the guard sees it: what it is for, and whether its main frame is inside a sign-in
// that Lazurio Auth started.
export interface ViewState {
  readonly kind: ViewKind;
  readonly signingIn: boolean;
}

export const newView = (kind: ViewKind): ViewState => ({ kind, signingIn: false });

const LAZURIO_DOMAIN = "lazurio.io";
// Lazurio Auth, which signs a person in to Environments, and the Dashboard. Nothing else on
// lazurio.ai is Lazurio's page for the app.
const LAZURIO_AUTH_HOST = "auth.lazurio.ai";
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

const isLazurioHost = (hostname: string): boolean => {
  const name = nameOf(hostname);
  return name === LAZURIO_DOMAIN || name.endsWith(`.${LAZURIO_DOMAIN}`) || LAZURIO_HOSTS.has(name);
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
  if (frame === "sub") return view;
  const signingIn = isLazurioAuth(address) || (view.signingIn && isGitHubSignIn(address));
  return signingIn === view.signingIn ? view : { ...view, signingIn };
};
