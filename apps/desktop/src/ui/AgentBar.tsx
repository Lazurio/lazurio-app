import { useEffect, useState } from "react";

import { workingAgent } from "../shared/agentBar.ts";
import type { DeviceStatus } from "../shared/bridge.ts";
import { localeOf, messages } from "./messages.ts";

// The bar across the top of the main window while an agent holds the computer (?view=agent-bar):
// who works, Stop, and the Agent Desktop window. The main process gives it height only then
// (MainWindow.topBar, agentBarHeight); without an agent it renders nothing.
export function AgentBar() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setStatus);
    void window.lazurio.device.getState().then(setStatus);
    return stop;
  }, []);
  const text = messages[localeOf(navigator.language)].device;
  const agent = workingAgent(status);
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
