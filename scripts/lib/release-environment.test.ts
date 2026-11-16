import { assert, describe, it } from "@effect/vitest";

import { environmentProblem } from "./release-environment.ts";

const protectedEnvironment = { exists: true, reviewers: 1, deploymentPolicy: true };

describe("environmentProblem", () => {
  it("lets a protected Environment publish", () => {
    assert.isUndefined(environmentProblem("stable", protectedEnvironment));
    assert.isUndefined(environmentProblem("nightly", { ...protectedEnvironment, reviewers: 0 }));
  });

  it("fails closed on a missing Environment, which GitHub would create unprotected", () => {
    for (const channel of ["stable", "nightly"] as const) {
      assert.isString(environmentProblem(channel, { ...protectedEnvironment, exists: false }));
    }
  });

  it("refuses stable without a required reviewer and any channel without a deployment policy", () => {
    assert.isString(environmentProblem("stable", { ...protectedEnvironment, reviewers: 0 }));
    for (const channel of ["stable", "nightly"] as const) {
      const open = { ...protectedEnvironment, deploymentPolicy: false };
      assert.isString(environmentProblem(channel, open));
    }
  });
});
