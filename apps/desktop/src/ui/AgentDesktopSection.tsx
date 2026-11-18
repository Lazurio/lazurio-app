import { useState } from "react";

import type { DeviceStatus, DeviceSwitchStatus } from "../shared/bridge.ts";
import { switchLabel } from "./deviceLabel.ts";
import type { DeviceText } from "./messages.ts";

// One Environment the person added: its switch, its state in words, why it went off and Remove.
function EnvironmentSwitch({
  entry,
  text,
  onFailure,
}: {
  readonly entry: DeviceSwitchStatus;
  readonly text: DeviceText;
  readonly onFailure: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // On in every phase but Off; while it stops, or when nobody knows, it takes no click.
  const on = entry.switch.phase !== "off";
  const settled = entry.switch.phase !== "stopping" && entry.switch.phase !== "unknown";
  const label = switchLabel(entry, text);
  const act = (call: () => Promise<void>) => {
    setBusy(true);
    call()
      .catch(onFailure)
      .finally(() => setBusy(false));
  };
  return (
    <li
      data-device-switch={entry.origin}
      data-switch-phase={entry.switch.phase}
      data-state={entry.channel.state}
    >
      <label className="shell__switch">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={busy || !settled}
          aria-label={text.switchLabel.replace("{host}", entry.host)}
          data-action="device-switch"
          onChange={(event) => {
            const next = event.currentTarget.checked;
            act(() => window.lazurio.device.setSwitch(entry.origin, next));
          }}
        />
        <span>{entry.host}</span>
      </label>
      <span className="shell__state">{label.state}</span>
      {label.problem === null ? null : (
        <p className="shell__reason shell__problem" role="alert" data-switch-problem="">
          {label.problem}
        </p>
      )}
      <button
        type="button"
        className="shell__link"
        disabled={busy || !settled}
        data-action="device-remove"
        onClick={() => act(() => window.lazurio.device.removeEnvironment(entry.origin))}
      >
        {text.remove}
      </button>
    </li>
  );
}

// Agent Desktop in the app's local window (docs/adr/0006, point 5, and contract v3): the
// Environments the person added with their switches, adding the Environment the main window shows,
// Stop while an agent works, and the app's Lazurio account. Only this native window has these
// controls; no remote page has the bridge.
export function AgentDesktopSection({
  status,
  text,
}: {
  readonly status: DeviceStatus | null;
  readonly text: DeviceText;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  if (status === null || status.state === "absent") return null;
  const failed = () => setActionFailed(true);
  const run = (call: () => Promise<void>) => {
    setActionFailed(false);
    call().catch(failed);
  };
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
        <p className="shell__problem" role="alert" data-device-problem="failed">
          {text.failed}
        </p>
      ) : null}
      {/* The helper cannot be reached: no Stop, only what is known and what to do. */}
      {status.state === "lost" ? (
        <p
          className="shell__problem"
          role="alert"
          data-device-problem={status.agent === "unknown" ? "lost" : "lost-confirmed"}
        >
          {status.agent === "unknown" ? text.lost : text.lostConfirmed}
        </p>
      ) : null}
      {status.agent === null || status.agent === "unknown" ? null : (
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
      {status.switches.length === 0 ? (
        <p className="shell__empty" data-device-environments="none">
          {text.noEnvironments}
        </p>
      ) : (
        <ul className="shell__helpers shell__switches">
          {status.switches.map((entry) => (
            <EnvironmentSwitch key={entry.origin} entry={entry} text={text} onFailure={failed} />
          ))}
        </ul>
      )}
      {/* Without an Environment to add, how to add one, until the list has one. */}
      {status.addable === null ? (
        status.switches.length === 0 ? (
          <p className="shell__empty" data-device-add="none">
            {text.addHint}
          </p>
        ) : null
      ) : (
        <div className="shell__agent" data-device-add={status.addable}>
          <button
            type="button"
            data-action="device-add"
            onClick={() => run(() => window.lazurio.device.addEnvironment(status.addable ?? ""))}
          >
            {text.add}
          </button>
        </div>
      )}
      {actionFailed ? (
        <p className="shell__problem" role="alert" data-device-problem="action-failed">
          {text.actionFailed}
        </p>
      ) : null}
      <div className="shell__account" data-device-account={status.account}>
        <p className="shell__empty">
          {status.account === "signed-in" ? text.signedIn : text.signedOut}
        </p>
        {status.account === "signed-in" ? (
          <button
            type="button"
            className="shell__link"
            data-action="device-sign-out"
            onClick={() => run(() => window.lazurio.device.signOut())}
          >
            {text.signOut}
          </button>
        ) : null}
      </div>
    </section>
  );
}
