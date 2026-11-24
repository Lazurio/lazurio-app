import { useEffect, useState } from "react";

import { workingAgent } from "../shared/agentBar.ts";
import type { DeviceStatus } from "../shared/bridge.ts";
import { localeOf, messages } from "./messages.ts";

// The bar across the top of the main window while an agent holds the computer (?view=agent-bar):
// who works, Stop, and the Agent Desktop window. Without an agent, and without the Organization's
// network, it says that on every page, with a button for what to do. The main process gives it
// height only then (MainWindow.topBar, agentBarHeight); otherwise it renders nothing.
export function AgentBar() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  // Known at the app's start; once the network appears, the app starts again (SettingWatch.ts).
  const [networkMissing, setNetworkMissing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setStatus);
    void window.lazurio.device.getState().then(setStatus);
    void window.lazurio.status().then((app) => setNetworkMissing(app.networkMissing));
    return stop;
  }, []);
  const words = messages[localeOf(navigator.language)];
  const text = words.device;
  const agent = workingAgent(status);
  if (agent === null && networkMissing) {
    return (
      <div className="agent-bar" data-agent-bar="network" role="status">
        <p className="agent-bar__text">{words.networkBar}</p>
        <button
          type="button"
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
