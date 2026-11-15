import { assert, describe, it } from "@effect/vitest";

import { NodeKeyError } from "./NodeKeys.ts";
import { stoppedForFailure, stoppedForKey } from "./StoppedTailnet.ts";

describe("a stopped tailnet's reason", () => {
  const files = { keyFile: "/data/tailnets/example.key", stateDirectory: "/data/tailnets/example" };
  const keyError = (reason: NodeKeyError["reason"]) =>
    stoppedForKey("example", new NodeKeyError({ reason, problem: "p" }), files);

  it("names each reason a node key gives, with the node's files where the advice needs them", () => {
    assert.deepStrictEqual(keyError("no-keystore"), {
      tailnet: "example",
      state: "stopped",
      problem: "p",
      reason: "no-keystore",
    });
    for (const reason of ["key-inaccessible", "key-not-saved", "key-unreadable"] as const) {
      assert.deepStrictEqual(keyError(reason), {
        tailnet: "example",
        state: "stopped",
        problem: "p",
        reason,
        files,
      });
    }
  });

  it("names a sealed state that its key does not open, from the helper's code", () => {
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "state_unreadable", message: "m" }, files),
      { tailnet: "example", state: "stopped", problem: "m", reason: "state-unreadable", files },
    );
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "start_node_failed", message: "n" }, files),
      { tailnet: "example", state: "stopped", problem: "n" },
    );
  });
});
