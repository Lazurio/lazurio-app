import { use, useEffect, useState } from "react";

import type { AppStatus } from "../shared/bridge.ts";
import { localeOf, messages } from "./messages.ts";

export function App({ status }: { readonly status: Promise<AppStatus> }) {
  const [current, setCurrent] = useState(use(status));
  // Every later change comes from the main process. Reading the status once more after
  // subscribing covers a change between the first read and the subscription.
  useEffect(() => {
    const stop = window.lazurio.onStatus(setCurrent);
    void window.lazurio.status().then(setCurrent);
    return stop;
  }, []);
  const text = messages[localeOf(navigator.language)];
  return (
    <main className="shell">
      <header className="shell__header">
        <h1>Lazurio App</h1>
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
              <span>
                {helper.state === "ready" ? `${text.ready} · ${helper.version}` : text.failed}
              </span>
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
            {current.tailnets.map((tailnet) => (
              <li key={tailnet.tailnet} data-tailnet={tailnet.tailnet} data-state={tailnet.state}>
                <span>{tailnet.tailnet}</span>
                <span>
                  {tailnet.state === "running"
                    ? `${text.running} · ${tailnet.addresses.join(", ")}`
                    : text[tailnet.state]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
