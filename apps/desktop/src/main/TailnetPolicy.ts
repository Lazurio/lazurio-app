import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
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

// The same on a Mac (#36, 2026-11-20), through system programs at fixed paths. IT's policy is a
// managed preference of io.lazurio.app under /Library/Managed Preferences, which only an
// administrator writes; the person's setting is the same key in their own defaults.
const MAC_DOMAIN = "io.lazurio.app";
const MAC_KEY = "Tailnets";
const MANAGED_PREFERENCES = "/Library/Managed Preferences";

// What readMac needs from the system, so that its decisions are unit-tested.
export interface MacPort<E, R> {
  readonly exists: (path: string) => Effect.Effect<boolean, E, R>;
  readonly run: (
    program: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly output: string; readonly exitCode: number }, E, R>;
}

class MacReadError extends Schema.TaggedError<MacReadError>()("MacReadError", {
  program: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `${this.program} could not read the tailnet setting (exit code ${this.exitCode})`;
  }
}

// Both programs end their answer with one line break.
const withoutLineBreak = (output: string): string => output.replace(/\r?\n$/u, "");

// The policy's text on this Mac, the one for this account first, or the person's setting; none
// when there is none. A policy file without a readable string Tailnets is a failure, never an
// absence, so the person's setting stays unread (as a policy of another type on Windows).
export const readMac = Effect.fn("TailnetPolicy.readMac")(function* <E, R>(
  port: MacPort<E, R>,
  account: string,
  source: PolicySource,
) {
  if (source === "machine") {
    for (const file of [
      `${MANAGED_PREFERENCES}/${account}/${MAC_DOMAIN}.plist`,
      `${MANAGED_PREFERENCES}/${MAC_DOMAIN}.plist`,
    ]) {
      if (!(yield* port.exists(file))) continue;
      const answer = yield* port.run("/usr/bin/plutil", [
        "-extract",
        MAC_KEY,
        "raw",
        "-o",
        "-",
        file,
      ]);
      if (answer.exitCode !== 0) {
        return yield* new MacReadError({ program: "plutil", exitCode: answer.exitCode });
      }
      return Option.some(withoutLineBreak(answer.output));
    }
    return Option.none<string>();
  }
  // `defaults read` ends with 1 when the domain or the key does not exist.
  const answer = yield* port.run("/usr/bin/defaults", ["read", MAC_DOMAIN, MAC_KEY]);
  if (answer.exitCode === 1) return Option.none<string>();
  if (answer.exitCode !== 0) {
    return yield* new MacReadError({ program: "defaults", exitCode: answer.exitCode });
  }
  return Option.some(withoutLineBreak(answer.output));
});

// The Mac's own file system and programs.
const runOnMac = Effect.fn("TailnetPolicy.runOnMac")(function* (
  program: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(program, [...args], { stdin: "ignore", stderr: "ignore" }),
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
  return { output, exitCode };
}, Effect.scoped);

export const macSystem: MacPort<
  PlatformError.PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = {
  exists: (path) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path)),
  run: runOnMac,
};

// Which text a packaged app on Windows or a Mac takes its tailnets from: IT's policy when the helper
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

// The tailnets of a packaged app on Windows or a Mac: the chosen text's, or the built-in directory's. A
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
