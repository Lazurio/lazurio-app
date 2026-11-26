import { assert, describe, it } from "@effect/vitest";

import { networkBarSentence, networkBarStep, offersSignIn } from "./networkBar.ts";

describe("what the main window says without the Organization's network", () => {
  it("offers the account's sign-in at a first start, and again when the session lacks the scope", () => {
    const first = networkBarStep({
      tailnetSource: "built-in",
      account: "signed-out",
      networksNotRead: false,
    });
    assert.strictEqual(first, "sign-in");
    assert.isTrue(offersSignIn(first));
    assert.strictEqual(
      networkBarStep({
        tailnetSource: "built-in",
        account: "needs-sign-in",
        networksNotRead: false,
      }),
      "sign-in-again",
    );
  });

  it("says the read is under way, or failed with a sign-in to try again", () => {
    const reading = networkBarStep({
      tailnetSource: "built-in",
      account: "signed-in",
      networksNotRead: false,
    });
    assert.strictEqual(reading, "reading");
    assert.isFalse(offersSignIn(reading));
    assert.strictEqual(
      networkBarStep({ tailnetSource: "built-in", account: "signed-in", networksNotRead: true }),
      "not-read",
    );
  });

  it("says an account's list names no network, and leaves IT's policy and a setting to help", () => {
    const empty = networkBarStep({
      tailnetSource: "lazurio-auth",
      account: "signed-in",
      networksNotRead: false,
    });
    assert.strictEqual(empty, "empty");
    // Once the Admin added the person, a sign-in reads the list again.
    assert.isTrue(offersSignIn(empty));
    for (const tailnetSource of ["policy", "user-setting", "development"] as const) {
      assert.strictEqual(
        networkBarStep({ tailnetSource, account: "signed-out", networksNotRead: false }),
        "help",
      );
    }
  });

  it("lets a saved empty list recover: signed out, a session without the scope, a failed read", () => {
    const saved = { tailnetSource: "lazurio-auth" } as const;
    assert.strictEqual(
      networkBarStep({ ...saved, account: "signed-out", networksNotRead: false }),
      "sign-in",
    );
    assert.strictEqual(
      networkBarStep({ ...saved, account: "needs-sign-in", networksNotRead: false }),
      "sign-in-again",
    );
    assert.strictEqual(
      networkBarStep({ ...saved, account: "signed-in", networksNotRead: true }),
      "not-read",
    );
  });

  it("says the network is not set up only when the app joins none, never over a joined one", () => {
    // No network at all (a stable Windows build with only the built-in list): not set up.
    assert.strictEqual(networkBarSentence("sign-in", false), "not-set-up");
    // Lazurio Example joined (a Mac, a nightly): the sign-in brings the person's own networks.
    assert.strictEqual(networkBarSentence("sign-in", true), "own-networks");
    assert.strictEqual(networkBarSentence("sign-in-again", true), "own-networks");
    assert.strictEqual(networkBarSentence("reading", true), "reading");
    assert.strictEqual(networkBarSentence("empty", false), "empty");
  });
});
