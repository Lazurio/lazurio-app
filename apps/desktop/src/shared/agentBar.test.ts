import { assert, describe, it } from "@effect/vitest";

import type { DeviceStatus } from "./bridge.ts";
import { AGENT_BAR_HEIGHT, agentBarHeight, workingAgent } from "./agentBar.ts";

const status = (agent: DeviceStatus["agent"], state: DeviceStatus["state"] = "ready") =>
  ({
    state,
    environments: [],
    agent,
    account: "signed-out",
    switches: [],
    addable: null,
  }) satisfies DeviceStatus;

describe("the agent's bar", () => {
  it("shows only while an agent holds the computer", () => {
    const working = status({ environmentId: "https://launchpad.bob.lazurio.io", label: "Bob" });
    assert.deepStrictEqual(workingAgent(working), {
      environmentId: "https://launchpad.bob.lazurio.io",
      label: "Bob",
    });
    assert.strictEqual(agentBarHeight(working), AGENT_BAR_HEIGHT);
    assert.isNull(workingAgent(status(null)));
    assert.strictEqual(agentBarHeight(status(null)), 0);
  });

  it("hides when nobody knows whether an agent works, or Agent Desktop is absent", () => {
    // The lost helper's warning lives in the Agent Desktop window; the bar offers only Stop, which
    // cannot reach a lost helper.
    assert.strictEqual(agentBarHeight(status("unknown", "lost")), 0);
    assert.strictEqual(agentBarHeight(null), 0);
  });
});
