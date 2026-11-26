import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// The address of the account's sign-in under way, which the network bar may copy for a browser
// other than the system's (SignInIpc). Each attempt from the bar starts without an address and
// ends without one, whatever ends it, so a copy never gives an earlier attempt's expired address.
export const make = (changed: () => void) => {
  let address = Option.none<string>();
  const set = (next: Option.Option<string>) => {
    address = next;
    changed();
  };
  return {
    // The address the current attempt handed to the system's browser.
    offer: (next: string) => set(Option.some(next)),
    // Forgets the address, for a sign-in that ended outside an attempt (the account changed).
    clear: () => set(Option.none()),
    attempt: <A, E, R>(signIn: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        set(Option.none());
        return signIn;
      }).pipe(Effect.ensuring(Effect.sync(() => set(Option.none())))),
    current: (): Option.Option<string> => address,
  };
};
