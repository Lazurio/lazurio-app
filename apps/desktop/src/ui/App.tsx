import { use, useEffect, useState } from "react";

import { APP_NAME } from "../shared/appName.ts";
import type { AppStatus, DeviceStatus } from "../shared/bridge.ts";

import { AgentDesktopSection } from "./AgentDesktopWindow.tsx";
import { localeOf, messages } from "./messages.ts";
import { tailnetLabel } from "./tailnetLabel.ts";
import { UpdatesSection } from "./UpdatesSection.tsx";

export function App({ status }: { readonly status: Promise<AppStatus> }) {
  const [current, setCurrent] = useState(use(status));
  const [live, setLive] = useState(false);
  // Every later change comes from the main process. Reading the status once more after
  // subscribing covers a change between the first read and the subscription. From then on the
  // window follows every change (data-status="live", which end-to-end tests wait for).
  useEffect(() => {
    const stop = window.lazurio.onStatus(setCurrent);
    void window.lazurio.status().then((latest) => {
      setCurrent(latest);
      setLive(true);
    });
    return stop;
  }, []);
  // Agent Desktop's state, for its section and for the updates' section: every later change comes
  // from the main process, and reading it once more after subscribing covers a change between.
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setDevice);
    void window.lazurio.device.getState().then(setDevice);
    return stop;
  }, []);
  const text = messages[localeOf(navigator.language)];
  // Whether an agent holds the computer now, or may (the helper was lost unconfirmed): Agent
  // Desktop's section, with Stop or its warning, then comes first and the column stays.
  const agentWorks = device !== null && device.agent !== null;
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const copyStatus = () => {
    window.lazurio.copyStatus().then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
  };
  return (
    <main className="shell" data-status={live ? "live" : "initial"}>
      <header className="shell__header">
        <div className="shell__title">
          <h1>{APP_NAME}</h1>
          <button
            type="button"
            className="shell__link"
            data-action="status-hide"
            disabled={agentWorks}
            onClick={() => void window.lazurio.setStatusPanel(false)}
          >
            {text.status.hide}
          </button>
        </div>
        <p className="shell__subtitle">{text.status.title}</p>
        {agentWorks ? (
          <p className="shell__subtitle" data-status-stays="">
            {text.status.hideWhileAgentWorks}
          </p>
        ) : null}
        <dl className="shell__facts">
          <dt>{text.version}</dt>
          <dd>{current.appVersion}</dd>
        </dl>
        <div className="shell__copy">
          <button type="button" data-action="status-copy" onClick={copyStatus}>
            {text.status.copy}
          </button>
          {copyState === null ? null : (
            <p className="shell__empty" role="status" data-copy-state={copyState}>
              {copyState === "copied" ? text.status.copied : text.status.copyFailed}
            </p>
          )}
        </div>
      </header>
      {/* While an agent works, or may (the helper was lost unconfirmed), the column shows Agent
          Desktop's section with Stop or its warning first, as in the Agent Desktop window. */}
      {agentWorks ? <AgentDesktopSection status={device} text={text.device} /> : null}
      <section aria-label={text.tailnets}>
        <h2>{text.tailnets}</h2>
        {current.networkMissing ? (
          <p className="shell__reason" data-network-missing="">
            {text.networkMissing}
          </p>
        ) : current.tailnets.length === 0 ? (
          <p className="shell__empty">{text.noTailnets}</p>
        ) : (
          <ul className="shell__helpers">
            {current.tailnets.map((tailnet) => {
              const label = tailnetLabel(tailnet, text);
              return (
                <li
                  key={tailnet.tailnet}
                  data-tailnet={tailnet.tailnet}
                  data-state={tailnet.state}
                  data-reason={tailnet.state === "stopped" ? tailnet.reason : undefined}
                >
                  <span>{tailnet.tailnet}</span>
                  <span className="shell__state">{label.state}</span>
                  {label.detail === undefined ? null : (
                    <div className="shell__reason">
                      <p>{label.detail.text}</p>
                      {label.detail.files?.map((file) => (
                        <code key={file} className="shell__file">
                          {file}
                        </code>
                      ))}
                      {label.detail.after === undefined ? null : <p>{label.detail.after}</p>}
                    </div>
                  )}
                  {/* The sign-in address, for a person who finishes the sign-in elsewhere: it
                      reaches only the clipboard, never this window. */}
                  {tailnet.state === "needs-login" && tailnet.canCopySignIn ? (
                    <div className="shell__copy shell__sign-in">
                      <button
                        type="button"
                        data-action="tailnet-copy-sign-in"
                        onClick={() => void window.lazurio.copyTailnetSignIn(tailnet.tailnet)}
                      >
                        {text.browser.copy}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <UpdatesSection
        updates={current.updates}
        appVersion={current.appVersion}
        text={text.updates}
        deviceUnreachable={device?.state === "lost"}
      />
      {/* Otherwise Agent Desktop lives in its own window (DevicePanel.ts). */}
      {device === null || device.state === "absent" || agentWorks ? null : (
        <section aria-label={text.device.title} className="shell__device">
          <h2>{text.device.title}</h2>
          <button
            type="button"
            className="shell__link"
            data-action="device-open-window"
            onClick={() => void window.lazurio.device.openWindow()}
          >
            {text.device.openWindow}
          </button>
        </section>
      )}
      <details className="shell__details" data-details="">
        <summary>{text.status.details}</summary>
        <dl className="shell__facts">
          <dt>{text.generation}</dt>
          <dd>{current.generation}</dd>
        </dl>
        {/* A running node's addresses in its network, which only a technical look needs. */}
        {current.tailnets.some((tailnet) => tailnet.state === "running") ? (
          <section aria-label={text.addresses}>
            <h3>{text.addresses}</h3>
            <ul className="shell__helpers">
              {current.tailnets.flatMap((tailnet) =>
                tailnet.state === "running"
                  ? [
                      <li key={tailnet.tailnet} data-tailnet-addresses={tailnet.tailnet}>
                        <span>{tailnet.tailnet}</span>
                        {tailnet.addresses.map((address) => (
                          <span key={address} className="shell__detail">
                            {address}
                          </span>
                        ))}
                      </li>,
                    ]
                  : [],
              )}
            </ul>
          </section>
        ) : null}
        <section aria-label={text.helpers}>
          <h3>{text.helpers}</h3>
          <ul className="shell__helpers">
            {current.helpers.map((helper) => (
              <li key={helper.name} data-helper={helper.name} data-state={helper.state}>
                <span>{helper.name}</span>
                <span className="shell__state">
                  {helper.state === "ready" ? text.ready : text.failed}
                </span>
                {helper.state === "ready" ? (
                  <span className="shell__detail">{helper.version}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </details>
    </main>
  );
}
