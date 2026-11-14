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
  // An address the app never opens anywhere (file:, javascript:, data:, unknown schemes).
  | { readonly _tag: "Blocked" };

const LAZURIO_DOMAIN = "lazurio.io";

const isLazurioHost = (hostname: string): boolean =>
  hostname === LAZURIO_DOMAIN || hostname.endsWith(`.${LAZURIO_DOMAIN}`);

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
  if (url.protocol === "https:") {
    if (url.username !== "" || url.password !== "") return { _tag: "Blocked" };
    return isLazurioHost(url.hostname) ? { _tag: "Lazurio" } : { _tag: "SystemBrowser" };
  }
  if (url.protocol === "http:") return { _tag: "SystemBrowser" };
  return { _tag: "Blocked" };
};

// A view may stay on its own kind of content: a local window only on the app's files, a remote
// view only on Lazurio's pages. Leaving either one is never a navigation inside the app.
export const mayNavigate = (from: Destination, to: Destination): boolean =>
  from._tag === to._tag && (to._tag === "Local" || to._tag === "Lazurio");
