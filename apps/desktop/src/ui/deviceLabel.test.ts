import { assert, describe, it } from "@effect/vitest";

import { channelLabel } from "./deviceLabel.ts";
import { messages } from "./messages.ts";
import { APP_NAME } from "../shared/appName.ts";

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

  it("says in words that the utility Lazurio Agent Desktop keeps the channels closed", () => {
    assert.strictEqual(
      channelLabel({ state: "refused", reason: "agent_desktop_paired" }, messages.cs.device),
      "Na tomto počítači je spárovaná utilita Lazurio Agent Desktop.",
    );
    assert.strictEqual(
      channelLabel({ state: "refused", reason: "agent_desktop_paired" }, messages.en.device),
      "The utility Lazurio Agent Desktop is paired on this computer.",
    );
    assert.match(
      channelLabel({ state: "refused", reason: "agent_desktop_check_failed" }, messages.cs.device),
      /Nepodařilo se ověřit/u,
    );
    assert.match(
      channelLabel({ state: "refused", reason: "agent_desktop_check_failed" }, messages.en.device),
      /Could not check/u,
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
    assert.include(
      messages.cs.device.lost.toLowerCase(),
      `ukončete ${APP_NAME.toLowerCase()} a spusťte ji znovu`,
    );
    assert.match(messages.en.device.lost, /not known whether/iu);
    assert.include(
      messages.en.device.lost.toLowerCase(),
      `quit ${APP_NAME.toLowerCase()} and start it again`,
    );
    for (const text of [messages.cs.device.lost, messages.en.device.lost]) {
      assert.notMatch(text, /skončil|ended|neběží|not running/iu);
    }
  });
});
