// Reads the Electron Fuses back from the app electron-builder built (`pnpm package:dir`) and fails
// when one differs from the safe state electron-builder.yml asks for (docs/adr/0001).
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// The values of FuseState in @electron/fuses 1.8.0, which its index does not export.
const DISABLE = 48;
const ENABLE = 49;

const EXPECTED: ReadonlyArray<readonly [FuseV1Options, number]> = [
  [FuseV1Options.RunAsNode, DISABLE],
  [FuseV1Options.EnableCookieEncryption, ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, ENABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, DISABLE],
];

class FuseMismatch extends Schema.TaggedError<FuseMismatch>()("FuseMismatch", {
  fuses: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `Electron Fuses not in their safe state: ${this.fuses.join(", ")}`;
  }
}

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const release = path.resolve(import.meta.dirname, "..", "release");
  // The folders and names electron-builder gives the unpacked app (electron-builder.yml).
  const executable =
    platform === "darwin"
      ? path.join(release, architecture === "arm64" ? "mac-arm64" : "mac", "Lazurio App.app")
      : platform === "win32"
        ? path.join(release, "win-unpacked", "Lazurio App.exe")
        : path.join(release, "linux-unpacked", "lazurio-app");
  const wire = yield* Effect.promise(() => getCurrentFuseWire(executable));
  const wrong = EXPECTED.filter(([fuse, state]) => wire[fuse] !== state).map(
    ([fuse]) => FuseV1Options[fuse],
  );
  if (wrong.length > 0) return yield* new FuseMismatch({ fuses: wrong });
  yield* Console.log(`Electron Fuses are in their safe state: ${executable}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
