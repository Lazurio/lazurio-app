import type { AppStatus, DeviceStatus } from "./bridge.ts";

// The app's status as plain text to paste into a message for support or an agent ("Copy status"
// in the status column). It carries no secret and no address inside a tailnet: names, states,
// versions and the problems the app itself words, nothing a person typed or Lazurio Auth issued.
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
              tailnet.state === "stopped"
                ? ` (${tailnet.reason ?? "problem"}: ${tailnet.problem})`
                : ""
            }`,
        )),
    "Helper programs:",
    ...status.helpers.map((helper) =>
      helper.state === "ready"
        ? `  ${helper.name}: ready ${helper.version}`
        : `  ${helper.name}: failed (${helper.problem})`,
    ),
    `Agent Desktop: ${device.state}; account ${device.account}; agent ${agentLine(device.agent)}`,
    ...device.switches.map(
      (entry) =>
        `  ${entry.host}: ${entry.switch.phase}${
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
      return `failed (${state.problem})`;
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
