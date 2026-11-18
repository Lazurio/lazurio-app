import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { directoryOf, type PolicySource } from "./TailnetPolicy.ts";
import type { Directory } from "./TailnetDirectory.ts";

class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {}) {}

const entry = (name: string) =>
  `[{"tailnet":"${name}","controlUrl":"https://headscale.${name}.lazurio.io","domains":["${name}.lazurio.io"]}]`;
const BUILT_IN: Directory = {
  tailnets: [
    {
      tailnet: "built-in",
      controlUrl: "https://headscale.built-in.lazurio.io",
      hostname: "lazurio-app-desktop-1",
      domains: ["built-in.lazurio.io"],
    },
  ],
  refused: [],
};

// What the helper answers for each source: a text, none (exit 3) or a failure (exit 4); and which
// sources the app asked.
const reader = (answers: Record<PolicySource, Option.Option<string> | "fails">) => {
  const asked: Array<PolicySource> = [];
  const read = (source: PolicySource) =>
    Effect.suspend(() => {
      asked.push(source);
      const answer = answers[source];
      return answer === "fails" ? Effect.fail(new ReadFailed()) : Effect.succeed(answer);
    });
  return { asked, read };
};

const tailnetsOf = (directory: Directory) => directory.tailnets.map((tailnet) => tailnet.tailnet);

describe("TailnetPolicy.directoryOf", () => {
  it.effect("takes the person's setting only where the helper confirms there is no policy", () =>
    Effect.gen(function* () {
      const { asked, read } = reader({
        machine: Option.none(),
        user: Option.some(entry("person")),
      });
      const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
      assert.strictEqual(chosen.source, "user-setting");
      assert.deepStrictEqual(tailnetsOf(chosen.directory), ["person"]);
      assert.deepStrictEqual(asked, ["machine", "user"]);
    }),
  );

  it.effect("lets IT's policy win over the person's setting, which it does not read", () =>
    Effect.gen(function* () {
      const { asked, read } = reader({
        machine: Option.some(entry("it")),
        user: Option.some(entry("person")),
      });
      const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
      assert.strictEqual(chosen.source, "policy");
      assert.deepStrictEqual(tailnetsOf(chosen.directory), ["it"]);
      assert.deepStrictEqual(asked, ["machine"]);
    }),
  );

  it.effect("never takes the person's setting when the policy cannot be read", () =>
    Effect.gen(function* () {
      const { asked, read } = reader({ machine: "fails", user: Option.some(entry("person")) });
      const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
      assert.strictEqual(chosen.source, "built-in");
      assert.deepStrictEqual(tailnetsOf(chosen.directory), ["built-in"]);
      assert.deepStrictEqual(asked, ["machine"]);
    }),
  );

  it.effect("joins nothing for a setting that does not decode, rather than the built-in list", () =>
    Effect.gen(function* () {
      for (const text of ["not json", '{"tailnet":"person"}', "[1]"]) {
        const { read } = reader({ machine: Option.none(), user: Option.some(text) });
        const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
        assert.strictEqual(chosen.source, "user-setting");
        assert.deepStrictEqual(chosen.directory, { tailnets: [], refused: [] });
      }
    }),
  );

  it.effect("refuses a setting's entry outside Lazurio's domains, as for the policy", () =>
    Effect.gen(function* () {
      const outside = `[{"tailnet":"person","controlUrl":"https://headscale.example.com","domains":["example.com"]}]`;
      const { read } = reader({ machine: Option.none(), user: Option.some(outside) });
      const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
      assert.deepStrictEqual(tailnetsOf(chosen.directory), []);
      assert.strictEqual(chosen.directory.refused.length, 1);
    }),
  );

  it.effect(
    "joins the built-in list with neither a policy nor a setting, or an unread setting",
    () =>
      Effect.gen(function* () {
        for (const user of [Option.none<string>(), "fails" as const]) {
          const { read } = reader({ machine: Option.none(), user });
          const chosen = yield* directoryOf(read, Effect.succeed(BUILT_IN), "Desktop-1");
          assert.strictEqual(chosen.source, "built-in");
          assert.deepStrictEqual(tailnetsOf(chosen.directory), ["built-in"]);
        }
      }),
  );
});
