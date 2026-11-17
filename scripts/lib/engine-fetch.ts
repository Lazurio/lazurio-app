// The engine next to the device helper (ADR 0006, point 1), only after the tag still points to the
// lock's commit, the release is immutable, and the archive's SHA-256 and its attestation from the
// fork's release workflow at that commit verify. Any refusal leaves no engine behind.
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import {
  ENGINE_TARGETS,
  decodeEngineLock,
  engineFileNames,
  enginePlan,
  pinEngineLock,
  type EngineLock,
  type EngineTarget,
  type PinnedEngineLock,
} from "./engine-lock.ts";
import type { CommandFailed } from "./run.ts";

// Runs a command (here always `gh`) and returns its standard output; the tests give their own.
export type Runner = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<
  string,
  CommandFailed | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
>;

export class EngineRefused extends Schema.TaggedError<EngineRefused>()("EngineRefused", {
  reason: Schema.Literals([
    "tag-moved",
    "release-mutable",
    "sha256-mismatch",
    "attestation-refused",
    "archive-invalid",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `the engine Lazurio/agent-desktop is refused (${this.reason}): ${this.detail}`;
  }
}

const archiveInvalid = (detail: string) => new EngineRefused({ reason: "archive-invalid", detail });

// A git object as the GitHub API names it.
const decodeObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ object: Schema.Struct({ sha: Schema.String, type: Schema.String }) }),
  ),
);

const decodeRelease = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ tag_name: Schema.String, draft: Schema.Boolean, immutable: Schema.Boolean }),
  ),
);

// The commit the tag points to now, through annotated tags.
const tagCommit = Effect.fn("EngineFetch.tagCommit")(function* (
  runner: Runner,
  repository: string,
  tag: string,
) {
  let { object } = yield* decodeObject(
    yield* runner("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]),
  );
  for (let depth = 0; object.type === "tag" && depth < 4; depth += 1) {
    ({ object } = yield* decodeObject(
      yield* runner("gh", ["api", `repos/${repository}/git/tags/${object.sha}`]),
    ));
  }
  return object.type === "commit" ? object.sha : `${object.type} ${object.sha}`;
});

export const sha256Hex = Effect.fn("EngineFetch.sha256Hex")(function* (bytes: Uint8Array) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const gunzip = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const stream = new Blob([new Uint8Array(bytes)])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
    catch: () => archiveInvalid("the archive is not gzip"),
  });

const BLOCK = 512;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/su, "");

const octalField = (bytes: Uint8Array): number | undefined => {
  const value = text(bytes).trim();
  return /^[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : undefined;
};

// The records of a pax extended header: "<length> <key>=<value>\n".
const paxRecords = (bytes: Uint8Array): Map<string, string> | undefined => {
  const records = new Map<string, string>();
  const decoded = new TextDecoder().decode(bytes);
  let offset = 0;
  while (offset < decoded.length) {
    const space = decoded.indexOf(" ", offset);
    const length = Number.parseInt(decoded.slice(offset, space), 10);
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) return undefined;
    const record = decoded.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals === -1) return undefined;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

// The regular files of a tar archive, by name. The fork packs its executables side by side at the
// archive's root, so anything else (a link, a directory, a path, a name twice) is refused.
const parseTar = (tar: Uint8Array): Map<string, Uint8Array> | string => {
  const files = new Map<string, Uint8Array>();
  let paxPath: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return files;
    const stored = octalField(header.subarray(148, 156));
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (stored !== sum) return "a header's checksum is wrong";
    const size = octalField(header.subarray(124, 136));
    if (size === undefined) return "a header has no size";
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (body.length !== size) return "the archive ends inside a file";
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x" || type === "g") {
      // Extended headers carry attributes the fork's tar may add; only a path is honoured, and
      // only for the next entry. A global path or size would rename or resize every entry.
      const records = paxRecords(body);
      if (records === undefined) return "an extended header is broken";
      if (records.has("size") || (type === "g" && records.has("path"))) {
        return "an extended header changes a size or every path";
      }
      if (type === "x") paxPath = records.get("path");
      continue;
    }
    if (type !== "0" && type !== "\0") return `an entry of type "${type}" is not a regular file`;
    const ustar =
      text(header.subarray(257, 263)) === "ustar" && text(header.subarray(263, 265)) === "00";
    const prefix = ustar ? text(header.subarray(345, 500)) : "";
    const name = (
      paxPath ?? (prefix === "" ? "" : `${prefix}/`) + text(header.subarray(0, 100))
    ).replace(/^\.\//u, "");
    paxPath = undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) return `"${name}" is not a plain file name`;
    if (files.has(name)) return `"${name}" is in the archive twice`;
    files.set(name, body);
  }
  return "the archive has no end";
};

