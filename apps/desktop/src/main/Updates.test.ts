import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { DeviceActivity, type DeviceActivityShape } from "./DeviceActivity.ts";
import { ElectronUpdater, ElectronUpdaterError, type UpdaterEvent } from "./ElectronUpdater.ts";
import {
  make,
  quitDecision,
  type Updates,
  type UpdatesOptions,
  type UpdateState,
} from "./Updates.ts";

// A fake electron-updater that records every call in order and lets a test emit its events.
const fakeUpdater = (options: { readonly failInstall?: boolean } = {}) => {
  const calls: Array<string> = [];
  const listeners = new Map<UpdaterEvent, (value: unknown) => void>();
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const service = ElectronUpdater.of({
    setChannel: (channel) => record(`channel ${channel}`),
    setAllowPrerelease: (value) => record(`allowPrerelease ${value}`),
    setAllowDowngrade: (value) => record(`allowDowngrade ${value}`),
    setFullChangelog: (value) => record(`fullChangelog ${value}`),
    setAutoDownload: (value) => record(`autoDownload ${value}`),
    setAutoInstallOnAppQuit: (value) => record(`autoInstallOnAppQuit ${value}`),
    checkForUpdates: record("check"),
    downloadUpdate: record("download"),
    install: ({ isSilent, isForceRunAfter }) =>
      record(`install silent=${isSilent} runAfter=${isForceRunAfter}`).pipe(
        Effect.andThen(
          options.failInstall === true
            ? Effect.fail(new ElectronUpdaterError({ operation: "install", cause: "broken" }))
            : Effect.void,
        ),
      ),
    quitForUpdate: record("quitForUpdate"),
    on: (event, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.set(event, listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(event);
          }),
      ),
  });
  const emit = (event: UpdaterEvent, value?: unknown) =>
    Effect.sync(() => {
      listeners.get(event)?.(value);
    });
  return { calls, service, emit };
};

// The Device's activity, busy or idle as a test sets it, recording when the computer is held.
const fakeActivity = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<boolean>();
  const state = { idle: true, held: false };
  const activity: DeviceActivityShape = {
    isIdle: Effect.sync(() => state.idle),
    idleChanges: Stream.fromPubSub(changes),
    holdForUpdate: Effect.suspend(() =>
      state.idle
        ? Effect.acquireRelease(
            Effect.sync(() => {
              state.held = true;
            }),
            () =>
              Effect.sync(() => {
                state.held = false;
              }),
          ).pipe(Effect.as(true))
        : Effect.succeed(false),
    ),
  };
  const setIdle = (idle: boolean) =>
    Effect.sync(() => {
      state.idle = idle;
    }).pipe(Effect.andThen(PubSub.publish(changes, idle)));
  return { activity, state, setIdle };
});

const waitFor = (updates: Updates, phase: UpdateState["phase"]) =>
  updates.changes.pipe(
    Stream.filter((status) => status.state.phase === phase),
    Stream.runHead,
  );

