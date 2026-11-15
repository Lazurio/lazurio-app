import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { DeviceActivity, type DeviceActivityShape } from "./DeviceActivity.ts";
import { ElectronUpdater } from "./ElectronUpdater.ts";
import { encodeSettings, isOffered, settingsFrom, type UpdateChannel } from "./UpdateChannel.ts";

// The app's updater (docs/adr/0005, points 4 and 5), after the fork's DesktopUpdates
// (Lazurio/t3code, apps/desktop/src/updates). It runs only in a packaged app, checks 15 seconds
// after start and then every hour, downloads an update of the selected channel in the background,
// and installs it only once no agent works on the computer and the helpers have stopped.

const FIRST_CHECK = "15 seconds";
const CHECK_EVERY = "1 hour";
// A fallback for an idle change that came before the updater listened for it.
const IDLE_RECHECK = "30 seconds";

export type UpdateState =
  | { readonly phase: "off"; readonly reason: string }
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "downloading"; readonly version: string }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "installing"; readonly version: string }
  // The installer started and the app quits for it.
  | { readonly phase: "restarting"; readonly version: string }
  | { readonly phase: "failed"; readonly problem: string };

export interface UpdatesStatus {
  readonly channel: UpdateChannel;
  readonly state: UpdateState;
}

class UpdateSettingsError extends Schema.TaggedError<UpdateSettingsError>()("UpdateSettingsError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the update settings could not be saved to ${this.path}`;
  }
}

export interface UpdatesOptions {
  readonly appVersion: string;
  readonly packaged: boolean;
  // Why this system cannot update the app by itself, if it cannot (docs/adr/0005, point 7).
  readonly unsupported: Option.Option<string>;
  // `<userData>/updates.json`.
  readonly settingsPath: string;
  // Stops every helper and waits for it to exit. On Windows a running helper keeps its .exe locked,
  // and the installer would fail.
  readonly stopHelpers: Effect.Effect<void>;
  // After a failed install, brings the stopped helpers back.
  readonly restartHelpers: Effect.Effect<void>;
}

export interface Updates {
  readonly current: () => UpdatesStatus;
  readonly changes: Stream.Stream<UpdatesStatus>;
  readonly check: Effect.Effect<void>;
  readonly setChannel: (channel: UpdateChannel) => Effect.Effect<void, UpdateSettingsError>;
  // Installs a downloaded update: `true` when the app quits to install it, `false` when there is
  // none or the install failed.
  readonly install: Effect.Effect<boolean>;
}

// What quitting the app does to an update (main.ts, before-quit): a ready update installs first,
// a quit while an install waits joins that install, and anything else quits.
export const quitDecision = (phase: UpdateState["phase"]): "install" | "wait" | "quit" =>
  phase === "ready" ? "install" : phase === "installing" ? "wait" : "quit";

// electron-updater's UpdateInfo, of which the updater reads only the version.
const decodeVersion = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.String }));

const describe = (value: unknown): string =>
  value instanceof Error ? value.message : "electron-updater reported an error";

// Holds the computer for the install: asks the Device's activity until it answers `true`, waiting
// for it to become idle in between.
const holdComputer = (activity: DeviceActivityShape): Effect.Effect<void, never, Scope.Scope> =>
  activity.holdForUpdate.pipe(
    Effect.flatMap((held) =>
      held
        ? Effect.void
        : activity.idleChanges.pipe(
            Stream.filter((idle) => idle),
            Stream.runHead,
            Effect.flatMap((idle) => (Option.isSome(idle) ? Effect.void : Effect.never)),
            Effect.timeoutOrElse({ duration: IDLE_RECHECK, orElse: () => Effect.void }),
            Effect.andThen(Effect.suspend(() => holdComputer(activity))),
          ),
    ),
  );

