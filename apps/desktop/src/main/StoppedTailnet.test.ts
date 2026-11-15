import { assert, describe, it } from "@effect/vitest";

import { NodeKeyError } from "./NodeKeys.ts";
import { stoppedForFailure, stoppedForKey } from "./StoppedTailnet.ts";

describe("a stopped tailnet's reason", () => {
  const recovery = {
    keyFile: "/data/tailnets/example.key",
    stateDirectory: "/data/tailnets/example",
  };

  it("names no keystore, and an unreadable key with the files that start the node afresh", () => {
    assert.deepStrictEqual(
      stoppedForKey("example", new NodeKeyError({ reason: "no-keystore", problem: "p" }), recovery),
      { tailnet: "example", state: "stopped", problem: "p", reason: "no-keystore" },
    );
    assert.deepStrictEqual(
      stoppedForKey(
        "example",
        new NodeKeyError({ reason: "key-unreadable", problem: "q" }),
        recovery,
      ),
      { tailnet: "example", state: "stopped", problem: "q", reason: "key-unreadable", recovery },
    );
    assert.deepStrictEqual(
      stoppedForKey(
        "example",
        new NodeKeyError({ reason: "key-not-saved", problem: "r" }),
        recovery,
      ),
      { tailnet: "example", state: "stopped", problem: "r" },
    );
  });

  it("names a sealed state that its key does not open, from the helper's code", () => {
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "state_unreadable", message: "m" }, recovery),
      { tailnet: "example", state: "stopped", problem: "m", reason: "state-unreadable", recovery },
    );
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "start_node_failed", message: "n" }, recovery),
      { tailnet: "example", state: "stopped", problem: "n" },
    );
  });
});
