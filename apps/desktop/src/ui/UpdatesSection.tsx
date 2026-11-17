import { useState } from "react";

import type { UpdateChannelName, UpdatesStatus } from "../shared/bridge.ts";
import type { UpdatesText } from "./messages.ts";
import { updateLabel } from "./updateLabel.ts";

// Updates in the app's local window (docs/adr/0005, point 4): the state, the channel, and a button
// for a ready update. Only this native window can change them; no remote page has the bridge.
export function UpdatesSection({
  updates,
  appVersion,
  text,
  deviceUnreachable,
}: {
  readonly updates: UpdatesStatus;
  readonly appVersion: string;
  readonly text: UpdatesText;
  // The app lost its connection to the Device helper, so an install waits for its restart.
  readonly deviceUnreachable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const label = updateLabel(updates, appVersion, text, deviceUnreachable);
  // While an install runs, the main process refuses a change of channel; the radios say so too.
  const installing = updates.state.phase === "installing" || updates.state.phase === "restarting";
  const pick = (channel: UpdateChannelName) => {
    if (channel === updates.channel) return;
    setBusy(true);
    setNotSaved(false);
    window.lazurio
      .setUpdateChannel(channel)
      .catch(() => setNotSaved(true))
      .finally(() => setBusy(false));
  };
  return (
    <section
      aria-label={text.title}
      className="shell__updates"
      data-updates-phase={updates.state.phase}
      data-updates-channel={updates.channel}
      data-updates-reason={updates.state.phase === "off" ? updates.state.reason : undefined}
      data-updates-device={deviceUnreachable ? "unreachable" : undefined}
    >
      <h2>{text.title}</h2>
      <p className="shell__state">{label.text}</p>
      {label.canInstall ? (
        <button
          type="button"
          data-action="install"
          onClick={() => void window.lazurio.installUpdate()}
        >
          {text.install}
        </button>
      ) : null}
      <fieldset className="shell__channel" disabled={busy || installing}>
        <legend>{text.channel}</legend>
        {(["latest", "nightly"] as const).map((channel) => (
          <label key={channel}>
            <input
              type="radio"
              name="update-channel"
              value={channel}
              checked={updates.channel === channel}
              onChange={() => pick(channel)}
            />
            {text[channel]}
          </label>
        ))}
      </fieldset>
      {notSaved ? (
        <p className="shell__problem" role="alert" data-updates-problem="channel-not-saved">
          {text.channelNotSaved}
        </p>
      ) : null}
      {label.floor ? <p className="shell__empty">{text.floor}</p> : null}
    </section>
  );
}
