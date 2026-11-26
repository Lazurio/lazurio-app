import { assert, describe, it } from "@effect/vitest";

import type { TailnetStatus } from "./bridge.ts";
import { waitingStep } from "./waitingStep.ts";

const running: TailnetStatus = { tailnet: "a", state: "running", addresses: ["100.64.0.2"] };
const signIn: TailnetStatus = { tailnet: "b", state: "needs-login", canCopySignIn: true };
const starting: TailnetStatus = { tailnet: "c", state: "starting" };
const keyDenied: TailnetStatus = {
  tailnet: "d",
  state: "stopped",
  problem: "the key did not open",
  reason: "key-unreadable",
};

describe("the step the waiting page names", () => {
  it("names the step the person is at, the one to act on first", () => {
    assert.strictEqual(waitingStep([running, signIn, keyDenied]), "key");
    assert.strictEqual(waitingStep([running, signIn, starting]), "sign-in");
    assert.strictEqual(waitingStep([running, starting]), "connecting");
    // The network runs and the Environment still cannot be reached: the approval is what is left.
    assert.strictEqual(waitingStep([running]), "approval");
  });

  it("names none without a network, or for a stop the person cannot act on", () => {
    assert.isUndefined(waitingStep([]));
    assert.isUndefined(
      waitingStep([{ tailnet: "e", state: "stopped", problem: "the helper ended" }]),
    );
  });
});
