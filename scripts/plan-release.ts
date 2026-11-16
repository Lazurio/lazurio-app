// Decides what a run of the release workflow releases (docs/adr/0005, point 3) and appends
// release, channel, version, tag, ref and prerelease to $GITHUB_OUTPUT. Inputs: RELEASE_EVENT,
// RELEASE_CHANNEL and GitHub's own variables; GitHub's answers go through Schema.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { planNightly, planStable, type ReleasePlan } from "./lib/release-plan.ts";

const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    published_at: Schema.NullOr(Schema.String),
  }),
);
const decodeReleases = Schema.decodeUnknownEffect(Releases);
const decodeComparison = Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }));
const decodeCommit = Schema.decodeUnknownEffect(Schema.Struct({ sha: Schema.String }));
const decodeDesktopPackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

class NotFromMain extends Schema.TaggedError<NotFromMain>()("NotFromMain", { ref: Schema.String }) {
  override get message(): string {
    return `a nightly runs from main, not from ${this.ref}`;
  }
}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const event = yield* Config.String("RELEASE_EVENT");
  const channel = yield* Config.Literals(["nightly", "stable"], "RELEASE_CHANNEL");
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const sha = yield* Config.String("GITHUB_SHA");
  const ref = yield* Config.String("GITHUB_REF");
  const runNumber = yield* Config.Int("GITHUB_RUN_NUMBER");
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const output = yield* Config.String("GITHUB_OUTPUT");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const get = (apiPath: string) =>
    client
      .execute(
        HttpClientRequest.get(`https://api.github.com/repos/${repository}${apiPath}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
        ),
      )
      .pipe(Effect.flatMap((response) => response.json));

  const releases = (yield* get("/releases?per_page=100").pipe(Effect.flatMap(decodeReleases)))
    .filter((release) => !release.draft && release.published_at !== null)
    .map((release) => ({ tag: release.tag_name, publishedAt: release.published_at ?? "" }));

  // Nightly runs from main; stable runs on the latest nightly's tag (planStable).
  if (channel === "nightly" && ref !== "refs/heads/main") {
    return yield* new NotFromMain({ ref });
  }
  const now = yield* DateTime.now;
  const plan: ReleasePlan =
    channel === "nightly"
      ? yield* planNightly({
          scheduled: event === "schedule",
          baseVersion: (yield* decodeDesktopPackage(
            yield* fileSystem.readFileString(
              path.join(import.meta.dirname, "..", "apps", "desktop", "package.json"),
            ),
          )).version,
          releases,
          nowMs: DateTime.toEpochMillis(now),
          date: DateTime.formatIso(now).slice(0, 10).replaceAll("-", ""),
          runNumber,
          sha,
          aheadOfLatestNightly: (tag) =>
            get(`/compare/${tag}...${sha}`).pipe(
              Effect.flatMap(decodeComparison),
              Effect.map((comparison) => comparison.status === "ahead"),
            ),
        })
      : yield* planStable({
          releases,
          runSha: sha,
          commitOf: (tag) =>
            get(`/commits/${tag}`).pipe(
              Effect.flatMap(decodeCommit),
              Effect.map((commit) => commit.sha),
            ),
        });

  const lines = plan.release
    ? [
        "release=true",
        `channel=${plan.channel}`,
        `version=${plan.version}`,
        `tag=v${plan.version}`,
        `ref=${plan.ref}`,
        `prerelease=${plan.channel === "nightly"}`,
      ]
    : ["release=false"];
  yield* Effect.logInfo(
    plan.release
      ? `release ${plan.channel} v${plan.version} from ${plan.ref}`
      : `no release: ${plan.reason}`,
  );
  yield* fileSystem.writeFileString(output, `${lines.join("\n")}\n`, { flag: "a" });
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
