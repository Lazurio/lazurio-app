// Downloads the Electron binary of the pinned version. Electron 44 has no install script of its own
// that pnpm would run (allowBuilds), so its install.js runs here, through the current Node.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { runInherited } from "../../../scripts/lib/run.ts";

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const desktop = path.resolve(import.meta.dirname, "..");
  yield* runInherited(
    process.execPath,
    [path.join(desktop, "node_modules", "electron", "install.js")],
    desktop,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
