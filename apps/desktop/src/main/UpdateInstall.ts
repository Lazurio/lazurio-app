import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Starts a downloaded update's installer and quits only once it started. electron-updater's
// quitAndInstall returns nothing either way (6.8.9, BaseUpdater), while its install says whether
// the installer started; on a failure Updates.ts starts the stopped helpers again.

class UpdateInstallError extends Schema.TaggedError<UpdateInstallError>()("UpdateInstallError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "the update's installer did not start";
  }
}

// electron-updater's BaseUpdater (NSIS on Windows, AppImage on Linux), as far as installing goes.
export interface Installer {
  readonly install: (isSilent: boolean, isForceRunAfter: boolean) => boolean;
}

export const installThenQuit = Effect.fn("UpdateInstall.installThenQuit")(function* (
  installer: Installer,
  options: { readonly isSilent: boolean; readonly isForceRunAfter: boolean },
  quit: () => void,
) {
  const started = yield* Effect.try({
    try: () => installer.install(options.isSilent, options.isForceRunAfter),
    catch: (cause) => new UpdateInstallError({ cause }),
  });
  if (!started) return yield* new UpdateInstallError({ cause: "install returned false" });
  yield* Effect.sync(quit);
});
