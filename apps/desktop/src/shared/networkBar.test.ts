import { assert, describe, it } from "@effect/vitest";

import { networkBarStep, offersSignIn } from "./networkBar.ts";

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
    assert.isFalse(offersSignIn(empty));
    for (const tailnetSource of ["policy", "user-setting", "development"] as const) {
      assert.strictEqual(
        networkBarStep({ tailnetSource, account: "signed-out", networksNotRead: false }),
        "help",
      );
    }
  });
});
