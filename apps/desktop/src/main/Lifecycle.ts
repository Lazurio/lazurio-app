import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { TrayText } from "../ui/messages.ts";

// The app's life outside its window, without Electron so tests can call it: closing the window
// hides it, every quit goes through the program's own end, the start at the sign-in to Windows is
// hidden, and the first hidden window says once where the app went.

// Closing the main window hides it; it closes only while the app quits.
export const closeStep = (quitting: boolean): "hide" | "close" => (quitting ? "close" : "hide");

// Windows and Linux keep the app in the notification area; a Mac keeps it in the Dock.
export const keepsRunningInTray = (platform: string): boolean => platform !== "darwin";

// While the program runs, a before-quit never quits by itself: the program installs a ready
// update or joins an install (Updates.quitDecision), stops the helpers, and only then quits.
export const beforeQuitStep = (
  decision: "install" | "wait" | "quit",
): "install" | "wait" | "end-program" => (decision === "quit" ? "end-program" : decision);

const HIDDEN_ARGUMENT = "--hidden";

export const startsHidden = (argv: ReadonlyArray<string>): boolean =>
  argv.includes(HIDDEN_ARGUMENT);

interface LoginItem {
  readonly openAtLogin: true;
  readonly args: ReadonlyArray<string>;
}

// Only a packaged app on Windows starts at the person's sign-in, hidden and with every switch off
// (docs/adr/0006: the consent lasts one run). Development and tests write nothing to the registry.
export const loginItem = (options: {
  readonly platform: string;
  readonly packaged: boolean;
}): Option.Option<LoginItem> =>
  options.platform === "win32" && options.packaged
    ? Option.some({ openAtLogin: true, args: [HIDDEN_ARGUMENT] })
    : Option.none();

interface TrayActions {
  readonly show: () => void;
  readonly quit: () => void;
}

export const trayMenu = (
  text: TrayText,
  actions: TrayActions,
): ReadonlyArray<{ readonly label: string; readonly click: () => void }> => [
  { label: text.open, click: actions.show },
  { label: text.quit, click: actions.quit },
];

// `<userData>/tray.json`: whether the notice of the first hidden window was shown.
const NoticeFile = Schema.Struct({ hiddenNoticeShown: Schema.Boolean });
const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(NoticeFile));
const encodeNotice = Schema.encodeOption(Schema.fromJsonString(NoticeFile));

// Shows the notice the first time it is asked to, ever: afterwards the file says so. When the file
// cannot be saved, the notice still shows only once in this run.
export const noticeOnce = Effect.fn("Lifecycle.noticeOnce")(function* (
  path: string,
  show: Effect.Effect<void>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let shown = Option.match(
    Option.flatMap(yield* fileSystem.readFileString(path).pipe(Effect.option), decodeNotice),
    { onNone: () => false, onSome: (file) => file.hiddenNoticeShown },
  );
  const save = Effect.gen(function* () {
    const text = encodeNotice({ hiddenNoticeShown: true });
    if (Option.isNone(text)) return;
    const temporary = `${path}.new`;
    yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fileSystem.writeFileString(temporary, `${text.value}\n`);
    yield* fileSystem.rename(temporary, path);
  }).pipe(
    Effect.catch(() => Effect.logWarning("the tray's notice could not be saved; it shows again")),
  );
  return Effect.suspend(() => {
    if (shown) return Effect.void;
    shown = true;
    return show.pipe(Effect.andThen(save));
  });
});
