import type { AppStatus, DeviceStatus } from "./bridge.ts";

// The app's status as plain text to paste into a message for support or an agent ("Copy status"
// in the status column). It carries no secret and no address: names, states, versions and codes
// only. No problem text (a helper's, the updater's or a node's may name a path, a host or a feed),
// no Environment's host and nothing a person typed or Lazurio Auth issued.
export const statusText = (options: {
  readonly appName: string;
  readonly platform: string;
  readonly status: AppStatus;
  readonly device: DeviceStatus;
  // When the status was copied, as an ISO 8601 time.
  readonly at: string;
}): string => {
  const { status, device } = options;
  const lines = [
    `${options.appName} ${status.appVersion} (${status.generation}, ${options.platform})`,
    `Copied: ${options.at}`,
    `Update channel: ${status.updates.channel}; update: ${updateLine(status.updates.state)}`,
    "Networks:",
    ...(status.tailnets.length === 0
      ? ["  none"]
      : status.tailnets.map(
          (tailnet) =>
            `  ${tailnet.tailnet}: ${tailnet.state}${
              tailnet.state === "stopped" ? ` (${tailnet.reason ?? "problem"})` : ""
            }`,
        )),
    "Helper programs:",
    ...status.helpers.map((helper) =>
      helper.state === "ready"
        ? `  ${helper.name}: ready ${helper.version}`
        : `  ${helper.name}: failed`,
    ),
    `Agent Desktop: ${device.state}; account ${device.account}; agent ${agentLine(device.agent)}`,
    // Each Environment by its place in the list, never by its host.
    ...device.switches.map(
      (entry, index) =>
        `  Environment ${index + 1}: ${entry.switch.phase}${
          entry.switch.phase === "off" && entry.switch.problem !== null
            ? ` (${entry.switch.problem.from}: ${entry.switch.problem.reason})`
            : ""
        }; channel ${entry.channel.state}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
};

const updateLine = (state: AppStatus["updates"]["state"]): string => {
  switch (state.phase) {
    case "off":
      return `off (${state.reason})`;
    case "failed":
      return "failed";
    case "downloading":
    case "ready":
    case "installing":
    case "restarting":
      return `${state.phase} ${state.version}`;
    default:
      return state.phase;
  }
};

const agentLine = (agent: DeviceStatus["agent"]): string =>
  agent === null ? "none" : agent === "unknown" ? "unknown" : `working for ${agent.label}`;
