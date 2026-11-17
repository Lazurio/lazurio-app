// helpers/device/engine.lock (ADR 0006, point 1): the fork release's tag, its commit and, per
// target, the archive, its SHA-256 and its executables. A "pending" lock names the tag and the
// archives without commit or SHA-256, and the helpers build without the engine.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ENGINE_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
] as const;
export type EngineTarget = (typeof ENGINE_TARGETS)[number];

// The engine the device helper starts next to its own binary (helpers/device/src/engine.rs).
const ENGINE_BINARY: Record<EngineTarget, string> = {
  "aarch64-apple-darwin": "agent-desktop",
  "x86_64-apple-darwin": "agent-desktop",
  "x86_64-pc-windows-msvc": "agent-desktop.exe",
};

const FileName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u));
const Files = Schema.Array(FileName);

const Common = {
  repository: Schema.Literal("Lazurio/agent-desktop"),
  // Only a release of the distribution fork, never a branch or a bare commit (decision 0241).
  tag: Schema.String.check(Schema.isPattern(/^v\d+\.\d+\.\d+-lazurio\.[1-9]\d*$/u)),
  signerWorkflow: Schema.Literal("Lazurio/agent-desktop/.github/workflows/lazurio-release.yml"),
};

const PendingEntry = Schema.Struct({ archive: Schema.String, files: Files });
const PinnedEntry = Schema.Struct({
  archive: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  files: Files,
});

const targetsOf = <S extends Schema.Top>(entry: S) =>
  Schema.Struct({
    "aarch64-apple-darwin": entry,
    "x86_64-apple-darwin": entry,
    "x86_64-pc-windows-msvc": entry,
  });

const PendingLock = Schema.Struct({
  status: Schema.Literal("pending"),
  // Why the lock is not pinned yet, for whoever reads the file.
  pending: Schema.String,
  ...Common,
  targets: targetsOf(PendingEntry),
});

const PinnedLock = Schema.Struct({
  status: Schema.Literal("pinned"),
  ...Common,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  targets: targetsOf(PinnedEntry),
});

const EngineLockSchema = Schema.Union([PendingLock, PinnedLock]);

export type PinnedEngineLock = typeof PinnedLock.Type;
export type EngineLock = typeof EngineLockSchema.Type;
type PinnedEngineEntry = typeof PinnedEntry.Type;

class EngineLockInvalid extends Schema.TaggedError<EngineLockInvalid>()("EngineLockInvalid", {
  problem: Schema.String,
}) {
  override get message(): string {
    return `helpers/device/engine.lock: ${this.problem}`;
  }
}

const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(EngineLockSchema));

// The fork's release workflow names each archive after the tag and the target
// (scripts/lazurio-release-archive.sh in Lazurio/agent-desktop).
const archiveName = (tag: string, target: EngineTarget) => `agent-desktop-${tag}-${target}.tar.gz`;

const problemOf = (lock: EngineLock): string | undefined => {
  for (const target of ENGINE_TARGETS) {
    const entry = lock.targets[target];
    if (entry.archive !== archiveName(lock.tag, target)) {
      return `${target}: the archive "${entry.archive}" is not ${archiveName(lock.tag, target)}`;
    }
    if (!entry.files.includes(ENGINE_BINARY[target])) {
      return `${target}: the files do not include the engine ${ENGINE_BINARY[target]}`;
    }
    if (new Set(entry.files).size !== entry.files.length) {
      return `${target}: a file is named twice`;
    }
  }
  return undefined;
};

export const decodeEngineLock = Effect.fn("EngineLock.decode")(function* (text: string) {
  const lock = yield* decodeLock(text).pipe(
    Effect.mapError((error) => new EngineLockInvalid({ problem: error.message })),
  );
  const problem = problemOf(lock);
  if (problem !== undefined) return yield* new EngineLockInvalid({ problem });
  return lock;
});

// The fork's target for the system that packages the app; the release builds on each system it
// ships to (release.yml). Nothing for Linux, which the fork does not release.
export const engineTarget = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): EngineTarget | undefined => {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return undefined;
};

// Every name an engine file can have in the helpers' directory, so that a build never leaves an
// earlier engine behind for packaging.
export const engineFileNames = (lock: EngineLock): ReadonlyArray<string> => [
  ...new Set(ENGINE_TARGETS.flatMap((target) => lock.targets[target].files)),
];

export type EnginePlan =
  | {
      readonly kind: "fetch";
      readonly lock: PinnedEngineLock;
      readonly target: EngineTarget;
      readonly entry: PinnedEngineEntry;
    }
  // A release build without the engine warns: the package then has no Agent Desktop.
  | { readonly kind: "without"; readonly reason: string; readonly warning: boolean };

export const enginePlan = (options: {
  readonly lock: EngineLock;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly release: boolean;
}): EnginePlan => {
  const target = engineTarget(options.platform, options.arch);
  if (target === undefined) {
    return {
      kind: "without",
      reason: `${options.lock.repository} has no engine for ${options.platform}-${options.arch}`,
      // Lazurio App ships only on macOS and Windows; other builds are for tests.
      warning: false,
    };
  }
  if (options.lock.status === "pending") {
    return {
      kind: "without",
      reason: `helpers/device/engine.lock is pending: ${options.lock.pending}`,
      warning: options.release,
    };
  }
  return { kind: "fetch", lock: options.lock, target, entry: options.lock.targets[target] };
};

// The pinned lock, as the text of helpers/device/engine.lock, once the release exists and its
// commit and archives are verified (scripts/pin-engine.ts).
export const pinEngineLock = (
  lock: EngineLock,
  commit: string,
  sha256: Readonly<Record<EngineTarget, string>>,
): string => {
  const targets = Object.fromEntries(
    ENGINE_TARGETS.map((target) => [
      target,
      {
        archive: lock.targets[target].archive,
        sha256: sha256[target],
        files: lock.targets[target].files,
      },
    ]),
  );
  const pinned = {
    status: "pinned",
    repository: lock.repository,
    tag: lock.tag,
    commit,
    signerWorkflow: lock.signerWorkflow,
    targets,
  };
  return `${JSON.stringify(pinned, undefined, 2)}\n`;
};