export const make = Effect.fn("Updates.make")(function* (options: UpdatesOptions) {
  const updater = yield* ElectronUpdater;
  const fileSystem = yield* FileSystem.FileSystem;
  const activity = yield* DeviceActivity;
  const settings = settingsFrom(
    yield* fileSystem.readFileString(options.settingsPath).pipe(Effect.option),
    options.appVersion,
  );
  const off: Option.Option<string> = options.packaged
    ? options.unsupported
    : Option.some("Updates run only in a packaged app.");
  let latest: UpdatesStatus = {
    channel: settings.channel,
    state: Option.match(off, {
      onNone: (): UpdateState => ({ phase: "idle" }),
      onSome: (reason): UpdateState => ({ phase: "off", reason }),
    }),
  };
  const status = yield* SubscriptionRef.make(latest);
  const setStatus = (next: UpdatesStatus) =>
    Effect.suspend(() => {
      latest = next;
      return SubscriptionRef.set(status, next);
    });
  const setState = (state: UpdateState) => setStatus({ ...latest, state });

  const offered = (version: string) =>
    isOffered({ running: options.appVersion, offered: version, channel: latest.channel });

  // electron-updater's channel setter turns allowDowngrade on, so it goes off after it.
  const applyChannel = Effect.fn("Updates.applyChannel")(function* (channel: UpdateChannel) {
    yield* updater.setChannel(channel);
    yield* updater.setAllowPrerelease(channel === "nightly");
    yield* updater.setAllowDowngrade(false);
    yield* updater.setFullChangelog(channel === "nightly");
  });

  const check = Effect.suspend(() => {
    if (latest.state.phase !== "idle" && latest.state.phase !== "failed") return Effect.void;
    return setState({ phase: "checking" }).pipe(
      Effect.andThen(updater.checkForUpdates),
      Effect.catch((error) => setState({ phase: "failed", problem: error.message })),
    );
  }).pipe(Effect.withSpan("Updates.check"));

  const onAvailable = (info: unknown) =>
    Effect.suspend(() => {
      const version = decodeVersion(info);
      if (Option.isNone(version) || !offered(version.value.version)) {
        return Effect.logInfo(
          "ignoring an update outside the channel or below the running build",
        ).pipe(Effect.andThen(setState({ phase: "idle" })));
      }
      return setState({ phase: "downloading", version: version.value.version }).pipe(
        Effect.andThen(updater.downloadUpdate),
        Effect.catch((error) => setState({ phase: "failed", problem: error.message })),
      );
    });

  const onDownloaded = (info: unknown) =>
    Effect.suspend(() => {
      const version = decodeVersion(info);
      return Option.isSome(version) && offered(version.value.version)
        ? setState({ phase: "ready", version: version.value.version })
        : setState({ phase: "idle" });
    });

  // One install at a time: every call while it runs waits for the same attempt, so a second quit or
  // a closed window never ends the app before the install is safe or has failed.
  let attempt: Option.Option<Deferred.Deferred<boolean>> = Option.none();
  const attemptInstall = (version: string) =>
    setState({ phase: "installing", version }).pipe(
      Effect.andThen(
        Effect.scoped(
          Effect.gen(function* () {
            yield* holdComputer(activity);
            yield* options.stopHelpers;
            yield* updater.install({ isSilent: true, isForceRunAfter: true });
            yield* setState({ phase: "restarting", version });
            yield* updater.quitForUpdate;
          }),
        ),
      ),
      Effect.as(true),
      // After a failed install, the helpers come back.
      Effect.catch((error) =>
        setState({ phase: "failed", problem: error.message }).pipe(
          Effect.andThen(options.restartHelpers),
          Effect.as(false),
        ),
      ),
    );
  const install = Effect.suspend(() => {
    if (Option.isSome(attempt)) return Deferred.await(attempt.value);
    const state = latest.state;
    if (state.phase !== "ready") return Effect.succeed(false);
    const done = Deferred.makeUnsafe<boolean>();
    attempt = Option.some(done);
    return attemptInstall(state.version).pipe(
      Effect.tap((installed) =>
        Effect.suspend(() => {
          if (!installed) attempt = Option.none();
          return Deferred.succeed(done, installed);
        }),
      ),
    );
  }).pipe(Effect.withSpan("Updates.install"));

  const setChannel = Effect.fn("Updates.setChannel")(function* (channel: UpdateChannel) {
    if (channel === latest.channel) return;
    yield* fileSystem
      .writeFileString(options.settingsPath, encodeSettings({ channel }))
      .pipe(
        Effect.mapError((cause) => new UpdateSettingsError({ path: options.settingsPath, cause })),
      );
    const state: UpdateState = latest.state.phase === "off" ? latest.state : { phase: "idle" };
    yield* setStatus({ channel, state });
    if (state.phase === "off") return;
    yield* applyChannel(channel);
    yield* check;
  });

  if (Option.isNone(off)) {
    const services = yield* Effect.context<never>();
    const run = (effect: Effect.Effect<void>) => {
      Effect.runForkWith(services)(effect);
    };
    // The updater downloads and installs only on its own steps below.
    yield* updater.setAutoDownload(false);
    yield* updater.setAutoInstallOnAppQuit(false);
    yield* applyChannel(latest.channel);
    yield* updater.on("update-available", (info) => run(onAvailable(info)));
    yield* updater.on("update-not-available", () => run(setState({ phase: "idle" })));
    yield* updater.on("update-downloaded", (info) => run(onDownloaded(info)));
    yield* updater.on("error", (error) =>
      run(setState({ phase: "failed", problem: describe(error) })),
    );
    yield* Effect.sleep(FIRST_CHECK).pipe(
      Effect.andThen(check.pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY)))),
      Effect.forkScoped,
    );
  }

  const updates: Updates = {
    current: () => latest,
    changes: SubscriptionRef.changes(status),
    check,
    setChannel,
    install,
  };
  return updates;
});
