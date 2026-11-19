import { assert, describe, it } from "@effect/vitest";

import { problemOf, problemQuery, reasonOf, type PageProblem } from "./pageProblem.ts";

describe("pageProblem", () => {
  it("reads back every problem from the address it writes", () => {
    const problems: ReadonlyArray<PageProblem> = [
      { kind: "waiting", code: -111, host: "launchpad.ada.example-org.lazurio.io" },
      { kind: "failed", code: -324, host: "launchpad.ada.example-org.lazurio.io" },
      { kind: "proxy", host: "launchpad.ada.example-org.lazurio.io" },
      { kind: "refused", host: "evil.example" },
      { kind: "browser", host: "docs.example" },
      { kind: "crashed" },
    ];
    for (const problem of problems)
      assert.deepStrictEqual(problemOf(problemQuery(problem)), problem);
  });

  it("finds no problem in an address without one, or with a code that is not a number", () => {
    assert.isUndefined(problemOf(""));
    assert.isUndefined(problemOf("?problem=other"));
    assert.isUndefined(problemOf("?problem=failed&code=x"));
  });

  it("words a failed load by its network error", () => {
    assert.strictEqual(reasonOf(-202), "certificate");
    assert.strictEqual(reasonOf(-111), "connection");
    assert.strictEqual(reasonOf(-324), "connection");
    assert.strictEqual(reasonOf(-310), "redirects");
    assert.strictEqual(reasonOf(-105), "not-found");
    assert.strictEqual(reasonOf(-118), "timeout");
    assert.strictEqual(reasonOf(-20), "other");
  });
});
