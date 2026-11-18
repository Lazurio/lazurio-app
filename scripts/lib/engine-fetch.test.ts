import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import type * as PlatformError from "effect/PlatformError";

import { bundleEngine, fetchEngine, pinEngine, readTarGz, sha256Hex } from "./engine-fetch.ts";
import { decodeEngineLock, type PinnedEngineLock } from "./engine-lock.ts";
import { CommandFailed } from "./run.ts";

const REPOSITORY = "Lazurio/agent-desktop";
const TAG = "v1.3.1-lazurio.1";
const COMMIT = "8e403858e43dd484437cb3ce815e979872abbc55";
const OTHER_COMMIT = "1111111111111111111111111111111111111111";
const SIGNER = "Lazurio/agent-desktop/.github/workflows/lazurio-release.yml";
const MAC_ARCHIVE = `agent-desktop-${TAG}-aarch64-apple-darwin.tar.gz`;

// A ustar archive as the fork's `tar -czf` writes it: one header per entry, contents padded to 512.
interface TarEntry {
  readonly name: string;
  readonly content: string;
  readonly type?: string;
}

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";

const tarHeader = (name: string, size: number, type: string) => {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number) => header.set(new TextEncoder().encode(text), offset);
  put(name, 0);
  put(octal(0o755, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\u000000", 257);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(octal(sum, 7) + " ", 148);
  return header;
};

const padded = (bytes: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
};

const tarGz = (entries: ReadonlyArray<TarEntry>) =>
  Effect.promise(async () => {
    const parts: Array<Uint8Array> = [];
    for (const entry of entries) {
      const content = new TextEncoder().encode(entry.content);
      parts.push(tarHeader(entry.name, content.length, entry.type ?? "0"), padded(content));
    }
    parts.push(new Uint8Array(1024));
    const tar = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      tar.set(part, offset);
      offset += part.length;
    }
    const gzip = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(gzip).arrayBuffer());
  });

const ENGINE: TarEntry = { name: "agent-desktop", content: "engine" };
const MAC_FILES: ReadonlyArray<TarEntry> = [
  ENGINE,
  { name: "agent-desktop-macos-helper", content: "helper" },
];

const lockFor = (sha256: string) =>
  decodeEngineLock(
    JSON.stringify({
      status: "pinned",
      repository: REPOSITORY,
      tag: TAG,
      commit: COMMIT,
      signerWorkflow: SIGNER,
      targets: {
        "aarch64-apple-darwin": {
          archive: MAC_ARCHIVE,
          sha256,
          files: ["agent-desktop", "agent-desktop-macos-helper"],
        },
        "x86_64-apple-darwin": {
          archive: `agent-desktop-${TAG}-x86_64-apple-darwin.tar.gz`,
          sha256: "b".repeat(64),
          files: ["agent-desktop", "agent-desktop-macos-helper"],
        },
        "x86_64-pc-windows-msvc": {
          archive: `agent-desktop-${TAG}-x86_64-pc-windows-msvc.tar.gz`,
          sha256: "c".repeat(64),
          files: ["agent-desktop.exe"],
        },
      },
    }),
  ).pipe(Effect.map((lock) => lock as PinnedEngineLock));

// The GitHub CLI as the fetch sees it: what each call answers, and every call it was given.
interface FakeGitHub {
  readonly archive: Uint8Array;
  readonly tagObject?: { readonly sha: string; readonly type: string };
  readonly annotatedTarget?: string;
  readonly immutable?: boolean;
  readonly attestation?: boolean;
}

