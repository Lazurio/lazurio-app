// Builds both helpers where apps/desktop looks for them (helpers/tailnet/bin, helpers/device/target)
// and places the verified engine of helpers/device/engine.lock next to the device helper.
// `--release` builds for packaging with the app's version (apps/desktop/package.json or
// `--app-version <version>`).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { bundleEngine } from "./lib/engine-fetch.ts";
import { appVersionArgument, helperBuild } from "./lib/helper-build.ts";
import { runCaptured, runInherited } from "./lib/run.ts";

const decodeDesktopPackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

class InvalidAppVersion extends Schema.TaggedError<InvalidAppVersion>()("InvalidAppVersion", {
  version: Schema.String,
}) {
  override get message(): string {
    return `not a version for the helpers: "${this.version}"`;
  }
}

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const root = path.resolve(import.meta.dirname, "..");
  const release = process.argv.includes("--release");
  const tailnet = platform === "win32" ? "lazurio-tailnet.exe" : "lazurio-tailnet";
  const appVersion =
    appVersionArgument(process.argv) ??
    (yield* decodeDesktopPackage(
      yield* fileSystem.readFileString(path.join(root, "apps", "desktop", "package.json")),
    )).version;
  const build = helperBuild({ release, appVersion, tailnetOutput: path.join("bin", tailnet) });
  if ("invalidVersion" in build)
    return yield* new InvalidAppVersion({ version: build.invalidVersion });

  // The engine first: a refused engine stops the build before anything is built.
  yield* bundleEngine({
    lockPath: path.join(root, "helpers", "device", "engine.lock"),
    outputDirectory: path.join(root, "helpers", "device", "target", release ? "release" : "debug"),
    release,
    runner: (command, args) => runCaptured(command, args, root),
  });
  yield* runInherited("go", build.go, root);
  // From its own directory, so that rustup uses the toolchain of its rust-toolchain.toml.
  yield* runInherited("cargo", build.cargo, path.join(root, "helpers", "device"), build.cargoEnv);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
