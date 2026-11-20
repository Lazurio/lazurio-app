import { assert, describe, it } from "@effect/vitest";

import { viewOf } from "./view.ts";

describe("viewOf", () => {
  it("picks the view of a local page by its query, and the column otherwise", () => {
    assert.strictEqual(viewOf("", ""), "column");
    assert.strictEqual(viewOf("?view=agent-bar", ""), "agent-bar");
    assert.strictEqual(viewOf("?view=agent-desktop", ""), "agent-desktop");
    assert.strictEqual(
      viewOf("?view=agent-desktop-fixtures&state=empty", ""),
      "agent-desktop-fixtures",
    );
    assert.strictEqual(viewOf("", "#waiting"), "waiting");
  });

  it("takes an unknown view as the column", () => {
    assert.strictEqual(viewOf("?view=elsewhere", ""), "column");
    assert.strictEqual(viewOf("?view=", ""), "column");
  });
});
