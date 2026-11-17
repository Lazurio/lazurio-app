import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { decodeEngineLock, enginePlan, engineTarget, pinEngineLock } from "./engine-lock.ts";

const TAG = "v1.3.1-lazurio.1";
const COMMIT = "8e403858e43dd484437cb3ce815e979872abbc55";
const SHA = (digit: string) => digit.repeat(64);

const targets = (withSha: boolean) => ({
  "aarch64-apple-darwin": {
    archive: `agent-desktop-${TAG}-aarch64-apple-darwin.tar.gz`,
    files: ["agent-desktop", "agent-desktop-macos-helper"],
    ...(withSha ? { sha256: SHA("a") } : {}),
  },
  "x86_64-apple-darwin": {
    archive: `agent-desktop-${TAG}-x86_64-apple-darwin.tar.gz`,
    files: ["agent-desktop", "agent-desktop-macos-helper"],
    ...(withSha ? { sha256: SHA("b") } : {}),
  },
  "x86_64-pc-windows-msvc": {
    archive: `agent-desktop-${TAG}-x86_64-pc-windows-msvc.tar.gz`,
    files: ["agent-desktop.exe"],
    ...(withSha ? { sha256: SHA("c") } : {}),
  },
});

const pending = {
  status: "pending",
  pending: "the release does not exist yet",
  repository: "Lazurio/agent-desktop",
  tag: TAG,
  signerWorkflow: "Lazurio/agent-desktop/.github/workflows/lazurio-release.yml",
  targets: targets(false),
};

const pinned = {
  status: "pinned",
  repository: "Lazurio/agent-desktop",
  tag: TAG,
  commit: COMMIT,
  signerWorkflow: "Lazurio/agent-desktop/.github/workflows/lazurio-release.yml",
  targets: targets(true),
};

const decodes = (value: unknown) => Effect.exit(decodeEngineLock(JSON.stringify(value)));

describe("decodeEngineLock", () => {
  it.effect("reads a pending lock and a pinned one", () =>
    Effect.gen(function* () {
      const pendingLock = yield* decodeEngineLock(JSON.stringify(pending));
      assert.strictEqual(pendingLock.status, "pending");
      const pinnedLock = yield* decodeEngineLock(JSON.stringify(pinned));
      assert.strictEqual(pinnedLock.status, "pinned");
      if (pinnedLock.status === "pinned") {
        assert.strictEqual(pinnedLock.commit, COMMIT);
        assert.strictEqual(pinnedLock.targets["x86_64-pc-windows-msvc"].sha256, SHA("c"));
      }
    }),
  );

  it.effect("reads the committed lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const text = yield* fileSystem.readFileString(
        path.resolve(import.meta.dirname, "..", "..", "helpers", "device", "engine.lock"),
      );
      const lock = yield* decodeEngineLock(text);
      assert.strictEqual(lock.tag, TAG);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a pinned lock without a SHA-256 or a commit", () =>
    Effect.gen(function* () {
      const { sha256: _sha256, ...withoutSha } = pinned.targets["aarch64-apple-darwin"];
      for (const lock of [
        { ...pinned, targets: { ...pinned.targets, "aarch64-apple-darwin": withoutSha } },
        { ...pinned, commit: undefined },
        { ...pinned, commit: "8e403858" },
        {
          ...pinned,
          targets: {
            ...pinned.targets,
            "x86_64-apple-darwin": {
              ...pinned.targets["x86_64-apple-darwin"],
              sha256: "B".repeat(64),
            },
          },
        },
      ]) {
        assert.isTrue(Exit.isFailure(yield* decodes(lock)), JSON.stringify(lock));
      }
    }),
  );

  it.effect("refuses another repository, signer workflow or a tag that is no fork release", () =>
    Effect.gen(function* () {
      for (const lock of [
        { ...pinned, repository: "vercel-labs/agent-desktop" },
        { ...pinned, signerWorkflow: "Lazurio/agent-desktop/.github/workflows/release.yml" },
        { ...pinned, tag: "main" },
        { ...pinned, tag: "v1.3.1" },
      ]) {
        assert.isTrue(Exit.isFailure(yield* decodes(lock)), JSON.stringify(lock));
      }
    }),
  );

  it.effect("refuses an archive that is not the tag's archive of its target", () =>
    Effect.gen(function* () {
      const windows = pinned.targets["x86_64-pc-windows-msvc"];
      for (const archive of [
        `agent-desktop-v1.3.0-lazurio.1-x86_64-pc-windows-msvc.tar.gz`,
        `agent-desktop-${TAG}-aarch64-apple-darwin.tar.gz`,
        `agent-desktop-${TAG}-x86_64-pc-windows-msvc.zip`,
      ]) {
        const lock = {
          ...pinned,
          targets: { ...pinned.targets, "x86_64-pc-windows-msvc": { ...windows, archive } },
        };
        assert.isTrue(Exit.isFailure(yield* decodes(lock)), archive);
      }
    }),
  );

  it.effect("refuses files without the engine or with a path in their names", () =>
    Effect.gen(function* () {
      const windows = pinned.targets["x86_64-pc-windows-msvc"];
      for (const files of [[], ["agent-desktop"], ["agent-desktop.exe", "../x"], [".."]]) {
        const lock = {
          ...pinned,
          targets: { ...pinned.targets, "x86_64-pc-windows-msvc": { ...windows, files } },
        };
        assert.isTrue(Exit.isFailure(yield* decodes(lock)), JSON.stringify(files));
      }
    }),
  );
});

