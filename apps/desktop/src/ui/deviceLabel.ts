import * as DateTime from "effect/DateTime";

import type { DeviceSwitchProblem, DeviceSwitchStatus } from "../shared/bridge.ts";
import type { DeviceText, Locale } from "./messages.ts";

// Agent Desktop's switches in words: one short state per switch, and for a switch that went off by
// itself one short sentence, the details behind it and whether trying again can help.

export type RowState =
  | "off"
  | "signing-in"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "working"
  | "stopping"
  | "error"
  | "unknown";

export const rowState = (entry: DeviceSwitchStatus): RowState => {
  const phase = entry.switch;
  switch (phase.phase) {
    case "off":
      return phase.problem === null ? "off" : "error";
    case "signing-in":
      return "signing-in";
    case "connecting":
      return "connecting";
    case "retrying":
      return "reconnecting";
    case "stopping":
      return "stopping";
    case "unknown":
      return "unknown";
    case "channel":
      switch (entry.channel.state) {
        case "connected":
          return "connected";
        case "working":
          return "working";
        case "needs-hand-over":
          return "reconnecting";
        case "refused":
          return "error";
        case "unknown":
          return "unknown";
        case "connecting":
        case "off":
          return "connecting";
      }
  }
};

export const rowStateWord = (state: RowState, text: DeviceText): string => {
  const words = text.states;
  switch (state) {
    case "off":
      return words.off;
    case "signing-in":
      return words.signingIn;
    case "connecting":
      return words.connecting;
    case "reconnecting":
      return words.reconnecting;
    case "connected":
      return words.connected;
    case "working":
      return words.working;
    case "stopping":
      return words.stopping;
    case "error":
      return words.error;
    case "unknown":
      return words.unknown;
  }
};

type ProblemKey = keyof DeviceText["problems"];

export const problemKey = (problem: DeviceSwitchProblem): ProblemKey => {
  switch (problem.from) {
    case "app":
      return problem.reason === "stop-not-confirmed" ? "stopNotConfirmed" : "helperUnavailable";
    case "auth":
      switch (problem.reason) {
        case "sign-in-failed":
          return "signInFailed";
        case "signed-out":
          return "signedOut";
        case "unknown-environment":
          return "unknownEnvironment";
        case "not-permitted":
          return "notPermitted";
        case "environment-state-conflict":
          return "environmentStateConflict";
        case "rejected":
          return "rejected";
      }
      break;
    case "helper":
      switch (problem.reason) {
        case "agent_desktop_paired":
          return "agentDesktopPaired";
        case "agent_desktop_check_failed":
          return "agentDesktopCheckFailed";
        case "hand_over_refused":
          return "handOverRefused";
        case "not_permitted":
          return "computerNotPermitted";
        case "bad-token":
          return "badToken";
        case "contract_mismatch":
          return "contractMismatch";
        case "already-attached":
          return "alreadyAttached";
        case "upgrade_refused":
          return "upgradeRefused";
        case "invalid_attach_url":
          return "invalidAttachUrl";
        default:
          return "other";
      }
  }
};

// Turning the switch on again can help: the sign-in, a passing state of Lazurio or the
// Environment, or the utility once the person removed it. Not when the Environment is not the
// person's, the computer is not approved, or the app must start again.
const RETRIES: ReadonlySet<ProblemKey> = new Set([
  "signInFailed",
  "signedOut",
  "environmentStateConflict",
  "rejected",
  "agentDesktopPaired",
  "agentDesktopCheckFailed",
  "handOverRefused",
  "badToken",
  "alreadyAttached",
  "upgradeRefused",
  "other",
]);

export const problemRetries = (problem: DeviceSwitchProblem): boolean =>
  RETRIES.has(problemKey(problem));

// The code of a refusal for the technical details: the helper's with its HTTP status, or the app's.
export const problemCode = (problem: DeviceSwitchProblem): string =>
  problem.from === "helper" && problem.httpStatus !== 0
    ? `${problem.reason} ${problem.httpStatus}`
    : problem.reason;

// When a switch's problem happened, for "As of …" under its sentence: the time of day, with the
// date when it was another day (and the year when another year). Czech in Czech, 24-hour; English
// in the system's own format. In the computer's time zone.
export const problemTime = (at: number, now: number, locale: Locale): string => {
  const zone = DateTime.zoneMakeLocal();
  const then = DateTime.makeZonedUnsafe(at, { timeZone: zone });
  const thenParts = DateTime.toParts(then);
  const nowParts = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone }));
  const sameYear = thenParts.year === nowParts.year;
  const sameDay = sameYear && thenParts.month === nowParts.month && thenParts.day === nowParts.day;
  return DateTime.format(then, {
    ...(locale === "cs" ? { locale: "cs-CZ", hourCycle: "h23" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { day: "numeric", month: "numeric" }),
    ...(sameYear ? {} : { year: "numeric" }),
  });
};
