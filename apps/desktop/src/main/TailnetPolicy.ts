import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TailnetDirectory from "./TailnetDirectory.ts";

// The tailnets an Organization's IT sets on its Windows computers until the directory at Lazurio
// Auth exists (docs/adr/0008, point 6). The app's own tailnet helper reads the machine policy
// through the registry's API (`lazurio-tailnet read-policy`), so neither the path nor the
// environment chooses the program that answers.

class PolicyReadError extends Schema.TaggedError<PolicyReadError>()("PolicyReadError", {
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `the tailnet helper could not read the policy (exit code ${this.exitCode})`;
  }
}

// The helper's exit codes for read-policy (helpers/tailnet/policy.go).
const EXIT_POLICY = 0;
const EXIT_NO_POLICY = 3;

// Where the text comes from: IT's machine policy (HKLM), or until the directory at Lazurio Auth
// serves a person without an administrator, the person's own setting of the same shape (HKCU).
export type PolicySource = "machine" | "user";

// The policy's text on this computer, or none when IT (or the person) set none.
export const readWindows = Effect.fn("TailnetPolicy.readWindows")(function* (
  helperPath: string,
  source: PolicySource = "machine",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(helperPath, [source === "machine" ? "read-policy" : "read-user-setting"], {
      stderr: "ignore",
    }),
  );
  const [output, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      ),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode === EXIT_POLICY) return Option.some(output);
  if (exitCode === EXIT_NO_POLICY) return Option.none<string>();
  return yield* new PolicyReadError({ exitCode });
}, Effect.scoped);

// Which text a packaged app on Windows takes its tailnets from: IT's policy when the helper
// confirms one; the person's setting only when the helper confirms that there is no policy; never
// the setting when the policy cannot be read, which joins the built-in directory as before.
const choose = Effect.fn("TailnetPolicy.choose")(function* <E, R>(
  read: (source: PolicySource) => Effect.Effect<Option.Option<string>, E, R>,
) {
  const machine = yield* Effect.result(read("machine"));
  if (Result.isFailure(machine)) {
    yield* Effect.logWarning("cannot read the tailnet policy", machine.failure);
    return Option.none<{ readonly source: "policy" | "user-setting"; readonly text: string }>();
  }
  if (Option.isSome(machine.success)) {
    return Option.some({ source: "policy" as const, text: machine.success.value });
  }
  const user = yield* Effect.result(read("user"));
  if (Result.isFailure(user)) {
    yield* Effect.logWarning("cannot read the tailnet setting", user.failure);
    return Option.none();
  }
  return Option.map(user.success, (text) => ({ source: "user-setting" as const, text }));
});

// The tailnets of a packaged app on Windows: the chosen text's, or the built-in directory's. A
// chosen text that does not decode joins nothing, rather than the built-in directory.
export const directoryOf = Effect.fn("TailnetPolicy.directoryOf")(function* <E, R, F, S>(
  read: (source: PolicySource) => Effect.Effect<Option.Option<string>, E, R>,
  builtIn: Effect.Effect<TailnetDirectory.Directory, F, S>,
  computer: string,
) {
  const chosen = yield* choose(read);
  if (Option.isNone(chosen)) {
    return { source: "built-in" as const, text: Option.none<string>(), directory: yield* builtIn };
  }
  const { source, text } = chosen.value;
  const directory = yield* TailnetDirectory.fromText(text, computer).pipe(
    Effect.tapError((error) =>
      Effect.logError("the tailnet policy does not decode", { source, error }),
    ),
    Effect.orElseSucceed((): TailnetDirectory.Directory => ({ tailnets: [], refused: [] })),
  );
  return { source, text: Option.some(text), directory };
});

// The chosen text now, policy or the person's setting, and whether it names any network to join:
// what SettingWatch reads again while the app runs (#81).
export const settingNow = Effect.fn("TailnetPolicy.settingNow")(function* <E, R>(
  read: (source: PolicySource) => Effect.Effect<Option.Option<string>, E, R>,
  computer: string,
) {
  const chosen = yield* choose(read);
  if (Option.isNone(chosen)) return { text: Option.none<string>(), joinsAny: false };
  const joinsAny = yield* TailnetDirectory.fromText(chosen.value.text, computer).pipe(
    Effect.map((directory) => directory.tailnets.length > 0),
    Effect.orElseSucceed(() => false),
  );
  return { text: Option.some(chosen.value.text), joinsAny };
});
