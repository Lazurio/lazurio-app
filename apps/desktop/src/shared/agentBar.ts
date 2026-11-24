import type { DeviceStatus } from "./bridge.ts";

// The bar at the top of the main window while an agent holds the computer: who works, Stop, and
// the Agent Desktop window. Without a working agent it says that the Organization's network is
// missing, when it is, on every page; otherwise it takes no height.
export const AGENT_BAR_HEIGHT = 36;

export const workingAgent = (
  status: DeviceStatus | null,
): { readonly environmentId: string; readonly label: string } | null =>
  status === null || status.agent === null || status.agent === "unknown" ? null : status.agent;

export const agentBarHeight = (status: DeviceStatus | null, networkMissing = false): number =>
  workingAgent(status) === null && !networkMissing ? 0 : AGENT_BAR_HEIGHT;
