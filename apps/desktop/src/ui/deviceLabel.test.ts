import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type {
  DeviceChannelState,
  DeviceSwitchPhase,
  DeviceSwitchProblem,
  DeviceSwitchStatus,
} from "../shared/bridge.ts";
import { problemCode, problemKey, problemRetries, problemTime, rowState } from "./deviceLabel.ts";
import { messages } from "./messages.ts";

const entry = (
  phase: DeviceSwitchPhase,
  channel: DeviceChannelState = { state: "off" },
): DeviceSwitchStatus => ({
  origin: "https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io",
  host: "launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io",
  switch: phase,
  channel,
});

describe("rowState", () => {
  it("gives each switch one short state", () => {
    const states = [
      [entry({ phase: "off", problem: null }), "off"],
      [entry({ phase: "signing-in" }), "signing-in"],
      [entry({ phase: "connecting" }), "connecting"],
      [entry({ phase: "retrying", cause: "needs-hand-over" }), "reconnecting"],
      [entry({ phase: "channel" }, { state: "connecting", failedAttempts: 0 }), "connecting"],
      [entry({ phase: "channel" }, { state: "connected" }), "connected"],
      [
        entry({ phase: "channel" }, { state: "working", tool: "click", application: "Excel" }),
        "working",
      ],
      [
        entry({ phase: "channel" }, { state: "needs-hand-over", reason: "expired" }),
        "reconnecting",
      ],
      [entry({ phase: "stopping" }), "stopping"],
      [entry({ phase: "unknown" }), "unknown"],
      [entry({ phase: "off", problem: { from: "auth", reason: "not-permitted" } }), "error"],
    ] as const;
    for (const [row, kind] of states) assert.strictEqual(rowState(row), kind);
  });

  it("has a short word for every state, in either language", () => {
    for (const text of [messages.cs.device, messages.en.device]) {
      for (const word of Object.values(text.states)) {
        assert.isAtMost(word.length, 26, word);
        assert.notMatch(word, /[{_]/u);
      }
    }
    assert.strictEqual(messages.cs.device.states.signingIn, "Přihlaste se v prohlížeči");
    assert.strictEqual(messages.en.device.states.connected, "Connected");
  });
});

describe("the problems of a switch", () => {
  const problems: ReadonlyArray<DeviceSwitchProblem> = [
    { from: "auth", reason: "sign-in-failed" },
    { from: "auth", reason: "signed-out" },
    { from: "auth", reason: "unknown-environment" },
    { from: "auth", reason: "not-permitted" },
    { from: "auth", reason: "environment-state-conflict" },
    { from: "auth", reason: "rejected" },
    { from: "app", reason: "helper-unavailable" },
    { from: "app", reason: "stop-not-confirmed" },
    { from: "helper", reason: "agent_desktop_paired", httpStatus: 0 },
    { from: "helper", reason: "agent_desktop_check_failed", httpStatus: 0 },
    { from: "helper", reason: "hand_over_refused", httpStatus: 401 },
    { from: "helper", reason: "not_permitted", httpStatus: 403 },
    { from: "helper", reason: "bad-token", httpStatus: 0 },
    { from: "helper", reason: "contract_mismatch", httpStatus: 0 },
    { from: "helper", reason: "already-attached", httpStatus: 0 },
    { from: "helper", reason: "upgrade_refused", httpStatus: 400 },
    { from: "helper", reason: "invalid_attach_url", httpStatus: 0 },
    { from: "helper", reason: "something_new", httpStatus: 0 },
  ];

  it("says each in one short sentence without internal names or codes", () => {
    for (const text of [messages.cs.device, messages.en.device]) {
      for (const problem of problems) {
        const sentence = text.problems[problemKey(problem)];
        assert.isAtMost(sentence.length, 80, sentence);
        assert.notMatch(sentence, /io\.lazurio|[{_]|HTTP|Auth\b/u, sentence);
        assert.isAbove(text.problemDetails[problemKey(problem)].length, sentence.length);
      }
    }
  });

  it("keeps the utility's keychain entries for the technical details", () => {
    const key = problemKey({ from: "helper", reason: "agent_desktop_paired", httpStatus: 0 });
    assert.notInclude(messages.cs.device.problems[key], "io.lazurio.agent-desktop");
    assert.include(messages.cs.device.problemDetails[key], "io.lazurio.agent-desktop");
    assert.include(messages.en.device.problemDetails[key], "io.lazurio.agent-desktop");
  });

  it("offers to try again only where turning the switch on again can help", () => {
    assert.isTrue(problemRetries({ from: "auth", reason: "sign-in-failed" }));
    assert.isTrue(problemRetries({ from: "helper", reason: "already-attached", httpStatus: 0 }));
    assert.isFalse(problemRetries({ from: "auth", reason: "not-permitted" }));
    assert.isFalse(problemRetries({ from: "auth", reason: "unknown-environment" }));
    assert.isFalse(problemRetries({ from: "helper", reason: "not_permitted", httpStatus: 403 }));
    assert.isFalse(problemRetries({ from: "app", reason: "stop-not-confirmed" }));
  });

  it("gives the helper's code with its HTTP status for the details", () => {
    assert.strictEqual(
      problemCode({ from: "helper", reason: "upgrade_refused", httpStatus: 400 }),
      "upgrade_refused 400",
    );
    assert.strictEqual(
      problemCode({ from: "auth", reason: "unknown-environment" }),
      "unknown-environment",
    );
  });
});

describe("problemTime", () => {
  // Local times, so the test holds in any time zone.
  const local = (year: number, month: number, day: number, hour: number, minute: number) =>
    DateTime.toEpochMillis(
      DateTime.makeZonedUnsafe(
        { year, month, day, hour, minute },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      ),
    );
  const now = local(2026, 11, 19, 16, 0);

  it("gives the time of day for today, 24-hour in Czech", () => {
    assert.strictEqual(problemTime(local(2026, 11, 19, 13, 45), now, "cs"), "13:45");
    assert.strictEqual(problemTime(local(2026, 11, 19, 9, 5), now, "cs"), "9:05");
    assert.strictEqual(
      messages.cs.device.asOf.replace(
        "{time}",
        problemTime(local(2026, 11, 19, 13, 45), now, "cs"),
      ),
      "Stav z 13:45",
    );
  });

  it("adds the date for another day, and the year for another year", () => {
    assert.strictEqual(problemTime(local(2026, 11, 18, 13, 45), now, "cs"), "18. 11. 13:45");
    assert.strictEqual(problemTime(local(2025, 12, 31, 23, 59), now, "cs"), "31. 12. 2025 23:59");
  });

  it("gives English in the system's format, with the minutes and the date when needed", () => {
    const today = problemTime(local(2026, 11, 19, 13, 45), now, "en");
    assert.match(today, /45/u);
    assert.notMatch(today, /11|19/u);
    assert.match(problemTime(local(2026, 11, 18, 13, 45), now, "en"), /18/u);
  });
});
