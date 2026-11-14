// Builds both helper processes where apps/desktop looks for them: helpers/tailnet/bin and
// helpers/device/target/{debug,release}. `pnpm build:helpers -- --release` builds for packaging.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { runInherited } from "./lib/run.ts";

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const root = path.resolve(import.meta.dirname, "..");
  const release = process.argv.includes("--release");
  const tailnet = platform === "win32" ? "lazurio-tailnet.exe" : "lazurio-tailnet";

  yield* runInherited(
    "go",
    ["-C", "helpers/tailnet", "build", "-trimpath", "-o", path.join("bin", tailnet), "."],
    root,
  );
  // From its own directory, so that rustup uses the toolchain of its rust-toolchain.toml.
  yield* runInherited(
    "cargo",
    ["build", "--locked", ...(release ? ["--release"] : [])],
    path.join(root, "helpers", "device"),
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
