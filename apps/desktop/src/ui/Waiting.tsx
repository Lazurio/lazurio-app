import { useEffect, useState } from "react";

import type { TailnetStatus } from "../shared/bridge.ts";
import { problemOf, reasonOf, type PageProblem } from "../shared/pageProblem.ts";
import { waitingStep, type WaitingStep } from "../shared/waitingStep.ts";
import { localeOf, messages, type Text } from "./messages.ts";

// What the window shows in the remote page's place while it cannot show (MainWindow.ts): why its
// load failed, or, waiting for a tailnet, the step the person is at (shared/waitingStep.ts), with a
// button that opens the network's sign-in again. Retry loads the page again.
export function Waiting() {
  const text = messages[localeOf(navigator.language)];
  const problem = problemOf(location.search);
  const [retrying, setRetrying] = useState(false);
  // Unknown until the app answers: a page that waits for a tailnet says nothing until then, so it
  // never shows a general sentence for a moment before the step (it loads again on every attempt).
  const [tailnets, setTailnets] = useState<ReadonlyArray<TailnetStatus> | undefined>(undefined);
  useEffect(() => {
    const stop = window.lazurio.onStatus((status) => setTailnets(status.tailnets));
    void window.lazurio.status().then((status) => setTailnets(status.tailnets));
    return stop;
  }, []);
  const waitsForTailnet = problem === undefined || problem.kind === "waiting";
  if (waitsForTailnet && tailnets === undefined) {
    return <main className="waiting" data-problem={problem?.kind ?? "waiting"} aria-busy="true" />;
  }
  const step = waitsForTailnet && tailnets !== undefined ? waitingStep(tailnets) : undefined;
  const retry = () => {
    setRetrying(true);
    void window.lazurio.retryPage().finally(() => setRetrying(false));
  };
  const back = () => {
    setRetrying(true);
    void window.lazurio.firstPage().finally(() => setRetrying(false));
  };
  const words = step === undefined ? wordsOf(problem, text) : stepWords(step, text);
  return (
    <main
      className="waiting"
      data-problem={problem?.kind ?? "waiting"}
      {...(step === undefined ? {} : { "data-waiting-step": step })}
    >
      <h1>{words.title}</h1>
      <p>{words.lead}</p>
      {step === "approval" ? <p>{text.waiting.approvalAfter}</p> : null}
      {problem === undefined ||
      problem.kind === "waiting" ||
      problem.kind === "browser" ||
      problem.kind === "network" ? null : (
        <p>{text.page.persists}</p>
      )}
      {words.code === undefined ? null : <p className="waiting__code">{words.code}</p>}
      <div className="waiting__actions">
        {step === "sign-in" ? (
          <button
            type="button"
            data-action="tailnet-sign-in-again"
            onClick={() => void window.lazurio.openTailnetSignIn()}
          >
            {text.waiting.signInAgain}
          </button>
        ) : null}
        <button
          type="button"
          className={step === "sign-in" ? "waiting__secondary" : undefined}
          data-action="page-retry"
          disabled={retrying}
          onClick={retry}
        >
          {retrying ? text.page.retrying : text.page.retry}
        </button>
        <button
          type="button"
          className="waiting__secondary"
          data-action="page-first"
          disabled={retrying}
          onClick={back}
        >
          {text.page.back}
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

const stepWords = (
  step: WaitingStep,
  text: Text,
): { readonly title: string; readonly lead: string; readonly code?: string } => {
  const words = text.waiting;
  switch (step) {
    case "key":
      return { title: words.keyTitle, lead: words.keyLead };
    case "sign-in":
      return { title: words.signInTitle, lead: words.signInLead };
    case "connecting":
      return { title: words.connectingTitle, lead: words.connectingLead };
    case "approval":
      return { title: words.approvalTitle, lead: words.approvalLead };
  }
};

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
    case "network":
      return {
        title: page.networkTitle,
        lead: text.networkMissing,
        code: page.code.replace("{code}", String(problem.code)),
      };
    case "crashed":
      return { title: page.crashedTitle, lead: page.crashedLead };
  }
};
