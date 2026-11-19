import { assert, describe, it } from "@effect/vitest";

import { withAppToken } from "./UserAgent.ts";

describe("UserAgent", () => {
  it("keeps a user agent that already has the app's token", () => {
    const electron =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LazurioApp/0.1.2 Chrome/152.0.7977.169 Electron/44.10.1 Safari/537.36";
    assert.strictEqual(withAppToken(electron, "0.1.2"), electron);
  });

  it("adds the token when the product's name is another", () => {
    assert.strictEqual(
      withAppToken("Mozilla/5.0 Other/0.1.2 Chrome/152", "0.1.2"),
      "Mozilla/5.0 Other/0.1.2 Chrome/152 LazurioApp/0.1.2",
    );
  });
});
