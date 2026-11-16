// Fails unless the release Environment of RELEASE_CHANNEL protects its publication
// (lib/release-environment.ts). Reads GitHub's API through HttpClient and Schema.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { environmentProblem } from "./lib/release-environment.ts";

const Environments = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      protection_rules: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          reviewers: Schema.optional(
            Schema.Array(
              Schema.Struct({
                type: Schema.String,
                reviewer: Schema.Struct({ id: Schema.Number }),
              }),
            ),
          ),
        }),
      ),
      deployment_branch_policy: Schema.NullOr(Schema.Unknown),
      can_admins_bypass: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeEnvironments = Schema.decodeUnknownEffect(Environments);

class UnprotectedEnvironment extends Schema.TaggedError<UnprotectedEnvironment>()(
  "UnprotectedEnvironment",
  { problem: Schema.String },
) {
  override get message(): string {
    return `${this.problem}; nothing is published until it is set up (docs/adr/0005, point 3)`;
  }
}

const program = Effect.gen(function* () {
  const channel = yield* Config.Literals(["nightly", "stable"], "RELEASE_CHANNEL");
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const stableApprover = yield* Config.Int("RELEASE_STABLE_APPROVER_ID");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const listed = yield* client
    .execute(
      HttpClientRequest.get(
        `https://api.github.com/repos/${repository}/environments?per_page=100`,
      ).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
      ),
    )
    .pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeEnvironments),
    );
  const environment = listed.environments.find((item) => item.name === `lazurio-app-${channel}`);
  const problem = environmentProblem(
    channel,
    {
      exists: environment !== undefined,
      reviewers: (environment?.protection_rules ?? [])
        .filter((rule) => rule.type === "required_reviewers")
        .flatMap((rule) => rule.reviewers ?? [])
        .map((entry) => ({ type: entry.type, id: entry.reviewer.id })),
      deploymentPolicy: environment?.deployment_branch_policy != null,
      adminsCanBypass: environment?.can_admins_bypass,
    },
    stableApprover,
  );
  if (problem !== undefined) return yield* new UnprotectedEnvironment({ problem });
  yield* Effect.logInfo(`the Environment lazurio-app-${channel} protects the release`);
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
