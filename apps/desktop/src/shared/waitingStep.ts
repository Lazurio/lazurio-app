import type { TailnetStatus } from "./bridge.ts";

// What the window's page waits for, from the state of the tailnet that serves it, so the waiting
// page says the step the person is at (Waiting.tsx): a key the system did not open, another key or
// state problem, a sign-in in the browser, the network connecting, or a network that runs while
// the Environment still does not answer (not approved yet, or the Environment is not running).
export type WaitingStep = "key-unopened" | "key" | "sign-in" | "connecting" | "unreachable";

const KEY_REASONS = new Set([
  "no-keystore",
  "key-inaccessible",
  "key-not-saved",
  "state-unreadable",
]);

// The step for the page's own tailnet; none without its status, or for a stop the person cannot act on.
export const waitingStep = (tailnet: TailnetStatus | undefined): WaitingStep | undefined => {
  switch (tailnet?.state) {
    case "stopped":
      if (tailnet.reason === "key-unreadable") return "key-unopened";
      return tailnet.reason !== undefined && KEY_REASONS.has(tailnet.reason) ? "key" : undefined;
    case "needs-login":
      return "sign-in";
    case "starting":
      return "connecting";
    case "running":
      return "unreachable";
    default:
      return undefined;
  }
};

// The step for the page served by `served`, from every tailnet's state: another Organization's
// network that waits for a sign-in or has a key problem never stands in for the page's own.
export const waitingStepFor = (
  tailnets: ReadonlyArray<TailnetStatus>,
  served: string | undefined,
): WaitingStep | undefined =>
  served === undefined
    ? undefined
    : waitingStep(tailnets.find((tailnet) => tailnet.tailnet === served));
