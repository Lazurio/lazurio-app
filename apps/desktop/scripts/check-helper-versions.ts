// Starts both helpers of a packaged app and fails unless each one's Hello names the app's version
// (Lazurio/lazurio-app#22): `check-helper-versions.ts <resources/helpers directory> <version>`.
import { decodeFrames } from "@lazurio/app-contracts/framing";
import { HelperMessageSchema } from "@lazurio/app-contracts/helper/v1";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class HelperVersionMismatch extends Schema.TaggedError<HelperVersionMismatch>()(
  "HelperVersionMismatch",
  { helper: Schema.String, expected: Schema.String, actual: Schema.String },
) {
  override get message(): string {
    return `${this.helper} says Hello as version "${this.actual}", not "${this.expected}"`;
  }
}

class MissingArguments extends Schema.TaggedError<MissingArguments>()("MissingArguments", {}) {
  override get message(): string {
    return "usage: check-helper-versions.ts <resources/helpers directory> <version>";
  }
}

const helloVersion = Effect.fn("checkHelperVersions.helloVersion")(function* (binary: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Its standard input stays open until the scope closes, so the helper waits after its Hello.
  const child = yield* spawner.spawn(
    ChildProcess.make(binary, [], { stdin: "pipe", stderr: "inherit" }),
  );
  const first = yield* Effect.promise(() =>
    decodeFrames(HelperMessageSchema, Stream.toAsyncIterable(child.stdout)).next(),
  );
  if (first.done === true || first.value.kind.case !== "hello") return "";
  return first.value.kind.value.helperVersion;
}, Effect.scoped);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const [directory, expected] = process.argv.slice(2);
  if (directory === undefined || expected === undefined) return yield* new MissingArguments();
  for (const helper of ["lazurio-tailnet", "lazurio-device"]) {
    const binary = path.join(directory, platform === "win32" ? `${helper}.exe` : helper);
    const actual = yield* helloVersion(binary);
    if (actual !== expected) return yield* new HelperVersionMismatch({ helper, expected, actual });
    yield* Console.log(`${helper} says Hello as version ${actual}`);
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
