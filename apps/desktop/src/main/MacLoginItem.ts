import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// The start at the sign-in to the Mac, hidden, so a switch left on goes on again (docs/adr/0006):
// a LaunchAgent of the person's own opens the app with `--hidden`, which Electron's login item on
// macOS 13 and later cannot pass. No administrator; macOS says once that a background item exists.

// The agent's label, and its file in ~/Library/LaunchAgents.
export const LABEL = "io.lazurio.app.login";

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// The installed app's bundle, from its executable: only one in /Applications or ~/Applications,
// so a trial build unpacked elsewhere never becomes the one that starts at sign-in.
export const installedBundle = (executable: string, home: string): Option.Option<string> => {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/u.exec(executable);
  if (match === null) return Option.none();
  const bundle = match[1] ?? "";
  const inApplications =
    bundle.startsWith("/Applications/") || bundle.startsWith(`${home}/Applications/`);
  return inApplications && !bundle.slice(0, -4).includes(".app/")
    ? Option.some(bundle)
    : Option.none();
};

// The agent: at the sign-in, open the bundle in the background with `--hidden`.
export const launchAgent = (bundle: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/usr/bin/open</string>",
    "    <string>-g</string>",
    "    <string>-a</string>",
    `    <string>${escapeXml(bundle)}</string>`,
    "    <string>--args</string>",
    "    <string>--hidden</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>LimitLoadToSessionType</key>",
    "  <string>Aqua</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

// `ensure`, and when the agent cannot be written, `tell` says so to the person: the app would not
// start at the sign-in, so the switches they left on would not go on again by themselves.
export const ensureOrTell = (home: string, bundle: string, tell: Effect.Effect<void>) =>
  ensure(home, bundle).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning("the start at the sign-in to the Mac could not be set", {
        problem: String(error),
      }).pipe(Effect.andThen(tell)),
    ),
  );

// Writes the agent for `bundle` when it is missing or names another place; changes nothing else.
export const ensure = Effect.fn("MacLoginItem.ensure")(function* (home: string, bundle: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = paths.join(home, "Library", "LaunchAgents");
  const file = paths.join(directory, `${LABEL}.plist`);
  const wanted = launchAgent(bundle);
  const present = yield* fileSystem.readFileString(file).pipe(Effect.option);
  if (Option.isSome(present) && present.value === wanted) return false;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(`${file}.new`, wanted, { mode: 0o644 });
  yield* fileSystem.rename(`${file}.new`, file);
  return true;
});
