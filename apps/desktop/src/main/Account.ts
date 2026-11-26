import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { AuthClientShape, AuthState } from "./AuthClient.ts";
import type { DeviceControls } from "./DeviceIpc.ts";
import { withoutHelper } from "./DeviceService.ts";
import { DeviceSwitchError } from "./DeviceSwitches.ts";

// The app's sign-out from Lazurio, whether or not Agent Desktop's Device helper runs: through
// Agent Desktop's switches when they exist, which turn every switch off first, and otherwise
// straight through the app's sign-in.
export const signOutOf = <E>(
  switches: Option.Option<{ readonly signOut: Effect.Effect<void, E> }>,
  auth: Pick<AuthClientShape, "signOut">,
): Effect.Effect<void, E | Effect.Error<AuthClientShape["signOut"]>> =>
  Option.match(switches, {
    onSome: (service) => service.signOut,
    onNone: () => auth.signOut,
  });

const accountOf = (state: AuthState) => (state === "signedIn" ? "signed-in" : "signed-out");

// Agent Desktop's controls without its switches, for a Device helper that is absent or failed:
// no Environment to switch, but the app's real account, which still signs out.
export const withoutSwitches = Effect.fn("Account.withoutSwitches")(function* (
  reason: "absent" | "failed",
  auth: Pick<AuthClientShape, "state" | "changes" | "signOut">,
) {
  let account = yield* auth.state;
  const listeners = new Set<() => void>();
  yield* auth.changes.pipe(
    Stream.runForEach((state) =>
      Effect.sync(() => {
        account = state;
        for (const listener of listeners) listener();
      }),
    ),
    Effect.forkScoped,
  );
  const noSwitch = Effect.fail(new DeviceSwitchError({ problem: "not-listed" }));
  return {
    current: () => ({ ...withoutHelper(reason), account: accountOf(account) }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: Effect.void,
    setSwitch: () => noSwitch,
    addEnvironment: () => noSwitch,
    removeEnvironment: () => noSwitch,
    signOut: auth.signOut.pipe(
      Effect.mapError(() => new DeviceSwitchError({ problem: "not-saved" })),
    ),
  } satisfies Omit<DeviceControls, "openWindow" | "openPermissionSettings" | "restartApp">;
});
