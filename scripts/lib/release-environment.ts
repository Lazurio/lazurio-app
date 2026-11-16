// Whether a release Environment protects its publication (docs/adr/0005, point 3). GitHub creates
// an unknown Environment without protection when a job names it, so the release workflow checks
// first and fails closed: stable needs a required reviewer, and both channels a deployment policy.

export interface EnvironmentFacts {
  readonly exists: boolean;
  readonly reviewers: number;
  readonly deploymentPolicy: boolean;
}

export const environmentProblem = (
  channel: "nightly" | "stable",
  facts: EnvironmentFacts,
): string | undefined => {
  const name = `lazurio-app-${channel}`;
  if (!facts.exists) return `the Environment ${name} does not exist`;
  if (!facts.deploymentPolicy) return `the Environment ${name} allows deployments from any ref`;
  if (channel === "stable" && facts.reviewers === 0) {
    return `the Environment ${name} has no required reviewer`;
  }
  return undefined;
};
