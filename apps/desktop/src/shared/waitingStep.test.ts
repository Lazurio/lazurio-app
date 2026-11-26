import { assert, describe, it } from "@effect/vitest";

import type { TailnetStatus } from "./bridge.ts";
import { waitingStep, waitingStepFor } from "./waitingStep.ts";

const running: TailnetStatus = { tailnet: "a", state: "running", addresses: ["100.64.0.2"] };
const signIn: TailnetStatus = { tailnet: "b", state: "needs-login", canCopySignIn: true };
const starting: TailnetStatus = { tailnet: "c", state: "starting" };
const keyDenied: TailnetStatus = {
  tailnet: "d",
  state: "stopped",
  problem: "the key did not open",
  reason: "key-unreadable",
};
const keyNotSaved: TailnetStatus = {
  tailnet: "e",
  state: "stopped",
  problem: "its sealed key cannot be written",
  reason: "key-not-saved",
  files: { keyFile: "/k/e.key", stateDirectory: "/k/e" },
};

describe("the step the waiting page names", () => {
  it("names the step of the page's own tailnet", () => {
    assert.strictEqual(waitingStep(keyDenied), "key-unopened");
    // A key that was not saved, or state that cannot be read, is not a key the system refused.
    assert.strictEqual(waitingStep(keyNotSaved), "key");
    assert.strictEqual(waitingStep(signIn), "sign-in");
    assert.strictEqual(waitingStep(starting), "connecting");
    // The network runs and the Environment does not answer: not approved yet, or not running.
    assert.strictEqual(waitingStep(running), "unreachable");
  });

  it("names none without the tailnet's status, or for a stop the person cannot act on", () => {
    assert.isUndefined(waitingStep(undefined));
    assert.isUndefined(
      waitingStep({ tailnet: "f", state: "stopped", problem: "the helper ended" }),
    );
  });

  it("never lets another Organization's network stand in for the page's own", () => {
    const all = [running, signIn, starting, keyDenied, keyNotSaved];
    // The page's network runs while others wait for a sign-in or have a key problem.
    assert.strictEqual(waitingStepFor(all, "a"), "unreachable");
    assert.strictEqual(waitingStepFor(all, "b"), "sign-in");
    assert.strictEqual(waitingStepFor(all, "c"), "connecting");
    assert.strictEqual(waitingStepFor(all, "d"), "key-unopened");
    // A page no tailnet serves, or a tailnet without status yet, names no step.
    assert.isUndefined(waitingStepFor(all, undefined));
    assert.isUndefined(waitingStepFor(all, "unknown"));
  });
});