describe("engineTarget", () => {
  it("chooses the fork's target for the systems Lazurio App ships on", () => {
    assert.strictEqual(engineTarget("darwin", "arm64"), "aarch64-apple-darwin");
    assert.strictEqual(engineTarget("darwin", "x64"), "x86_64-apple-darwin");
    assert.strictEqual(engineTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  });

  it("has no engine for other systems", () => {
    assert.isUndefined(engineTarget("linux", "x64"));
    assert.isUndefined(engineTarget("win32", "arm64"));
  });
});

describe("enginePlan", () => {
  it.effect("fetches the archive of the host's target from a pinned lock", () =>
    Effect.gen(function* () {
      const lock = yield* decodeEngineLock(JSON.stringify(pinned));
      const plan = enginePlan({ lock, platform: "darwin", arch: "x64", release: true });
      assert.strictEqual(plan.kind, "fetch");
      if (plan.kind === "fetch") {
        assert.strictEqual(plan.target, "x86_64-apple-darwin");
        assert.strictEqual(plan.entry.archive, `agent-desktop-${TAG}-x86_64-apple-darwin.tar.gz`);
      }
    }),
  );

  it.effect("builds a release without the engine, with a warning, while the lock is pending", () =>
    Effect.gen(function* () {
      const lock = yield* decodeEngineLock(JSON.stringify(pending));
      const release = enginePlan({ lock, platform: "win32", arch: "x64", release: true });
      assert.strictEqual(release.kind, "without");
      if (release.kind === "without") {
        assert.isTrue(release.warning);
        assert.include(release.reason, "pending");
      }
      const development = enginePlan({ lock, platform: "darwin", arch: "arm64", release: false });
      assert.strictEqual(development.kind, "without");
      if (development.kind === "without") assert.isFalse(development.warning);
    }),
  );

  it.effect("builds without the engine where the fork has none", () =>
    Effect.gen(function* () {
      const lock = yield* decodeEngineLock(JSON.stringify(pinned));
      const plan = enginePlan({ lock, platform: "linux", arch: "x64", release: true });
      assert.deepStrictEqual(plan, {
        kind: "without",
        reason: "Lazurio/agent-desktop has no engine for linux-x64",
        warning: false,
      });
    }),
  );
});

describe("pinEngineLock", () => {
  it.effect("turns a pending lock into a pinned one that decodes", () =>
    Effect.gen(function* () {
      const lock = yield* decodeEngineLock(JSON.stringify(pending));
      if (lock.status !== "pending") return assert.fail("the fixture is pending");
      const text = pinEngineLock(lock, COMMIT, {
        "aarch64-apple-darwin": SHA("a"),
        "x86_64-apple-darwin": SHA("b"),
        "x86_64-pc-windows-msvc": SHA("c"),
      });
      const pinnedAgain = yield* decodeEngineLock(text);
      assert.deepStrictEqual(JSON.parse(text), pinned);
      assert.strictEqual(pinnedAgain.status, "pinned");
    }),
  );
});