const withUpdates = <A, E>(
  setup: {
    readonly updater: ReturnType<typeof fakeUpdater>;
    readonly activity?: DeviceActivityShape;
    readonly options?: Partial<UpdatesOptions>;
  },
  run: (updates: Updates, settingsPath: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const settingsPath = (yield* Path.Path).join(directory, "updates.json");
    const updates = yield* make({
      appVersion: "0.1.0",
      packaged: true,
      unsupported: Option.none(),
      settingsPath,
      stopHelpers: Effect.void,
      restartHelpers: Effect.void,
      ...setup.options,
    }).pipe(
      Effect.provideService(ElectronUpdater, setup.updater.service),
      setup.activity === undefined
        ? (effect) => effect
        : Effect.provideService(DeviceActivity, setup.activity),
    );
    return yield* run(updates, settingsPath);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Updates", () => {
  it.effect("does nothing in an unpackaged app", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater, options: { packaged: false } }, (updates) =>
      Effect.gen(function* () {
        yield* updates.check;
        assert.deepStrictEqual(updater.calls, []);
        assert.strictEqual(updates.current().state.phase, "off");
      }),
    );
  });

  it.effect("does nothing on a system that cannot update the app by itself", () => {
    const updater = fakeUpdater();
    return withUpdates(
      { updater, options: { unsupported: Option.some("macos-unsigned") } },
      (updates) =>
        Effect.gen(function* () {
          yield* updates.check;
          yield* updates.setChannel("nightly");
          assert.deepStrictEqual(updater.calls, []);
          assert.deepStrictEqual(updates.current(), {
            channel: "nightly",
            state: { phase: "off", reason: "macos-unsigned" },
          });
        }),
    );
  });

  it.effect("sets its channel and turns downgrades off after it", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater }, () =>
      Effect.sync(() => {
        // electron-updater's channel setter turns allowDowngrade on.
        assert.deepStrictEqual(updater.calls, [
          "autoDownload false",
          "autoInstallOnAppQuit false",
          "channel latest",
          "allowPrerelease false",
          "allowDowngrade false",
          "fullChangelog false",
        ]);
      }),
    );
  });

  it.effect("downloads an offered update and is ready once it is downloaded", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater }, (updates) =>
      Effect.gen(function* () {
        yield* updates.check;
        yield* updater.emit("update-available", { version: "0.1.1", files: [] });
        yield* waitFor(updates, "downloading");
        yield* updater.emit("update-downloaded", { version: "0.1.1" });
        const ready = yield* waitFor(updates, "ready");
        assert.include(updater.calls, "download");
        assert.deepStrictEqual(ready._tag === "Some" ? ready.value.state : undefined, {
          phase: "ready",
          version: "0.1.1",
        });
      }),
    );
  });

  it.effect("never downloads an older build, another channel's build or an unreadable one", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater }, (updates) =>
      Effect.gen(function* () {
        for (const info of [
          { version: "0.0.9" },
          { version: "0.1.0" },
          { version: "0.2.0-nightly.20261116.5" },
          { files: [] },
          "0.2.0",
        ]) {
          yield* updates.check;
          yield* updater.emit("update-available", info);
          yield* waitFor(updates, "idle");
        }
        assert.notInclude(updater.calls, "download");
      }),
    );
  });

  it.effect("keeps a switch of channel and applies it", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater }, (updates, settingsPath) =>
      Effect.gen(function* () {
        updater.calls.length = 0;
        yield* updates.setChannel("nightly");
        assert.strictEqual(updates.current().channel, "nightly");
        assert.deepStrictEqual(updater.calls, [
          "channel nightly",
          "allowPrerelease true",
          "allowDowngrade false",
          "fullChangelog true",
          "check",
        ]);
        const saved = yield* (yield* FileSystem.FileSystem).readFileString(settingsPath);
        assert.deepStrictEqual(JSON.parse(saved), { channel: "nightly" });
      }),
    );
  });

  it.effect("installs nothing when no update is ready", () => {
    const updater = fakeUpdater();
    return withUpdates({ updater }, (updates) =>
      Effect.gen(function* () {
        assert.isFalse(yield* updates.install);
        assert.isFalse(updater.calls.some((call) => call.startsWith("install ")));
      }),
    );
  });

  it.effect(
    "waits while an agent works, then holds the computer, stops the helpers and installs",
    () =>
      Effect.gen(function* () {
        const updater = fakeUpdater();
        const { activity, state, setIdle } = yield* fakeActivity;
        const heldDuringInstall: Array<boolean> = [];
        const service = ElectronUpdater.of({
          ...updater.service,
          install: (options) =>
            Effect.sync(() => heldDuringInstall.push(state.held)).pipe(
              Effect.andThen(updater.service.install(options)),
            ),
        });
        return yield* withUpdates(
          {
            updater: { ...updater, service },
            activity,
            options: {
              stopHelpers: Effect.sync(() => {
                updater.calls.push("stop helpers");
              }),
            },
          },
          (updates) =>
            Effect.gen(function* () {
              yield* updater.emit("update-available", { version: "0.1.1" });
              yield* updater.emit("update-downloaded", { version: "0.1.1" });
              yield* waitFor(updates, "ready");
              yield* setIdle(false);
              const installing = yield* Effect.forkChild(updates.install);
              yield* waitFor(updates, "installing");
              assert.notInclude(updater.calls, "stop helpers");
              yield* setIdle(true);
              assert.isTrue(yield* Fiber.join(installing));
              const tail = updater.calls.slice(-3);
              assert.deepStrictEqual(tail, [
                "stop helpers",
                "install silent=true runAfter=true",
                "quitForUpdate",
              ]);
              assert.strictEqual(updates.current().state.phase, "restarting");
              assert.deepStrictEqual(heldDuringInstall, [true]);
              assert.isFalse(state.held);
            }),
        );
      }),
  );

  it.effect("starts the helpers again when the install fails", () => {
    const updater = fakeUpdater({ failInstall: true });
    const steps: Array<string> = [];
    return withUpdates(
      {
        updater,
        options: {
          stopHelpers: Effect.sync(() => steps.push("stop")),
          restartHelpers: Effect.sync(() => steps.push("restart")),
        },
      },
      (updates) =>
        Effect.gen(function* () {
          yield* updater.emit("update-available", { version: "0.1.1" });
          yield* updater.emit("update-downloaded", { version: "0.1.1" });
          yield* waitFor(updates, "ready");
          assert.isFalse(yield* updates.install);
          assert.deepStrictEqual(steps, ["stop", "restart"]);
          assert.strictEqual(updates.current().state.phase, "failed");
          assert.notInclude(updater.calls, "quitForUpdate");
        }),
    );
  });

  it.effect(
    "joins an install that waits for the computer instead of starting or ending another",
    () =>
      Effect.gen(function* () {
        const updater = fakeUpdater();
        const { activity, setIdle } = yield* fakeActivity;
        const stops: Array<string> = [];
        return yield* withUpdates(
          {
            updater,
            activity,
            options: { stopHelpers: Effect.sync(() => stops.push("stop")) },
          },
          (updates) =>
            Effect.gen(function* () {
              yield* updater.emit("update-available", { version: "0.1.1" });
              yield* updater.emit("update-downloaded", { version: "0.1.1" });
              yield* waitFor(updates, "ready");
              yield* setIdle(false);
              // The first quit starts the install, which waits while an agent works.
              const first = yield* Effect.forkChild(updates.install);
              yield* waitFor(updates, "installing");
              // A second quit, or the last window closing, joins it instead of returning at once.
              const second = yield* Effect.forkChild(updates.install);
              yield* Effect.yieldNow;
              assert.deepStrictEqual(stops, []);
              assert.isUndefined(second.pollUnsafe());
              yield* setIdle(true);
              assert.isTrue(yield* Fiber.join(first));
              assert.isTrue(yield* Fiber.join(second));
              assert.deepStrictEqual(stops, ["stop"]);
              assert.deepStrictEqual(
                updater.calls.filter(
                  (call) => call.startsWith("install ") || call === "quitForUpdate",
                ),
                ["install silent=true runAfter=true", "quitForUpdate"],
              );
            }),
        );
      }),
  );
});

