import { assert, describe, it } from "@effect/vitest";

import { messages } from "./messages.ts";
import { signInLabel } from "./networkSignIn.ts";

describe("the network bar's sign-in button", () => {
  it("never says again for a session that signed in for no network yet", () => {
    const words = messages.en;
    assert.strictEqual(signInLabel("sign-in", false, words), "Sign in with Lazurio");
    assert.strictEqual(signInLabel("sign-in-again", false, words), "Sign in with Lazurio");
    assert.strictEqual(signInLabel("not-read", false, words), "Try again");
    assert.strictEqual(signInLabel("sign-in", true, words), "Try again");
  });
});
