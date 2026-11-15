import type { TailnetStatus } from "../shared/bridge.ts";
import type { NodeKeyError } from "./NodeKeys.ts";

// What the local window learns of a tailnet whose node did not start, and why (ADR 0003): no
// keystore, a key the keystore does not open, or a sealed state the key does not open, with the
// files that start the node afresh once deleted.

export interface Recovery {
  readonly keyFile: string;
  readonly stateDirectory: string;
}

// A tailnet whose node key the keystore did not give: no keystore, or a key it does not open.
export const stoppedForKey = (
  tailnet: string,
  error: NodeKeyError,
  recovery: Recovery,
): TailnetStatus => {
  switch (error.reason) {
    case "no-keystore":
      return { tailnet, state: "stopped", problem: error.problem, reason: "no-keystore" };
    case "key-unreadable":
      return {
        tailnet,
        state: "stopped",
        problem: error.problem,
        reason: "key-unreadable",
        recovery,
      };
    case "key-not-saved":
      return { tailnet, state: "stopped", problem: error.problem };
  }
};

// The helper's code for a node whose sealed state does not open with its key (statestore.go).
const FAILURE_STATE_UNREADABLE = "state_unreadable";

// A tailnet whose node the helper did not start.
export const stoppedForFailure = (
  tailnet: string,
  failure: { readonly code: string; readonly message: string },
  recovery: Recovery,
): TailnetStatus =>
  failure.code === FAILURE_STATE_UNREADABLE
    ? { tailnet, state: "stopped", problem: failure.message, reason: "state-unreadable", recovery }
    : { tailnet, state: "stopped", problem: failure.message };