const fakeGh = (github: FakeGitHub) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const calls: Array<ReadonlyArray<string>> = [];
    const fail = (args: ReadonlyArray<string>) =>
      Effect.fail(new CommandFailed({ command: `gh ${args[0] ?? ""}`, exitCode: 1 }));
    const runner = (command: string, args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        assert.strictEqual(command, "gh");
        calls.push(args);
        const [first, second, third] = args;
        if (first === "api" && second === `repos/${REPOSITORY}/git/ref/tags/${TAG}`) {
          return JSON.stringify({ object: github.tagObject ?? { sha: COMMIT, type: "commit" } });
        }
        if (first === "api" && second?.startsWith(`repos/${REPOSITORY}/git/tags/`) === true) {
          return JSON.stringify({ object: { sha: github.annotatedTarget, type: "commit" } });
        }
        if (first === "api" && second === `repos/${REPOSITORY}/releases/tags/${TAG}`) {
          return JSON.stringify({
            tag_name: TAG,
            draft: false,
            immutable: github.immutable ?? true,
          });
        }
        if (first === "release" && second === "download") {
          const pattern = args[args.indexOf("-p") + 1] ?? "";
          const directory = args[args.indexOf("-D") + 1] ?? "";
          yield* fileSystem.writeFile(path.join(directory, pattern), github.archive);
          return "";
        }
        if (first === "attestation" && second === "verify" && third !== undefined) {
          return github.attestation === false ? yield* fail(args) : "";
        }
        return yield* fail(args);
      });
    return { runner, calls };
  });

const withTempDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  Exclude<R, Scope.Scope> | FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* use(yield* fileSystem.makeTempDirectoryScoped());
    }),
  );

const provided = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
  );

describe("readTarGz", () => {
  it.effect("reads the regular files of an archive", () =>
    Effect.gen(function* () {
      const files = yield* readTarGz(yield* tarGz(MAC_FILES));
      assert.deepStrictEqual([...files.keys()], ["agent-desktop", "agent-desktop-macos-helper"]);
      assert.strictEqual(new TextDecoder().decode(files.get("agent-desktop")), "engine");
    }),
  );

  it.effect("refuses links, directories and paths", () =>
    Effect.gen(function* () {
      for (const entries of [
        [{ name: "agent-desktop", content: "/bin/sh", type: "2" }],
        [{ name: "agent-desktop/", content: "", type: "5" }],
        [{ name: "../agent-desktop", content: "engine" }],
        [{ name: "/tmp/agent-desktop", content: "engine" }],
        [ENGINE, ENGINE],
      ]) {
        const exit = yield* Effect.exit(readTarGz(yield* tarGz(entries)));
        assert.isTrue(Exit.isFailure(exit), JSON.stringify(entries));
      }
    }),
  );

  it.effect("refuses what is not a gzip archive", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readTarGz(new TextEncoder().encode("not an archive")));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("fetchEngine", () => {
  it.effect("places the verified engine next to the device helper", () =>
    provided(
      withTempDirectory((output) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const archive = yield* tarGz(MAC_FILES);
          const lock = yield* lockFor(yield* sha256Hex(archive));
          const gh = yield* fakeGh({ archive });
          yield* fetchEngine({
            lock,
            target: "aarch64-apple-darwin",
            outputDirectory: output,
            runner: gh.runner,
          });
          const engine = path.join(output, "agent-desktop");
          assert.strictEqual(yield* fileSystem.readFileString(engine), "engine");
          assert.strictEqual(
            yield* fileSystem.readFileString(path.join(output, "agent-desktop-macos-helper")),
            "helper",
          );
          assert.strictEqual((yield* fileSystem.stat(engine)).mode & 0o111, 0o111);
          const verify = gh.calls.find((args) => args[0] === "attestation");
          assert.deepStrictEqual(verify?.slice(3), [
            "--repo",
            REPOSITORY,
            "--signer-workflow",
            SIGNER,
            "--source-digest",
            COMMIT,
          ]);
          assert.isTrue(verify?.[2]?.endsWith(MAC_ARCHIVE));
          const download = gh.calls.find((args) => args[0] === "release");
          assert.deepStrictEqual(download?.slice(0, 6), [
            "release",
            "download",
            TAG,
            "-R",
            REPOSITORY,
            "-p",
          ]);
          assert.strictEqual(download?.[6], MAC_ARCHIVE);
        }),
      ),
    ),
  );

  it.effect("follows an annotated tag to its commit", () =>
    provided(
      withTempDirectory((output) =>
        Effect.gen(function* () {
          const archive = yield* tarGz(MAC_FILES);
          const lock = yield* lockFor(yield* sha256Hex(archive));
          const gh = yield* fakeGh({
            archive,
            tagObject: { sha: OTHER_COMMIT, type: "tag" },
            annotatedTarget: COMMIT,
          });
          yield* fetchEngine({
            lock,
            target: "aarch64-apple-darwin",
            outputDirectory: output,
            runner: gh.runner,
          });
        }),
      ),
    ),
  );

  const refuses = (
    reason: string,
    github: (archive: Uint8Array) => Omit<FakeGitHub, "archive">,
    options: { readonly sha256?: string; readonly downloads: boolean } = { downloads: true },
  ) =>
    provided(
      withTempDirectory((output) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const archive = yield* tarGz(MAC_FILES);
          const lock = yield* lockFor(options.sha256 ?? (yield* sha256Hex(archive)));
          // An engine of an earlier build lies there and must not survive a refusal.
          yield* fileSystem.writeFileString(path.join(output, "agent-desktop"), "old engine");
          const gh = yield* fakeGh({ archive, ...github(archive) });
          const error = yield* Effect.flip(
            fetchEngine({
              lock,
              target: "aarch64-apple-darwin",
              outputDirectory: output,
              runner: gh.runner,
            }),
          );
          assert.strictEqual(error._tag === "EngineRefused" ? error.reason : error._tag, reason);
          assert.isFalse(yield* fileSystem.exists(path.join(output, "agent-desktop")));
          assert.isFalse(yield* fileSystem.exists(path.join(output, "agent-desktop-macos-helper")));
          assert.strictEqual(
            gh.calls.some((args) => args[0] === "release"),
            options.downloads,
          );
        }),
      ),
    );

  it.effect("refuses an archive whose SHA-256 is not the lock's", () =>
    refuses("sha256-mismatch", () => ({}), { sha256: "0".repeat(64), downloads: true }),
  );

  it.effect("refuses an archive whose attestation does not verify", () =>
    refuses("attestation-refused", () => ({ attestation: false })),
  );

  it.effect("refuses a tag that moved, before downloading anything", () =>
    refuses("tag-moved", () => ({ tagObject: { sha: OTHER_COMMIT, type: "commit" } }), {
      downloads: false,
    }),
  );

  it.effect("refuses an annotated tag that points elsewhere", () =>
    refuses(
      "tag-moved",
      () => ({ tagObject: { sha: COMMIT, type: "tag" }, annotatedTarget: OTHER_COMMIT }),
      { downloads: false },
    ),
  );

  it.effect("refuses a release that is not immutable", () =>
    refuses("release-mutable", () => ({ immutable: false }), { downloads: false }),
  );
});

