import { useEffect, useState } from "react";

import { workingAgent } from "../shared/agentBar.ts";
import type { DeviceStatus } from "../shared/bridge.ts";
import { offersSignIn, type NetworkBarStep } from "../shared/networkBar.ts";
import { localeOf, messages, type Text } from "./messages.ts";
import { signInLabel, useNetworkSignIn } from "./networkSignIn.ts";

// The bar across the top of the main window while an agent holds the computer (?view=agent-bar):
// who works, Stop, and the Agent Desktop window. Without an agent, and without the Organization's
// network, it says that on every page, with the account's sign-in that brings the person's networks
// and a button for what to do. The main process gives it height only then (agentBarHeight).
export function AgentBar() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  // Fixed for the app's run; once the network appears, the app starts again (SettingWatch.ts and
  // NetworkDirectory.ts).
  const network = useNetworkSignIn();
  const networkMissing = network.status?.networkMissing ?? false;
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setStatus);
    void window.lazurio.device.getState().then(setStatus);
    return stop;
  }, []);
  const words = messages[localeOf(navigator.language)];
  const text = words.device;
  const agent = workingAgent(status);
  if (agent === null && networkMissing && network.step !== undefined) {
    const signs = offersSignIn(network.step);
    return (
      <div
        className="agent-bar"
        data-agent-bar="network"
        data-network-step={network.step}
        role="status"
      >
        <p className="agent-bar__text">
          {network.failed ? words.networksSignInFailed : barSentence(network.step, words)}
        </p>
        {signs ? (
          <button
            type="button"
            data-action="networks-sign-in"
            disabled={network.signingIn}
            onClick={network.signIn}
          >
            {network.signingIn
              ? words.networkBarSteps.signingIn
              : signInLabel(network.step, network.failed, words)}
          </button>
        ) : null}
        <button
          type="button"
          className={signs ? "agent-bar__secondary" : undefined}
          data-action="network-help"
          onClick={() => void window.lazurio.showNetworkHelp()}
        >
          {words.networkHelp}
        </button>
      </div>
    );
  }
  if (agent === null) return <div className="agent-bar" data-agent-bar="none" />;
  const stopAgent = () => {
    setStopping(true);
    setStopFailed(false);
    window.lazurio.device
      .stop()
      .catch(() => setStopFailed(true))
      .finally(() => setStopping(false));
  };
  return (
    <div className="agent-bar" data-agent-bar={agent.environmentId} role="status">
      <p className="agent-bar__text">
        {stopFailed ? text.stopFailed : text.agentWorking.replace("{label}", agent.label)}
      </p>
      <button type="button" data-action="device-stop" disabled={stopping} onClick={stopAgent}>
        {text.stop}
      </button>
      <button
        type="button"
        className="agent-bar__secondary"
        data-action="device-open-window"
        onClick={() => void window.lazurio.device.openWindow()}
      >
        {text.barOpen}
      </button>
    </div>
  );
}

const barSentence = (step: NetworkBarStep, words: Text): string => {
  switch (step) {
    case "reading":
      return words.networkBarSteps.reading;
    case "not-read":
      return words.networkBarSteps.notRead;
    case "empty":
      return words.networkBarSteps.empty;
    default:
      return words.networkBar;
  }
};
