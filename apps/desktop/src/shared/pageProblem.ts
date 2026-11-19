// Why the window's page did not show, as the address of the app's page in its place says it
// (MainWindow.ts writes it, src/ui/Waiting.tsx reads it). The host is the page's or the refused
// address's, shown to the person; it never goes into Copy status.
export type PageProblem =
  // A tailnet's page its node cannot reach yet: the app loads it again by itself.
  | { readonly kind: "waiting"; readonly code: number; readonly host: string }
  | { readonly kind: "failed"; readonly code: number; readonly host: string }
  // The tailnet helper's proxy refused the page's tunnel (HTTP 407).
  | { readonly kind: "proxy"; readonly host: string }
  // The app does not open the address, or opened it in the system's browser instead.
  | { readonly kind: "refused"; readonly host: string }
  | { readonly kind: "browser"; readonly host: string }
  | { readonly kind: "crashed" };

export const problemQuery = (problem: PageProblem): string => {
  const query = new URLSearchParams({ problem: problem.kind });
  if (problem.kind !== "crashed") query.set("host", problem.host);
  if (problem.kind === "failed" || problem.kind === "waiting") {
    query.set("code", String(problem.code));
  }
  return `?${query.toString()}`;
};

export const problemOf = (search: string): PageProblem | undefined => {
  const query = new URLSearchParams(search);
  const host = query.get("host") ?? "";
  const kind = query.get("problem");
  switch (kind) {
    case "waiting":
    case "failed": {
      const code = Number(query.get("code"));
      return Number.isInteger(code) ? { kind, code, host } : undefined;
    }
    case "proxy":
    case "refused":
    case "browser":
      return { kind, host };
    case "crashed":
      return { kind };
    default:
      return undefined;
  }
};

export type FailureReason =
  | "certificate"
  | "connection"
  | "redirects"
  | "not-found"
  | "timeout"
  | "other";

// Chromium's network errors that break the connection to the page or its tunnel: CONNECTION_CLOSED,
// RESET, REFUSED, ABORTED, FAILED, NETWORK_CHANGED, ADDRESS_UNREACHABLE, TUNNEL_CONNECTION_FAILED,
// PROXY_CONNECTION_FAILED, EMPTY_RESPONSE.
const CONNECTION: ReadonlySet<number> = new Set([
  -100, -101, -102, -103, -104, -21, -109, -111, -130, -324,
]);

// The reason in words for a failed load, by Chromium's network error.
export const reasonOf = (code: number): FailureReason => {
  if (code <= -200 && code > -300) return "certificate";
  if (code === -310) return "redirects";
  if (code === -105 || code === -137) return "not-found";
  if (code === -7 || code === -118) return "timeout";
  return CONNECTION.has(code) ? "connection" : "other";
};