// A lock before its release exists (ADR 0006, point 1): it names the tag and the archives only.
const PENDING_LOCK = {
  status: "pending",
  pending: "The release does not exist yet.",
  repository: "Lazurio/agent-desktop",
  tag: "v1.3.1-lazurio.1",
  signerWorkflow: "Lazurio/agent-desktop/.github/workflows/lazurio-release.yml",
  targets: {
    "aarch64-apple-darwin": {
      archive: "agent-desktop-v1.3.1-lazurio.1-aarch64-apple-darwin.tar.gz",
      files: ["agent-desktop", "agent-desktop-macos-helper"],
    },
    "x86_64-apple-darwin": {
      archive: "agent-desktop-v1.3.1-lazurio.1-x86_64-apple-darwin.tar.gz",
      files: ["agent-desktop", "agent-desktop-macos-helper"],
    },
    "x86_64-pc-windows-msvc": {
      archive: "agent-desktop-v1.3.1-lazurio.1-x86_64-pc-windows-msvc.tar.gz",
      files: ["agent-desktop.exe"],
    },
  },
};

describe("bundleEngine", () => {
  it.effect("removes an earlier engine and builds without one while the lock is pending", () =>
    provided(
      withTempDirectory((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const lockPath = path.join(root, "engine.lock");
          const output = path.join(root, "release");
          yield* fileSystem.makeDirectory(output);
          // A pending lock of its own, whatever helpers/device/engine.lock pins now.
          yield* fileSystem.writeFileString(lockPath, JSON.stringify(PENDING_LOCK));
          for (const name of ["agent-desktop", "agent-desktop-macos-helper", "agent-desktop.exe"]) {
            yield* fileSystem.writeFileString(path.join(output, name), "old engine");
          }
          const gh = yield* fakeGh({ archive: new Uint8Array() });
          const result = yield* bundleEngine({
            lockPath,
            outputDirectory: output,
            release: true,
            runner: gh.runner,
          }).pipe(Effect.provideService(HostProcess.Architecture, "arm64"));
          assert.strictEqual(result, "without");
          assert.deepStrictEqual(gh.calls, []);
          assert.deepStrictEqual(yield* fileSystem.readDirectory(output), []);
        }),
      ),
    ),
  );
});

