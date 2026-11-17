import { use, useEffect, useState } from "react";

import { APP_NAME } from "../shared/appName.ts";
import type { AppStatus, DeviceStatus } from "../shared/bridge.ts";
import { AgentDesktopSection } from "./AgentDesktopSection.tsx";
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
  return (
    <main className="shell" data-status={live ? "live" : "initial"}>
      <header className="shell__header">
        <h1>{APP_NAME}</h1>
        <dl className="shell__facts">
          <dt>{text.generation}</dt>
          <dd>{current.generation}</dd>
          <dt>{text.version}</dt>
          <dd>{current.appVersion}</dd>
        </dl>
      </header>
      <section aria-label={text.helpers}>
        <h2>{text.helpers}</h2>
        <ul className="shell__helpers">
          {current.helpers.map((helper) => (
            <li key={helper.name} data-helper={helper.name} data-state={helper.state}>
              <span>{helper.name}</span>
              <span>{helper.state === "ready" ? text.ready : text.failed}</span>
              {helper.state === "ready" ? (
                <span className="shell__detail">{helper.version}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={text.tailnets}>
        <h2>{text.tailnets}</h2>
        {current.tailnets.length === 0 ? (
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
                  {label.addresses?.map((address) => (
                    <span key={address} className="shell__detail">
                      {address}
                    </span>
                  ))}
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
      <AgentDesktopSection status={device} text={text.device} />
    </main>
  );
}
