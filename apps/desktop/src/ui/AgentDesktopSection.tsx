import { useEffect, useState } from "react";

import type { DeviceStatus } from "../shared/bridge.ts";
import { channelLabel } from "./deviceLabel.ts";
import type { DeviceText } from "./messages.ts";

// Agent Desktop in the app's local window (docs/adr/0006, point 5): the Environments the Device
// helper reports, Stop while an agent works, and where pairing comes from. Only this native window
// has these controls; no remote page has the bridge.
export function AgentDesktopSection({ text }: { readonly text: DeviceText }) {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  // Every later change comes from the main process; reading the state once more after subscribing
  // covers a change between the two.
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setStatus);
    void window.lazurio.device.getState().then(setStatus);
    return stop;
  }, []);
  if (status === null || status.state === "absent") return null;
  const stopAgent = () => {
    setStopping(true);
    setStopFailed(false);
    window.lazurio.device
      .stop()
      .catch(() => setStopFailed(true))
      .finally(() => setStopping(false));
  };
  return (
    <section aria-label={text.title} className="shell__device" data-device-state={status.state}>
      <h2>{text.title}</h2>
      {status.state === "starting" ? <p className="shell__state">{text.starting}</p> : null}
      {status.state === "failed" ? (
        <p className="shell__problem" role="alert">
          {text.failed}
        </p>
      ) : null}
      {status.agent === null ? null : (
        <div className="shell__agent" data-device-agent={status.agent.environmentId}>
          <p>{text.agentWorking.replace("{label}", status.agent.label)}</p>
          <button type="button" data-action="device-stop" disabled={stopping} onClick={stopAgent}>
            {text.stop}
          </button>
        </div>
      )}
      {stopFailed ? (
        <p className="shell__problem" role="alert" data-device-problem="stop-failed">
          {text.stopFailed}
        </p>
      ) : null}
      <h3>{text.environments}</h3>
      {status.environments.length === 0 ? (
        <p className="shell__empty" data-device-environments="none">
          {text.noEnvironments}
        </p>
      ) : (
        <ul className="shell__helpers">
          {status.environments.map((environment) => (
            <li
              key={environment.environmentId}
              data-device-environment={environment.environmentId}
              data-state={environment.channel.state}
            >
              <span>{environment.label}</span>
              <span className="shell__state">{channelLabel(environment.channel, text)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="shell__empty" data-device-pairing="later">
        {text.pairingLater}
      </p>
    </section>
  );
}