export const readTarGz = Effect.fn("EngineFetch.readTarGz")(function* (bytes: Uint8Array) {
  const files = parseTar(yield* gunzip(bytes));
  if (typeof files === "string") return yield* archiveInvalid(files);
  return files;
});

const removeEngineFiles = Effect.fn("EngineFetch.removeEngineFiles")(function* (
  directory: string,
  names: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of names) {
    yield* fileSystem.remove(path.join(directory, name), { force: true });
    yield* fileSystem.remove(path.join(directory, `${name}.partial`), { force: true });
  }
});

// The commit of a published immutable release of the fork. With `expected`, a tag that points
// anywhere else is refused.
const releaseCommit = Effect.fn("EngineFetch.releaseCommit")(function* (
  runner: Runner,
  repository: string,
  tag: string,
  expected?: string,
) {
  const commit = yield* tagCommit(runner, repository, tag);
  if (expected !== undefined && commit !== expected) {
    return yield* new EngineRefused({
      reason: "tag-moved",
      detail: `${tag} points to ${commit}, the lock names ${expected}`,
    });
  }
  const release = yield* decodeRelease(
    yield* runner("gh", ["api", `repos/${repository}/releases/tags/${tag}`]),
  );
  if (release.tag_name !== tag || release.draft || !release.immutable) {
    return yield* new EngineRefused({
      reason: "release-mutable",
      detail: `the release ${tag} is not a published immutable release`,
    });
  }
  return commit;
});

