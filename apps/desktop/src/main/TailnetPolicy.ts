import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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
