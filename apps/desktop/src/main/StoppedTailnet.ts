import type { TailnetStatus } from "../shared/bridge.ts";
import type { NodeKeyError } from "./NodeKeys.ts";

// What the local window learns of a tailnet whose node did not start, and why (ADR 0003), with the
// node's key file and state directory, which the window's advice names.

export interface NodeFiles {
  readonly keyFile: string;
  readonly stateDirectory: string;
}

// A tailnet whose node key the keystore did not give.
export const stoppedForKey = (
  tailnet: string,
  error: NodeKeyError,
  files: NodeFiles,
): TailnetStatus => {
  const stopped = { tailnet, state: "stopped", problem: error.problem } as const;
  switch (error.reason) {
    case "no-keystore":
      return { ...stopped, reason: "no-keystore" };
    case "key-inaccessible":
      return { ...stopped, reason: "key-inaccessible", files };
    case "key-not-saved":
      return { ...stopped, reason: "key-not-saved", files };
    case "key-unreadable":
      return { ...stopped, reason: "key-unreadable", files };
  }
};

// The helper's code for a node whose sealed state does not open with its key (statestore.go).
const FAILURE_STATE_UNREADABLE = "state_unreadable";

// A tailnet whose node the helper did not start.
export const stoppedForFailure = (
  tailnet: string,
  failure: { readonly code: string; readonly message: string },
  files: NodeFiles,
): TailnetStatus =>
  failure.code === FAILURE_STATE_UNREADABLE
    ? { tailnet, state: "stopped", problem: failure.message, reason: "state-unreadable", files }
    : { tailnet, state: "stopped", problem: failure.message };
