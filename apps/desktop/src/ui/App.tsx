import { use } from "react";

import type { AppStatus } from "../shared/bridge.ts";
import { localeOf, messages } from "./messages.ts";

export function App({ status }: { readonly status: Promise<AppStatus> }) {
  const current = use(status);
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
    </main>
  );
}
