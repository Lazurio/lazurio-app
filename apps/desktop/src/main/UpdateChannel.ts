import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The update channels of Lazurio App (docs/adr/0005), named as electron-updater names their feed
// files: `latest` (stable, latest.yml) and `nightly` (nightly.yml). Same names and version shapes
// as T3 Code's updater (Lazurio/t3code, apps/desktop/src/updates).

export const UpdateChannel = Schema.Literals(["latest", "nightly"]);
export type UpdateChannel = typeof UpdateChannel.Type;

// Stable is X.Y.Z, nightly X.Y.Z-nightly.YYYYMMDD.N.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/u;
const NIGHTLY = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/u;

interface Version {
  readonly core: readonly [number, number, number];
  // Absent for a stable release, which SemVer orders above every nightly of the same core.
  readonly nightly: Option.Option<readonly [number, number]>;
}

const parse = (version: string): Option.Option<Version> => {
  const stable = STABLE.exec(version);
  if (stable !== null) {
    return Option.some({
      core: [Number(stable[1]), Number(stable[2]), Number(stable[3])],
      nightly: Option.none(),
    });
  }
  const nightly = NIGHTLY.exec(version);
  if (nightly !== null) {
    return Option.some({
      core: [Number(nightly[1]), Number(nightly[2]), Number(nightly[3])],
      nightly: Option.some([Number(nightly[4]), Number(nightly[5])]),
    });
  }
  return Option.none();
};

// The channel a build starts on: the channel of its own version.
export const channelOfVersion = (version: string): UpdateChannel =>
  NIGHTLY.test(version) ? "nightly" : "latest";

const compareNumbers = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(left.length - right.length);
};

// SemVer's order for the two shapes: core first, then a stable above any nightly of its core.
const compare = (left: Version, right: Version): number => {
  const core = compareNumbers(left.core, right.core);
  if (core !== 0) return core;
  if (Option.isNone(left.nightly)) return Option.isNone(right.nightly) ? 0 : 1;
  if (Option.isNone(right.nightly)) return -1;
  return compareNumbers(left.nightly.value, right.nightly.value);
};

// Whether the app installs an offered version: one of the selected channel, and newer than the
// running build. The app never downgrades, so a switch from nightly to stable waits until a stable
// release is newer than the nightly that runs (T3 Code's channel floor). A version of another shape
// is never offered.
export const isOffered = (options: {
  readonly running: string;
  readonly offered: string;
  readonly channel: UpdateChannel;
}): boolean => {
  const running = parse(options.running);
  const offered = parse(options.offered);
  if (Option.isNone(offered) || channelOfVersion(options.offered) !== options.channel) return false;
  // A running build of another shape (a development build) takes any release of its channel.
  return Option.isNone(running) || compare(offered.value, running.value) > 0;
};

// The person's choice, kept in `<userData>/updates.json`.
const UpdateSettings = Schema.Struct({ channel: UpdateChannel });
export type UpdateSettings = typeof UpdateSettings.Type;

const decodeSettingsOption = Schema.decodeUnknownOption(Schema.fromJsonString(UpdateSettings));

// The settings in the file, or the build's own channel when there is no file or it does not decode.
export const settingsFrom = (text: Option.Option<string>, appVersion: string): UpdateSettings =>
  Option.flatMap(text, decodeSettingsOption).pipe(
    Option.getOrElse(() => ({ channel: channelOfVersion(appVersion) })),
  );

export const encodeSettings = (settings: UpdateSettings): string =>
  `${JSON.stringify({ channel: settings.channel }, null, 2)}\n`;
