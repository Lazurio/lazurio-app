import { assert, describe, it } from "@effect/vitest";

import { environmentProblem } from "./release-environment.ts";

const APPROVER = 16311043;
const approver = { type: "User", id: APPROVER };
const protectedEnvironment = {
  exists: true,
  reviewers: [approver],
  deploymentPolicy: true,
  adminsCanBypass: false,
};

describe("environmentProblem", () => {
  // An administrator could otherwise start a waiting stable release without the approver.
  it("refuses stable when administrators may bypass its rules, or GitHub does not say", () => {
    for (const adminsCanBypass of [true, undefined]) {
      const environment = { ...protectedEnvironment, adminsCanBypass };
      assert.isString(environmentProblem("stable", environment, APPROVER));
    }
  });

  it("lets a protected Environment publish", () => {
    assert.isUndefined(environmentProblem("stable", protectedEnvironment, APPROVER));
    const nightly = { ...protectedEnvironment, reviewers: [] };
    assert.isUndefined(environmentProblem("nightly", nightly, APPROVER));
  });

  it("fails closed on a missing Environment, which GitHub would create unprotected", () => {
    for (const channel of ["stable", "nightly"] as const) {
      const missing = { ...protectedEnvironment, exists: false };
      assert.isString(environmentProblem(channel, missing, APPROVER));
    }
  });

  it("refuses any channel without a deployment policy", () => {
    for (const channel of ["stable", "nightly"] as const) {
      const open = { ...protectedEnvironment, deploymentPolicy: false };
      assert.isString(environmentProblem(channel, open, APPROVER));
    }
  });

  // GitHub accepts the approval of any one required reviewer.
  it("refuses stable unless the stable approver is its only required reviewer", () => {
    for (const reviewers of [
      [],
      [{ type: "User", id: 1 }],
      [approver, { type: "User", id: 1 }],
      [{ type: "Team", id: APPROVER }],
      [approver, { type: "Team", id: 7 }],
    ]) {
      const environment = { ...protectedEnvironment, reviewers };
      assert.isString(
        environmentProblem("stable", environment, APPROVER),
        JSON.stringify(reviewers),
      );
    }
  });
});
