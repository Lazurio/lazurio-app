import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { SIGN_IN_CHANNEL } from "../shared/bridge.ts";
import type { AuthClientShape, AuthUnreachableError, SignInError } from "./AuthClient.ts";
import { destinationOf } from "./Navigation.ts";

type SignInFailure = SignInError | AuthUnreachableError;

class SignInIpcRefused extends Schema.TaggedError<SignInIpcRefused>()("SignInIpcRefused", {}) {
  override get message(): string {
    return "refused: not a local window of the app";
  }
}

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

// The local windows' sign-in to Lazurio for the person's networks: the app's own sign-in in the
// system's browser (AuthClient), after which `follow` reads the directory.
export const serve = Effect.fn("SignInIpc.serve")(function* (auth: AuthClientShape) {
  const services = yield* Effect.context<never>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Electron.ipcMain.handle(SIGN_IN_CHANNEL, (event) =>
        Effect.runPromiseWith(services)<void, SignInIpcRefused | SignInFailure>(
          isLocalSender(event) ? auth.signIn : Effect.fail(new SignInIpcRefused()),
        ),
      ),
    ),
    () => Effect.sync(() => Electron.ipcMain.removeHandler(SIGN_IN_CHANNEL)),
  );
});