// Downloads one archive of the release, verifies its SHA-256 (when the lock names one) and its build
// provenance attestation from the fork's release workflow at `commit`, and returns its SHA-256 and
// files.
const verifiedArchive = Effect.fn("EngineFetch.verifiedArchive")(function* (options: {
  readonly runner: Runner;
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly signerWorkflow: string;
  readonly archive: string;
  readonly sha256: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { runner } = options;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lazurio-engine-" });
  yield* runner("gh", [
    "release",
    "download",
    options.tag,
    "-R",
    options.repository,
    "-p",
    options.archive,
    "-D",
    directory,
  ]);
  const archive = path.join(directory, options.archive);
  const bytes = yield* fileSystem.readFile(archive);
  const sha256 = yield* sha256Hex(bytes);
  if (options.sha256 !== undefined && sha256 !== options.sha256) {
    return yield* new EngineRefused({
      reason: "sha256-mismatch",
      detail: `${options.archive} has SHA-256 ${sha256}, the lock names ${options.sha256}`,
    });
  }
  yield* runner("gh", [
    "attestation",
    "verify",
    archive,
    "--repo",
    options.repository,
    "--signer-workflow",
    options.signerWorkflow,
    "--source-digest",
    options.commit,
  ]).pipe(
    Effect.mapError(
      () =>
        new EngineRefused({
          reason: "attestation-refused",
          detail: `${options.archive} has no build provenance attestation of ${options.signerWorkflow} at ${options.commit}`,
        }),
    ),
  );
  return { sha256, files: yield* readTarGz(bytes) };
}, Effect.scoped);

// The archive holds exactly the files the lock names for its target.
const requireFiles = (
  archive: string,
  files: ReadonlyMap<string, Uint8Array>,
  expected: ReadonlyArray<string>,
): Effect.Effect<void, EngineRefused> => {
  const names = [...files.keys()].toSorted();
  return names.join("\n") === expected.toSorted().join("\n")
    ? Effect.void
    : Effect.fail(archiveInvalid(`${archive} holds ${names.join(", ")}`));
};

// Downloads, verifies and extracts the engine of `target` into `outputDirectory`.
export const fetchEngine = Effect.fn("EngineFetch.fetchEngine")(function* (options: {
  readonly lock: PinnedEngineLock;
  readonly target: EngineTarget;
  readonly outputDirectory: string;
  readonly runner: Runner;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const { lock } = options;
  const entry = lock.targets[options.target];
  yield* removeEngineFiles(options.outputDirectory, engineFileNames(lock));

  yield* releaseCommit(options.runner, lock.repository, lock.tag, lock.commit);
  const { files } = yield* verifiedArchive({
    runner: options.runner,
    repository: lock.repository,
    tag: lock.tag,
    commit: lock.commit,
    signerWorkflow: lock.signerWorkflow,
    archive: entry.archive,
    sha256: entry.sha256,
  });
  yield* requireFiles(entry.archive, files, entry.files);

  yield* fileSystem.makeDirectory(options.outputDirectory, { recursive: true });
  for (const [name, content] of files) {
    const destination = path.join(options.outputDirectory, name);
    yield* fileSystem.writeFile(`${destination}.partial`, content);
    if (platform !== "win32") yield* fileSystem.chmod(`${destination}.partial`, 0o755);
    yield* fileSystem.rename(`${destination}.partial`, destination);
  }
});

// What `pnpm build:helpers` does with the engine: places it next to the device helper from a pinned
// lock, or builds without it while the lock is pending or where the fork has no engine. A release
// build without the engine says so loudly; one with a pinned lock fails on any refusal.
export const bundleEngine = Effect.fn("EngineFetch.bundleEngine")(function* (options: {
  readonly lockPath: string;
  readonly outputDirectory: string;
  readonly release: boolean;
  readonly runner: Runner;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const lock: EngineLock = yield* decodeEngineLock(
    yield* fileSystem.readFileString(options.lockPath),
  );
  const plan = enginePlan({
    lock,
    platform: yield* HostProcess.Platform,
    arch: yield* HostProcess.Architecture,
    release: options.release,
  });
  if (plan.kind === "without") {
    yield* removeEngineFiles(options.outputDirectory, engineFileNames(lock));
    if (plan.warning) {
      yield* Console.warn(
        `WARNING: this release build packages NO engine ${lock.repository}, so it has no Agent Desktop. ${plan.reason}`,
      );
    } else {
      yield* Console.log(`build:helpers: without the engine ${lock.repository}. ${plan.reason}`);
    }
    return "without" as const;
  }
  yield* fetchEngine({
    lock: plan.lock,
    target: plan.target,
    outputDirectory: options.outputDirectory,
    runner: options.runner,
  });
  yield* Console.log(
    `build:helpers: the engine ${lock.repository} ${lock.tag} (${plan.target}) is verified and placed`,
  );
  return "bundled" as const;
});

// The text of a pinned helpers/device/engine.lock for the lock's tag, once its release exists:
// the commit the tag points to and the SHA-256 of each archive whose attestation verifies at that
// commit and that holds the files the lock names (scripts/pin-engine.ts).
export const pinEngine = Effect.fn("EngineFetch.pinEngine")(function* (options: {
  readonly lock: EngineLock;
  readonly runner: Runner;
}) {
  const { lock, runner } = options;
  const commit = yield* releaseCommit(runner, lock.repository, lock.tag);
  const sha256: Partial<Record<EngineTarget, string>> = {};
  for (const target of ENGINE_TARGETS) {
    const entry = lock.targets[target];
    const verified = yield* verifiedArchive({
      runner,
      repository: lock.repository,
      tag: lock.tag,
      commit,
      signerWorkflow: lock.signerWorkflow,
      archive: entry.archive,
      sha256: undefined,
    });
    yield* requireFiles(entry.archive, verified.files, entry.files);
    sha256[target] = verified.sha256;
  }
  const text = pinEngineLock(lock, commit, {
    "aarch64-apple-darwin": sha256["aarch64-apple-darwin"] ?? "",
    "x86_64-apple-darwin": sha256["x86_64-apple-darwin"] ?? "",
    "x86_64-pc-windows-msvc": sha256["x86_64-pc-windows-msvc"] ?? "",
  });
  // What is written must read back as a pinned lock.
  yield* decodeEngineLock(text);
  return text;
});
