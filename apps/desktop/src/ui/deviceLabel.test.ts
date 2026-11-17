import { assert, describe, it } from "@effect/vitest";

import { channelLabel } from "./deviceLabel.ts";
import { messages } from "./messages.ts";

describe("channelLabel", () => {
  it("names each state of a channel, in either language", () => {
    assert.strictEqual(channelLabel({ state: "off" }, messages.cs.device), "Vypnuto");
    assert.strictEqual(
      channelLabel({ state: "connecting", failedAttempts: 2 }, messages.en.device),
      "Connecting",
    );
    assert.strictEqual(channelLabel({ state: "connected" }, messages.cs.device), "Připojeno");
    assert.strictEqual(
      channelLabel({ state: "refused", reason: "not-paired" }, messages.en.device),
      "Refused (not-paired)",
    );
  });

  it("names the tool an agent runs and the application, when the engine names one", () => {
    assert.strictEqual(
      channelLabel({ state: "working", tool: "click", application: "Outlook" }, messages.cs.device),
      "Pracuje agent: click v Outlook",
    );
    assert.strictEqual(
      channelLabel({ state: "working", tool: "screenshot", application: "" }, messages.en.device),
      "An agent is working: screenshot",
    );
  });
});
