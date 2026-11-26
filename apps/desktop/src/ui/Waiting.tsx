import { useState } from "react";

import { offersSignIn } from "../shared/networkBar.ts";
import { problemOf, reasonOf, servingTailnetOf, type PageProblem } from "../shared/pageProblem.ts";
import { waitingStepFor, type WaitingStep } from "../shared/waitingStep.ts";
import { localeOf, messages, type Text } from "./messages.ts";
import { useNetworkSignIn } from "./networkSignIn.ts";

// What the window shows in the remote page's place while it cannot show (MainWindow.ts): why its
// load failed, or, waiting for the tailnet that serves the page, the step the person is at with it
// (shared/waitingStep.ts), and a button that opens its sign-in again. Retry loads the page again.
// Without the Organization's network it offers the sign-in with the Lazurio account first.
export function Waiting() {
  const text = messages[localeOf(navigator.language)];
  const problem = problemOf(location.search);
  const served = servingTailnetOf(location.search);
  const [retrying, setRetrying] = useState(false);
  const network = useNetworkSignIn();
  // Unknown until the app answers: a page that waits for a tailnet says nothing until then, so it
  // never shows a general sentence for a moment before the step (it loads again on every attempt).
  const tailnets = network.status?.tailnets;
  const waitsForTailnet = problem === undefined || problem.kind === "waiting";
  if (waitsForTailnet && tailnets === undefined) {
    return <main className="waiting" data-problem={problem?.kind ?? "waiting"} aria-busy="true" />;
  }
  const step =
    waitsForTailnet && tailnets !== undefined ? waitingStepFor(tailnets, served) : undefined;
  const signs =
    problem?.kind === "network" && network.step !== undefined && offersSignIn(network.step);
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
      {step === "unreachable" ? <p>{text.waiting.unreachableAfter}</p> : null}
      {problem === undefined ||
      problem.kind === "waiting" ||
      problem.kind === "browser" ||
      problem.kind === "network" ? null : (
        <p>{text.page.persists}</p>
      )}
      {words.code === undefined ? null : <p className="waiting__code">{words.code}</p>}
      {signs && network.failed ? <p role="alert">{text.networksSignInFailed}</p> : null}
      <div className="waiting__actions">
        {step === "sign-in" && served !== undefined ? (
          <button
            type="button"
            data-action="tailnet-sign-in-again"
            onClick={() => void window.lazurio.openTailnetSignIn(served)}
          >
            {text.waiting.signInAgain}
          </button>
        ) : null}
        {signs ? (
          <button
            type="button"
            data-action="networks-sign-in"
            disabled={network.signingIn}
            onClick={network.signIn}
          >
            {network.signingIn ? text.networkBarSteps.signingIn : text.networksSignIn}
          </button>
        ) : null}
        <button
          type="button"
          className={step === "sign-in" || signs ? "waiting__secondary" : undefined}
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
    case "key-unopened":
      return { title: words.keyTitle, lead: words.keyUnopenedLead };
    case "key":
      return { title: words.keyTitle, lead: words.keyLead };
    case "sign-in":
      return { title: words.signInTitle, lead: words.signInLead };
    case "connecting":
      return { title: words.connectingTitle, lead: words.connectingLead };
    case "unreachable":
      return { title: words.unreachableTitle, lead: words.unreachableLead };
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
