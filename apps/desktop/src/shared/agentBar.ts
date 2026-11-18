import type { DeviceStatus } from "./bridge.ts";

// The bar at the top of the main window while an agent holds the computer: who works, Stop, and
// the Agent Desktop window. Without a working agent it takes no height.
export const AGENT_BAR_HEIGHT = 36;

export const workingAgent = (
  status: DeviceStatus | null,
): { readonly environmentId: string; readonly label: string } | null =>
  status === null || status.agent === null || status.agent === "unknown" ? null : status.agent;

export const agentBarHeight = (status: DeviceStatus | null): number =>
  workingAgent(status) === null ? 0 : AGENT_BAR_HEIGHT;
