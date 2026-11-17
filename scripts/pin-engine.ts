// `node scripts/pin-engine.ts` pins helpers/device/engine.lock to its tag's release (ADR 0006,
// point 1): the tag's commit and each archive's SHA-256, only after each attestation verifies at
// that commit. A newer release: set the lock's tag and archives (status "pending"), then run this.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pinEngine } from "./lib/engine-fetch.ts";
import { decodeEngineLock } from "./lib/engine-lock.ts";
import { runCaptured } from "./lib/run.ts";

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const root = path.resolve(import.meta.dirname, "..");
  const lockPath = path.join(root, "helpers", "device", "engine.lock");
  const lock = yield* decodeEngineLock(yield* fileSystem.readFileString(lockPath));
  const text = yield* pinEngine({
    lock,
    runner: (command, args) => runCaptured(command, args, root),
  });
  yield* fileSystem.writeFileString(lockPath, text);
  yield* Console.log(`helpers/device/engine.lock is pinned to ${lock.repository} ${lock.tag}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
