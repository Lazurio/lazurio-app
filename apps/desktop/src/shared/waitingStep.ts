import type { TailnetStatus } from "./bridge.ts";

// What the window's page waits for, from the tailnets' state, so the waiting page says the step the
// person is at (Waiting.tsx): a network key the system did not open, a sign-in to the network in
// the browser, the network connecting, or, once it runs and the Environment still cannot be
// reached, the approval of this computer by the Organization's Admin.
export type WaitingStep = "key" | "sign-in" | "connecting" | "approval";

const KEY_REASONS = new Set([
  "no-keystore",
  "key-inaccessible",
  "key-not-saved",
  "key-unreadable",
  "state-unreadable",
]);

export const waitingStep = (tailnets: ReadonlyArray<TailnetStatus>): WaitingStep | undefined => {
  if (
    tailnets.some(
      (tailnet) =>
        tailnet.state === "stopped" &&
        tailnet.reason !== undefined &&
        KEY_REASONS.has(tailnet.reason),
    )
  ) {
    return "key";
  }
  if (tailnets.some((tailnet) => tailnet.state === "needs-login")) return "sign-in";
  if (tailnets.some((tailnet) => tailnet.state === "starting")) return "connecting";
  if (tailnets.some((tailnet) => tailnet.state === "running")) return "approval";
  return undefined;
};
