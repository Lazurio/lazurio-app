// Where an address opens (decision 0248: the app opens in itself only Lazurio's addresses and
// hands every other address to the system's browser). Pure, so every case is a unit test.

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

const LAZURIO_DOMAIN = "lazurio.io";

// A name may end with the root's dot and is still the same name.
const isLazurioHost = (hostname: string): boolean => {
  const name = hostname.replace(/\.+$/u, "");
  return name === LAZURIO_DOMAIN || name.endsWith(`.${LAZURIO_DOMAIN}`);
};

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

// An empty frame a page creates for itself; it shares the page's origin and loads nothing.
const isEmptyFrame = (address: string): boolean =>
  address === "about:blank" || address === "about:srcdoc";

// Whether a frame of a view may load the address: only what the view is for, in every frame. A
// subframe may also be an empty frame of its page. Everything else is refused, in the main frame
// and in every subframe alike.
export const mayLoad = (view: ViewKind | undefined, address: string, frame: Frame): boolean => {
  if (view === undefined) return false;
  if (frame === "sub" && isEmptyFrame(address)) return true;
  return destinationOf(address)._tag === view;
};
