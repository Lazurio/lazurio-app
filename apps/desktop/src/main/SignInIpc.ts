import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { SIGN_IN_CHANNEL, SIGN_OUT_CHANNEL } from "../shared/bridge.ts";
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
export const serve = Effect.fn("SignInIpc.serve")(function* <E>(
  auth: AuthClientShape,
  signOut: Effect.Effect<void, E>,
) {
  const services = yield* Effect.context<never>();
  const handle = <F>(channel: string, answer: Effect.Effect<void, F>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Electron.ipcMain.handle(channel, (event) =>
          Effect.runPromiseWith(services)<void, F | SignInIpcRefused>(
            isLocalSender(event) ? answer : Effect.fail(new SignInIpcRefused()),
          ),
        ),
      ),
      () => Effect.sync(() => Electron.ipcMain.removeHandler(channel)),
    );
  yield* handle<SignInFailure>(SIGN_IN_CHANNEL, auth.signIn);
  yield* handle(SIGN_OUT_CHANNEL, signOut);
});