describe("pinEngine", () => {
  const pendingLock = () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* decodeEngineLock(
        yield* fileSystem.readFileString(
          path.resolve(import.meta.dirname, "..", "..", "helpers", "device", "engine.lock"),
        ),
      );
    });

  it.effect("refuses to pin an archive without the files the lock names", () =>
    provided(
      Effect.gen(function* () {
        // Every download answers with the Mac's files, so the Windows archive has no engine.
        const gh = yield* fakeGh({ archive: yield* tarGz(MAC_FILES) });
        const error = yield* Effect.flip(
          pinEngine({ lock: yield* pendingLock(), runner: gh.runner }),
        );
        assert.strictEqual(
          error._tag === "EngineRefused" ? error.reason : error._tag,
          "archive-invalid",
        );
      }),
    ),
  );

  it.effect("writes a lock that decodes as pinned", () =>
    provided(
      Effect.gen(function* () {
        const lock = yield* pendingLock();
        const archives = new Map<string, Uint8Array>([
          [lock.targets["aarch64-apple-darwin"].archive, yield* tarGz(MAC_FILES)],
          [lock.targets["x86_64-apple-darwin"].archive, yield* tarGz(MAC_FILES)],
          [
            lock.targets["x86_64-pc-windows-msvc"].archive,
            yield* tarGz([{ name: "agent-desktop.exe", content: "engine" }]),
          ],
        ]);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fakeGh({ archive: new Uint8Array() });
        const verified: Array<string> = [];
        const runner = (command: string, args: ReadonlyArray<string>) =>
          args[0] === "release"
            ? Effect.gen(function* () {
                const name = args[args.indexOf("-p") + 1] ?? "";
                const directory = args[args.indexOf("-D") + 1] ?? "";
                yield* fileSystem.writeFile(
                  path.join(directory, name),
                  archives.get(name) ?? new Uint8Array(),
                );
                return "";
              })
            : args[0] === "attestation"
              ? Effect.sync(() => {
                  verified.push(path.basename(args[2] ?? ""));
                  return "";
                })
              : base.runner(command, args);
        const text = yield* pinEngine({ lock, runner });
        const pinned = yield* decodeEngineLock(text);
        assert.strictEqual(pinned.status, "pinned");
        if (pinned.status !== "pinned") return;
        assert.strictEqual(pinned.commit, COMMIT);
        for (const [name, bytes] of archives) {
          const target = Object.values(pinned.targets).find((entry) => entry.archive === name);
          assert.strictEqual(target?.sha256, yield* sha256Hex(bytes));
        }
        assert.deepStrictEqual(verified.toSorted(), [...archives.keys()].toSorted());
      }),
    ),
  );

  it.effect("refuses to pin a release that is not immutable", () =>
    provided(
      Effect.gen(function* () {
        const gh = yield* fakeGh({ archive: new Uint8Array(), immutable: false });
        const error = yield* Effect.flip(
          pinEngine({ lock: yield* pendingLock(), runner: gh.runner }),
        );
        assert.strictEqual(
          error._tag === "EngineRefused" ? error.reason : error._tag,
          "release-mutable",
        );
      }),
    ),
  );
});
