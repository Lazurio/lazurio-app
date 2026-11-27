import { assert, describe, it } from "@effect/vitest";

import { allowedBy } from "./MacSelfUpdate.ts";

describe("a Mac build's own updates", () => {
  it("are on only for a build the release signed and marked", () => {
    assert.isTrue(allowedBy(JSON.stringify({ name: "lazurio-app", macSelfUpdate: true })));
    // An ad hoc build: no mark, another value, or a file that does not read.
    assert.isFalse(allowedBy(JSON.stringify({ name: "lazurio-app" })));
    assert.isFalse(allowedBy(JSON.stringify({ name: "lazurio-app", macSelfUpdate: "true" })));
    assert.isFalse(allowedBy("{"));
  });
});
