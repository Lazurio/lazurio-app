import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AuthClientShape } from "./AuthClient.ts";

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
