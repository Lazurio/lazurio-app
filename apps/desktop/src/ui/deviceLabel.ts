import type {
  DeviceChannelState,
  DeviceSwitchProblem,
  DeviceSwitchStatus,
} from "../shared/bridge.ts";
import type { DeviceText } from "./messages.ts";

// The state of one Environment's channel in words, with the tool an agent runs and its application.
export const channelLabel = (channel: DeviceChannelState, text: DeviceText): string => {
  switch (channel.state) {
    case "off":
      return text.off;
    case "connecting":
      return text.connecting;
    case "connected":
      return text.connected;
    case "unknown":
      return text.unknown;
    case "refused":
      switch (channel.reason) {
        case "agent_desktop_paired":
          return text.agentDesktopPaired;
        case "agent_desktop_check_failed":
          return text.agentDesktopCheckFailed;
        default:
          return text.refused.replace("{reason}", channel.reason);
      }
    case "needs-hand-over":
      return text.needsHandOver.replace("{reason}", channel.reason);
    case "working":
      return channel.application === ""
        ? text.working.replace("{tool}", channel.tool)
        : text.workingIn
            .replace("{tool}", channel.tool)
            .replace("{application}", channel.application);
  }
};

// Why a switch went off by itself, as a sentence that says what to do.
export const problemLabel = (problem: DeviceSwitchProblem, text: DeviceText): string => {
  const problems = text.problems;
  switch (problem.from) {
    case "app":
      return problem.reason === "stop-not-confirmed"
        ? problems.stopNotConfirmed
        : problems.helperUnavailable;
    case "auth":
      switch (problem.reason) {
        case "sign-in-failed":
          return problems.signInFailed;
        case "signed-out":
          return problems.signedOut;
        case "unknown-environment":
          return problems.unknownEnvironment;
        case "not-permitted":
          return problems.notPermitted;
        case "environment-state-conflict":
          return problems.environmentStateConflict;
        case "rejected":
          return problems.rejected;
      }
      break;
    case "helper":
      switch (problem.reason) {
        case "agent_desktop_paired":
          return problems.agentDesktopPaired;
        case "agent_desktop_check_failed":
          return problems.agentDesktopCheckFailed;
        case "hand_over_refused":
          return problems.handOverRefused;
        case "not_permitted":
          return problems.computerNotPermitted;
        case "bad-token":
          return problems.badToken;
        case "contract_mismatch":
          return problems.contractMismatch;
        case "already-attached":
          return problems.alreadyAttached;
        case "upgrade_refused":
          return problems.upgradeRefused.replace("{status}", String(problem.httpStatus));
        case "invalid_attach_url":
          return problems.invalidAttachUrl;
        default:
          return problems.other.replace("{reason}", problem.reason);
      }
  }
};

// Where an Environment's switch is in words, and the problem that turned it off, if one did.
export const switchLabel = (
  entry: DeviceSwitchStatus,
  text: DeviceText,
): { readonly state: string; readonly problem: string | null } => {
  const phase = entry.switch;
  switch (phase.phase) {
    case "off":
      return {
        state: text.off,
        problem: phase.problem === null ? null : problemLabel(phase.problem, text),
      };
    case "signing-in":
      return { state: text.signingIn, problem: null };
    case "connecting":
      return { state: text.connecting, problem: null };
    case "retrying":
      return {
        state: phase.cause === "auth-unavailable" ? text.retryingAuth : text.retryingChannel,
        problem: null,
      };
    case "channel":
      return { state: channelLabel(entry.channel, text), problem: null };
    case "stopping":
      return { state: text.stopping, problem: null };
    case "unknown":
      return { state: text.unknown, problem: null };
  }
};
