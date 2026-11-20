import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { directoryOf, readMac, type MacPort, type PolicySource } from "./TailnetPolicy.ts";
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

// A Mac whose managed preference files exist or not, and whose programs answer as a test scripts.
const mac = (options: {
  readonly files: ReadonlyArray<string>;
  readonly answers: Record<string, { readonly output: string; readonly exitCode: number }>;
}) => {
  const ran: Array<string> = [];
  const port: MacPort<never, never> = {
    exists: (path) => Effect.succeed(options.files.includes(path)),
    run: (program, args) =>
      Effect.sync(() => {
        ran.push([program, ...args].join(" "));
        return options.answers[program] ?? { output: "", exitCode: 1 };
      }),
  };
  return { ran, port };
};

const ACCOUNT_POLICY = "/Library/Managed Preferences/klara/io.lazurio.app.plist";
const COMPUTER_POLICY = "/Library/Managed Preferences/io.lazurio.app.plist";

describe("TailnetPolicy.readMac", () => {
  it.effect(
    "reads the account's managed preference before the computer's, without its line break",
    () =>
      Effect.gen(function* () {
        const { ran, port } = mac({
          files: [ACCOUNT_POLICY, COMPUTER_POLICY],
          answers: { "/usr/bin/plutil": { output: `${entry("it")}\n`, exitCode: 0 } },
        });
        assert.deepStrictEqual(yield* readMac(port, "klara", "machine"), Option.some(entry("it")));
        assert.deepStrictEqual(ran, [
          `/usr/bin/plutil -extract Tailnets raw -o - ${ACCOUNT_POLICY}`,
        ]);
      }),
  );

  it.effect("reads the computer's managed preference when the account has none", () =>
    Effect.gen(function* () {
      const { ran, port } = mac({
        files: [COMPUTER_POLICY],
        answers: { "/usr/bin/plutil": { output: `${entry("it")}\n`, exitCode: 0 } },
      });
      assert.deepStrictEqual(yield* readMac(port, "klara", "machine"), Option.some(entry("it")));
      assert.deepStrictEqual(ran, [
        `/usr/bin/plutil -extract Tailnets raw -o - ${COMPUTER_POLICY}`,
      ]);
    }),
  );

  it.effect("has no policy without a managed preference file, and runs nothing", () =>
    Effect.gen(function* () {
      const { ran, port } = mac({ files: [], answers: {} });
      assert.isTrue(Option.isNone(yield* readMac(port, "klara", "machine")));
      assert.deepStrictEqual(ran, []);
    }),
  );

  // A managed preference without a string Tailnets keeps the person's setting unread.
  it.effect("fails on a managed preference file whose Tailnets cannot be read", () =>
    Effect.gen(function* () {
      const { port } = mac({
        files: [COMPUTER_POLICY],
        answers: { "/usr/bin/plutil": { output: "", exitCode: 1 } },
      });
      const result = yield* Effect.result(readMac(port, "klara", "machine"));
      assert.isTrue(Result.isFailure(result));
    }),
  );

  it.effect("reads the person's setting from their defaults", () =>
    Effect.gen(function* () {
      const { ran, port } = mac({
        files: [],
        answers: { "/usr/bin/defaults": { output: `${entry("person")}\n`, exitCode: 0 } },
      });
      assert.deepStrictEqual(yield* readMac(port, "klara", "user"), Option.some(entry("person")));
      assert.deepStrictEqual(ran, ["/usr/bin/defaults read io.lazurio.app Tailnets"]);
    }),
  );

  it.effect("has no setting when defaults has no such key, and fails on any other answer", () =>
    Effect.gen(function* () {
      const missing = mac({
        files: [],
        answers: { "/usr/bin/defaults": { output: "", exitCode: 1 } },
      });
      assert.isTrue(Option.isNone(yield* readMac(missing.port, "klara", "user")));
      const broken = mac({
        files: [],
        answers: { "/usr/bin/defaults": { output: "", exitCode: 2 } },
      });
      assert.isTrue(Result.isFailure(yield* Effect.result(readMac(broken.port, "klara", "user"))));
    }),
  );

  it.effect("lets a Mac's policy win over the person's setting, as on Windows", () =>
    Effect.gen(function* () {
      const { ran, port } = mac({
        files: [COMPUTER_POLICY],
        answers: {
          "/usr/bin/plutil": { output: `${entry("it")}\n`, exitCode: 0 },
          "/usr/bin/defaults": { output: `${entry("person")}\n`, exitCode: 0 },
        },
      });
      const chosen = yield* directoryOf(
        (source) => readMac(port, "klara", source),
        Effect.succeed(BUILT_IN),
        "Klaras-MacBook",
      );
      assert.strictEqual(chosen.source, "policy");
      assert.deepStrictEqual(tailnetsOf(chosen.directory), ["it"]);
      assert.isFalse(ran.some((line) => line.startsWith("/usr/bin/defaults")));
    }),
  );
});
