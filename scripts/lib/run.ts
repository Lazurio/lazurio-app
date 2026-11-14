import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message() {
    return `${this.command} exited with code ${this.exitCode}`;
  }
}

// Runs a command with the terminal's output and fails when it exits with anything but 0.
export const runInherited = Effect.fn("runInherited")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], { cwd, stdout: "inherit", stderr: "inherit" }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) return yield* new CommandFailed({ command, exitCode });
}, Effect.scoped);

// Runs a command and returns what it wrote to its standard output.
export const runCaptured = Effect.fn("runCaptured")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], { cwd, stderr: "inherit" }),
  );
  const [stdout, exitCode] = yield* Effect.all(
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
  if (exitCode !== 0) return yield* new CommandFailed({ command, exitCode });
  return stdout;
}, Effect.scoped);
