// Whether a release Environment protects its publication (docs/adr/0005, point 3). GitHub creates
// an unknown Environment without protection when a job names it, and accepts the approval of any
// one required reviewer and lets administrators bypass the rules by default, so the release
// workflow checks first and fails closed: stable needs the stable approver as its only required
// reviewer and no bypass for administrators, and both channels a deployment policy.

interface EnvironmentReviewer {
  readonly type: string;
  readonly id: number;
}

export interface EnvironmentFacts {
  readonly exists: boolean;
  readonly reviewers: ReadonlyArray<EnvironmentReviewer>;
  readonly deploymentPolicy: boolean;
  // Undefined when GitHub does not say, which counts as a bypass.
  readonly adminsCanBypass: boolean | undefined;
}

export const environmentProblem = (
  channel: "nightly" | "stable",
  facts: EnvironmentFacts,
  // The GitHub user id whose go-ahead a stable release needs (Matěj's, until he says otherwise).
  stableApprover: number,
): string | undefined => {
  const name = `lazurio-app-${channel}`;
  if (!facts.exists) return `the Environment ${name} does not exist`;
  if (!facts.deploymentPolicy) return `the Environment ${name} allows deployments from any ref`;
  if (channel === "stable") {
    const onlyApprover =
      facts.reviewers.length === 1 &&
      facts.reviewers[0]?.type === "User" &&
      facts.reviewers[0].id === stableApprover;
    if (!onlyApprover) {
      return `the Environment ${name} must have exactly one required reviewer, the user ${stableApprover}`;
    }
    if (facts.adminsCanBypass !== false) {
      return `the Environment ${name} must not let administrators bypass its protection rules`;
    }
  }
  return undefined;
};
