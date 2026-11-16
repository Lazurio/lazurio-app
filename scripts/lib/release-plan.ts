import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// What a run of the release workflow releases (docs/adr/0005, point 3), after T3 Code's
// release.yml and check-nightly-release.cjs. Pure: plan-release.ts reads GitHub and the clock.

const STABLE = /^\d+\.\d+\.\d+$/u;
const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+)-nightly\.\d{8}\.\d+$/u;
// At most one scheduled nightly every six hours, as T3 Code.
const MINIMUM_NIGHTLY_GAP_MS = 6 * 60 * 60 * 1000;

export interface PublishedRelease {
  readonly tag: string;
  readonly publishedAt: string;
}

export type ReleasePlan =
  | {
      readonly release: true;
      readonly channel: "nightly" | "stable";
      readonly version: string;
      // The commit the release builds: the run's commit for nightly, the latest nightly's for stable.
      readonly ref: string;
    }
  | { readonly release: false; readonly reason: string };

export class ReleasePlanError extends Schema.TaggedError<ReleasePlanError>()("ReleasePlanError", {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

const refuse = (problem: string) => Effect.fail(new ReleasePlanError({ problem }));

export const latestNightly = (
  releases: ReadonlyArray<PublishedRelease>,
): PublishedRelease | undefined =>
  releases
    .filter((release) => NIGHTLY_TAG.test(release.tag))
    .toSorted((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];

export const planNightly = Effect.fn("ReleasePlan.planNightly")(function* <E>(input: {
  readonly scheduled: boolean;
  readonly baseVersion: string;
  readonly releases: ReadonlyArray<PublishedRelease>;
  // The run's start, in milliseconds since the epoch and as its UTC date YYYYMMDD.
  readonly nowMs: number;
  readonly date: string;
  readonly runNumber: number;
  readonly sha: string;
  // Whether the run's commit is ahead of the latest nightly's tag; asked only on a schedule.
  readonly aheadOfLatestNightly: (tag: string) => Effect.Effect<boolean, E>;
}): Effect.fn.Return<ReleasePlan, ReleasePlanError | E> {
  if (!STABLE.test(input.baseVersion)) {
    return yield* refuse(`apps/desktop/package.json has no X.Y.Z version: ${input.baseVersion}`);
  }
  // A nightly of a version that is already stable would sort below that stable.
  if (input.releases.some((release) => release.tag === `v${input.baseVersion}`)) {
    return yield* refuse(
      `v${input.baseVersion} is already a stable release; raise apps/desktop/package.json first`,
    );
  }
  const latest = latestNightly(input.releases);
  if (input.scheduled && latest !== undefined) {
    if (input.nowMs - Date.parse(latest.publishedAt) < MINIMUM_NIGHTLY_GAP_MS) {
      return { release: false, reason: `${latest.tag} is less than six hours old` } as const;
    }
    if (!(yield* input.aheadOfLatestNightly(latest.tag))) {
      return { release: false, reason: `main has no commits since ${latest.tag}` } as const;
    }
  }
  return {
    release: true,
    channel: "nightly",
    version: `${input.baseVersion}-nightly.${input.date}.${input.runNumber}`,
    ref: input.sha,
  } as const;
});

export const planStable = Effect.fn("ReleasePlan.planStable")(function* <E>(input: {
  readonly releases: ReadonlyArray<PublishedRelease>;
  readonly commitOf: (tag: string) => Effect.Effect<string, E>;
  // The run's own commit. Stable runs on the latest nightly's tag, so that the update test, the
  // builds and their provenance all name the commit the release ships.
  readonly runSha: string;
}): Effect.fn.Return<ReleasePlan, ReleasePlanError | E> {
  const latest = latestNightly(input.releases);
  if (latest === undefined) {
    return yield* refuse("no published nightly: stable builds the latest nightly's commit");
  }
  const version = NIGHTLY_TAG.exec(latest.tag)?.[1];
  if (version === undefined) return yield* refuse(`cannot read a version from ${latest.tag}`);
  if (input.releases.some((release) => release.tag === `v${version}`)) {
    return yield* refuse(`v${version} is already released`);
  }
  const ref = yield* input.commitOf(latest.tag);
  if (ref !== input.runSha) {
    return yield* refuse(
      `stable runs on the latest nightly's tag: gh workflow run release.yml --ref ${latest.tag} -f channel=stable`,
    );
  }
  return { release: true, channel: "stable", version, ref } as const;
});