describe("Updates while an install waits", () => {
  it.effect("refuses a change of channel, so a quit still waits for the install", () =>
    Effect.gen(function* () {
      const updater = fakeUpdater();
      const { activity, setIdle } = yield* fakeActivity;
      return yield* withUpdates({ updater, activity }, (updates, settingsPath) =>
        Effect.gen(function* () {
          yield* updater.emit("update-available", { version: "0.1.1" });
          yield* updater.emit("update-downloaded", { version: "0.1.1" });
          yield* waitFor(updates, "ready");
          yield* setIdle(false);
          const installing = yield* Effect.forkChild(updates.install);
          yield* waitFor(updates, "installing");
          const change = yield* updates.setChannel("nightly").pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(change));
          assert.deepStrictEqual(updates.current().channel, "latest");
          assert.strictEqual(quitDecision(updates.current().state.phase), "wait");
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(settingsPath));
          yield* setIdle(true);
          assert.isTrue(yield* Fiber.join(installing));
        }),
      );
    }),
  );
});

describe("quitDecision", () => {
  it("installs a ready update first, joins a waiting install, and quits otherwise", () => {
    assert.strictEqual(quitDecision("ready"), "install");
    assert.strictEqual(quitDecision("installing"), "wait");
    for (const phase of [
      "restarting",
      "idle",
      "checking",
      "downloading",
      "failed",
      "off",
    ] as const) {
      assert.strictEqual(quitDecision(phase), "quit");
    }
  });
});
