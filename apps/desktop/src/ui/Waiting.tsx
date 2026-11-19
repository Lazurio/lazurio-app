import { useState } from "react";

import { problemOf, reasonOf, type PageProblem } from "../shared/pageProblem.ts";
import { localeOf, messages, type Text } from "./messages.ts";

// What the window shows in the remote page's place while it cannot show (MainWindow.ts,
// watchPage): waiting for a tailnet that cannot reach it yet, or why its load failed. Either way
// it says why, loads the page again on Retry and opens the app's status.
export function Waiting() {
  const text = messages[localeOf(navigator.language)];
  const problem = problemOf(location.search);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void window.lazurio.retryPage().finally(() => setRetrying(false));
  };
  const words = wordsOf(problem, text);
  return (
    <main className="waiting" data-problem={problem?.kind ?? "waiting"}>
      <h1>{words.title}</h1>
      <p>{words.lead}</p>
      {problem === undefined || problem.kind === "waiting" || problem.kind === "browser" ? null : (
        <p>{text.page.persists}</p>
      )}
      {words.code === undefined ? null : <p className="waiting__code">{words.code}</p>}
      <div className="waiting__actions">
        <button type="button" data-action="page-retry" disabled={retrying} onClick={retry}>
          {retrying ? text.page.retrying : text.page.retry}
        </button>
        <button
          type="button"
          className="waiting__secondary"
          data-action="waiting-show-status"
          onClick={() => void window.lazurio.setStatusPanel(true)}
        >
          {text.waiting.showStatus}
        </button>
      </div>
    </main>
  );
}

const wordsOf = (
  problem: PageProblem | undefined,
  text: Text,
): { readonly title: string; readonly lead: string; readonly code?: string } => {
  const page = text.page;
  const withHost = (template: string, host: string) => template.replace("{host}", host);
  switch (problem?.kind) {
    case undefined:
      return { title: text.waiting.title, lead: text.waiting.lead };
    case "waiting":
      return {
        title: text.waiting.title,
        lead: text.waiting.lead,
        code: page.code.replace("{code}", String(problem.code)),
      };
    case "failed":
      return {
        title: page.failedTitle,
        lead: withHost(page.reasons[reasonOf(problem.code)], problem.host),
        code: page.code.replace("{code}", String(problem.code)),
      };
    case "proxy":
      return {
        title: page.failedTitle,
        lead: withHost(page.proxyLead, problem.host),
        code: page.code.replace("{code}", "407"),
      };
    case "refused":
      return { title: page.refusedTitle, lead: withHost(page.refusedLead, problem.host) };
    case "browser":
      return { title: page.browserTitle, lead: withHost(page.browserLead, problem.host) };
    case "crashed":
      return { title: page.crashedTitle, lead: page.crashedLead };
  }
};
