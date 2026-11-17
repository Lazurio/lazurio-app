import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// The tailnets an Organization's IT sets on its computers until the directory at Lazurio Auth
// exists (docs/adr/0008, an exception by computer, not by account). On Windows it is the string
// `Tailnets` under HKLM\SOFTWARE\Policies\Lazurio\App, which only an administrator writes, in
// the built-in directory's JSON.

const POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Lazurio\\App";
const POLICY_VALUE = "Tailnets";

// The value's text in what `reg query <key> /v Tailnets` prints, or none when it prints no such
// string value.
export const valueOfQuery = (output: string): Option.Option<string> => {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_SZ\s+(.*)$/u.exec(line);
    if (match !== null && match[1]?.toLowerCase() === POLICY_VALUE.toLowerCase()) {
      return Option.some(match[2] ?? "");
    }
  }
  return Option.none();
};

// The policy's text on this computer, or none when IT set none. reg.exe comes from the system's
// own directory, never from the path, and reads the 64-bit view of the registry, where policies
// written for 64-bit Windows live.
export const readWindows = Effect.fn("TailnetPolicy.readWindows")(function* (
  systemRoot: string,
  key: string = POLICY_KEY,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      `${systemRoot}\\System32\\reg.exe`,
      ["query", key, "/v", POLICY_VALUE, "/reg:64"],
      { stderr: "ignore" },
    ),
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
  // reg.exe exits with 1 when the key or the value does not exist.
  return exitCode === 0 ? valueOfQuery(output) : Option.none<string>();
}, Effect.scoped);
