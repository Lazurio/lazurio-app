import type { UpdatesStatus } from "../shared/bridge.ts";
import type { UpdatesText } from "./messages.ts";

// What the local window says about updates: the state in words, whether it offers to install now,
// and whether it explains that a switch to stable waits for a newer stable (docs/adr/0005, point 4).
export interface UpdateLabel {
  readonly text: string;
  readonly canInstall: boolean;
  readonly floor: boolean;
}

const NIGHTLY = /-nightly\.\d{8}\.\d+$/u;

const withVersion = (template: string, version: string): string =>
  template.replace("{version}", version);

export const updateLabel = (
  updates: UpdatesStatus,
  appVersion: string,
  text: UpdatesText,
  // The app lost its connection to the Device helper: no install can go on until it restarts.
  deviceUnreachable = false,
): UpdateLabel => {
  const floor = updates.channel === "latest" && NIGHTLY.test(appVersion);
  const state = updates.state;
  if (deviceUnreachable && (state.phase === "ready" || state.phase === "installing")) {
    const template =
      state.phase === "ready" ? text.readyWaitsForDevice : text.installingWaitsForDevice;
    return {
      text: withVersion(template, state.version),
      canInstall: state.phase === "ready",
      floor,
    };
  }
  switch (state.phase) {
    case "off":
      return { text: text[state.reason], canInstall: false, floor: false };
    case "idle":
    case "checking":
    case "failed":
      return { text: text[state.phase], canInstall: false, floor };
    case "ready":
      return { text: withVersion(text.ready, state.version), canInstall: true, floor };
    case "downloading":
    case "installing":
    case "restarting":
      return { text: withVersion(text[state.phase], state.version), canInstall: false, floor };
  }
};
