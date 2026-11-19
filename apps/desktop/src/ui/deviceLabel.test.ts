import { assert, describe, it } from "@effect/vitest";

import type { DeviceSwitchPhase, DeviceSwitchStatus } from "../shared/bridge.ts";
import { channelLabel, problemCode, problemLabel, switchLabel } from "./deviceLabel.ts";
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
      "The Environment refused the connection",
    );
  });

  it("says a channel that needs a new hand-over is reconnecting, with no code in the sentence", () => {
    assert.strictEqual(
      channelLabel({ state: "needs-hand-over", reason: "expired" }, messages.cs.device),
      "Připojuje se znovu…",
    );
    assert.strictEqual(
      channelLabel({ state: "needs-hand-over", reason: "session_ended" }, messages.en.device),
      "Reconnecting…",
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

const entry = (
  phase: DeviceSwitchPhase,
  channel: DeviceSwitchStatus["channel"] = { state: "off" },
): DeviceSwitchStatus => ({
  origin: "https://launchpad.bob.lazurio.io",
  host: "launchpad.bob.lazurio.io",
  switch: phase,
  channel,
});

describe("switchLabel", () => {
  it("says where a switch that is on is before and after the helper has its channel", () => {
    assert.deepStrictEqual(switchLabel(entry({ phase: "signing-in" }), messages.cs.device), {
      state: "Přihlaste se v prohlížeči.",
      problem: null,
    });
    assert.strictEqual(
      switchLabel(entry({ phase: "retrying", cause: "auth-unavailable" }), messages.en.device)
        .state,
      "Lazurio is not answering. Trying again.",
    );
    assert.strictEqual(
      switchLabel(entry({ phase: "channel" }, { state: "connected" }), messages.cs.device).state,
      "Připojeno",
    );
  });

  it("says a switch is turning off, or that nobody knows, and never Off before it is", () => {
    assert.strictEqual(
      switchLabel(entry({ phase: "stopping" }), messages.cs.device).state,
      "Vypíná se…",
    );
    assert.deepStrictEqual(switchLabel(entry({ phase: "unknown" }), messages.en.device), {
      state: "Agent's state unknown",
      problem: null,
    });
    const ended = switchLabel(
      entry({ phase: "off", problem: { from: "app", reason: "stop-not-confirmed" } }),
      messages.cs.device,
    );
    assert.strictEqual(ended.state, "Vypnuto");
    assert.match(ended.problem ?? "", /nepotvrdil vypnutí/u);
  });

  it("says what to do when the utility Lazurio Agent Desktop turned a switch off", () => {
    const off = entry({
      phase: "off",
      problem: { from: "helper", reason: "agent_desktop_paired", httpStatus: 0 },
    });
    const cs = switchLabel(off, messages.cs.device);
    assert.strictEqual(cs.state, "Vypnuto");
    assert.match(cs.problem ?? "", /odeberte všechna Prostředí a utilitu odinstalujte/u);
    assert.match(cs.problem ?? "", /io\.lazurio\.agent-desktop ve Správci pověření/u);
    const en = switchLabel(off, messages.en.device).problem ?? "";
    assert.match(en, /Remove every Environment in the utility and uninstall it/u);
    assert.match(en, /Keychain Access/u);
  });

  it("names every final answer of Lazurio Auth and of the helper in a sentence", () => {
    for (const text of [messages.cs.device, messages.en.device]) {
      for (const reason of [
        "sign-in-failed",
        "signed-out",
        "unknown-environment",
        "not-permitted",
        "environment-state-conflict",
        "rejected",
      ] as const) {
        assert.notInclude(problemLabel({ from: "auth", reason }, text), "{");
      }
      // A sentence for the person; the code goes beside it, for whoever helps.
      for (const problem of [
        { from: "helper", reason: "upgrade_refused", httpStatus: 400 },
        { from: "helper", reason: "hand_over_refused", httpStatus: 401 },
        { from: "helper", reason: "something_new", httpStatus: 0 },
      ] as const) {
        const sentence = problemLabel(problem, text);
        assert.notMatch(sentence, /[{_]|HTTP|\(/u);
      }
    }
    assert.strictEqual(
      problemCode({ from: "helper", reason: "upgrade_refused", httpStatus: 400 }),
      "upgrade_refused 400",
    );
    assert.strictEqual(
      problemCode({ from: "helper", reason: "something_new", httpStatus: 0 }),
      "something_new",
    );
    assert.isNull(problemCode({ from: "auth", reason: "signed-out" }));
  });

  it("never names Lazurio Auth or shows a bare code to the person", () => {
    for (const text of [messages.cs.device, messages.en.device]) {
      const shown = JSON.stringify(text);
      assert.notInclude(shown, "Lazurio Auth");
      assert.notMatch(shown, /\((\{reason\}|HTTP)/u);
    }
  });
});
