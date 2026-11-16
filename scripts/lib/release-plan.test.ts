import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { latestNightly, planNightly, planStable } from "./release-plan.ts";

const NOW = Date.parse("2026-11-16T03:08:00Z");
// Release dates as GitHub gives them, a number of hours before NOW.
const HOURS_AGO: Readonly<Record<number, string>> = {
  0: "2026-11-16T03:08:00Z",
  1: "2026-11-16T02:08:00Z",
  2: "2026-11-16T01:08:00Z",
  5: "2026-11-15T22:08:00Z",
  7: "2026-11-15T20:08:00Z",
  20: "2026-11-15T07:08:00Z",
  30: "2026-11-14T21:08:00Z",
  100: "2026-11-12T03:08:00Z",
};
const hoursAgo = (hours: number): string => HOURS_AGO[hours] ?? "";
const nightly = (base = "0.1.0") => ({
  scheduled: true,
  baseVersion: base,
  nowMs: NOW,
  date: "20261116",
  runNumber: 42,
  sha: "a".repeat(40),
  aheadOfLatestNightly: () => Effect.succeed(true),
});

describe("planNightly", () => {
  it.effect("releases the first nightly with T3 Code's version shape", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planNightly({ ...nightly(), releases: [] }), {
        release: true,
        channel: "nightly",
        version: "0.1.0-nightly.20261116.42",
        ref: "a".repeat(40),
      });
    }),
  );

  it.effect("waits six hours after the latest nightly on a schedule", () =>
    Effect.gen(function* () {
      const recent = [{ tag: "v0.1.0-nightly.20261115.40", publishedAt: hoursAgo(5) }];
      assert.isFalse((yield* planNightly({ ...nightly(), releases: recent })).release);
      const older = [{ tag: "v0.1.0-nightly.20261115.30", publishedAt: hoursAgo(7) }];
      assert.isTrue((yield* planNightly({ ...nightly(), releases: older })).release);
    }),
  );

  it.effect("skips a schedule without new commits, but not a run by hand", () =>
    Effect.gen(function* () {
      const releases = [{ tag: "v0.1.0-nightly.20261115.30", publishedAt: hoursAgo(7) }];
      const quiet = { ...nightly(), releases, aheadOfLatestNightly: () => Effect.succeed(false) };
      assert.isFalse((yield* planNightly(quiet)).release);
      assert.isTrue((yield* planNightly({ ...quiet, scheduled: false })).release);
    }),
  );

  it.effect("refuses a base version that is already stable, or that is no X.Y.Z", () =>
    Effect.gen(function* () {
      const releases = [{ tag: "v0.1.0", publishedAt: hoursAgo(30) }];
      const stable = yield* planNightly({ ...nightly(), releases }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stable));
      const beta = yield* planNightly({ ...nightly("0.1.0-beta.1"), releases: [] }).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(beta));
    }),
  );
});

describe("planStable", () => {
  const releases = [
    { tag: "v0.1.0-nightly.20261115.30", publishedAt: hoursAgo(20) },
    { tag: "v0.1.0-nightly.20261116.41", publishedAt: hoursAgo(2) },
    { tag: "v0.0.9", publishedAt: hoursAgo(100) },
  ];
  const commitOf = (tag: string) => Effect.succeed(`commit of ${tag}`);
  const runSha = "commit of v0.1.0-nightly.20261116.41";

  it.effect("promotes the latest nightly's commit under its version", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planStable({ releases, commitOf, runSha }), {
        release: true,
        channel: "stable",
        version: "0.1.0",
        ref: "commit of v0.1.0-nightly.20261116.41",
      });
    }),
  );

  // main ahead of the nightly: a run from main would test and attest another commit.
  it.effect("refuses to run anywhere but on the latest nightly's commit", () =>
    Effect.gen(function* () {
      const fromMain = planStable({ releases, commitOf, runSha: "commit of main, ahead" });
      assert.isTrue(Exit.isFailure(yield* fromMain.pipe(Effect.exit)));
    }),
  );

  it.effect("refuses without a nightly, or when that version is already stable", () =>
    Effect.gen(function* () {
      const none = yield* planStable({ releases: [], commitOf, runSha }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(none));
      const done = [...releases, { tag: "v0.1.0", publishedAt: hoursAgo(1) }];
      const again = yield* planStable({ releases: done, commitOf, runSha }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(again));
    }),
  );
});

describe("latestNightly", () => {
  it("picks the newest published nightly and ignores other tags", () => {
    const latest = latestNightly([
      { tag: "v0.1.0", publishedAt: hoursAgo(0) },
      { tag: "v0.1.0-nightly.20261115.30", publishedAt: hoursAgo(20) },
      { tag: "v0.2.0-nightly.20261116.41", publishedAt: hoursAgo(2) },
    ]);
    assert.strictEqual(latest?.tag, "v0.2.0-nightly.20261116.41");
  });
});
