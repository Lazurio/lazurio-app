import type { DeviceChannelState } from "../shared/bridge.ts";
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
