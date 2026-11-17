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

  it("says why a channel ended and waits for a new hand-over", () => {
    assert.strictEqual(
      channelLabel({ state: "needs-hand-over", reason: "expired" }, messages.cs.device),
      "Odpojeno (expired)",
    );
    assert.strictEqual(
      channelLabel({ state: "needs-hand-over", reason: "session_ended" }, messages.en.device),
      "Disconnected (session_ended)",
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

  it("claims nothing about a channel once the connection to the helper was lost", () => {
    assert.strictEqual(
      channelLabel({ state: "unknown" }, messages.cs.device),
      "Stav agenta neznámý",
    );
    assert.strictEqual(
      channelLabel({ state: "unknown" }, messages.en.device),
      "Agent's state unknown",
    );
  });

  it("says after a lost connection that nobody knows whether an agent works, and what to do", () => {
    assert.match(messages.cs.device.lost, /nevíme, jestli/iu);
    assert.match(messages.cs.device.lost, /ukončete Lazurio App a spusťte ji znovu/iu);
    assert.match(messages.en.device.lost, /not known whether/iu);
    assert.match(messages.en.device.lost, /quit Lazurio App and start it again/iu);
    for (const text of [messages.cs.device.lost, messages.en.device.lost]) {
      assert.notMatch(text, /skončil|ended|neběží|not running/iu);
    }
  });
});
