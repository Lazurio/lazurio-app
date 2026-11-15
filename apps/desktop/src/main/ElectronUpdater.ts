import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";

// electron-updater's autoUpdater as an Effect service, so that the updater (Updates.ts) runs against
// a fake in its tests. The shape follows the fork's ElectronUpdater (Lazurio/t3code,
// apps/desktop/src/electron/ElectronUpdater.ts, MIT), reduced to what Lazurio App uses.

export class ElectronUpdaterError extends Schema.TaggedError<ElectronUpdaterError>()(
  "ElectronUpdaterError",
  {
    operation: Schema.Literals(["check", "download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `electron-updater failed to ${this.operation}`;
  }
}

// The events Updates.ts listens to. Every argument is unknown until Schema decodes it.
export type UpdaterEvent =
  | "update-available"
  | "update-not-available"
  | "update-downloaded"
  | "error";

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterError>;
    // Listens for as long as the scope lives.
    readonly on: (
      event: UpdaterEvent,
      listener: (value: unknown) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@lazurio/app-desktop/main/ElectronUpdater") {}

const make = ElectronUpdater.of({
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function* (channel: string) {
    yield* Effect.sync(() => {
      autoUpdater.channel = channel;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function* (value: boolean) {
    yield* Effect.sync(() => {
      autoUpdater.allowPrerelease = value;
    });
  }),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function* (value: boolean) {
    yield* Effect.sync(() => {
      autoUpdater.allowDowngrade = value;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function* (value: boolean) {
    yield* Effect.sync(() => {
      autoUpdater.fullChangelog = value;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function* (value: boolean) {
    yield* Effect.sync(() => {
      autoUpdater.autoDownload = value;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function* (
    value: boolean,
  ) {
    yield* Effect.sync(() => {
      autoUpdater.autoInstallOnAppQuit = value;
    });
  }),
  checkForUpdates: Effect.tryPromise({
    try: () => autoUpdater.checkForUpdates(),
    catch: (cause) => new ElectronUpdaterError({ operation: "check", cause }),
  }).pipe(Effect.asVoid),
  downloadUpdate: Effect.tryPromise({
    try: () => autoUpdater.downloadUpdate(),
    catch: (cause) => new ElectronUpdaterError({ operation: "download", cause }),
  }).pipe(Effect.asVoid),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function* (options: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) {
    yield* Effect.try({
      try: () => autoUpdater.quitAndInstall(options.isSilent, options.isForceRunAfter),
      catch: (cause) => new ElectronUpdaterError({ operation: "install", cause }),
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function* (
    event: UpdaterEvent,
    listener: (value: unknown) => void,
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        autoUpdater.on(event, listener);
      }),
      () =>
        Effect.sync(() => {
          autoUpdater.off(event, listener);
        }),
    );
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
