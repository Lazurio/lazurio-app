import * as Effect from "effect/Effect";

// Opens an address in the system's browser, and when the system cannot (on Windows, for example,
// an account with no application for links) offers the address to copy instead of failing: the
// app's sign-in then keeps waiting for the return on its loopback address, within its own time
// limit and its sign-out, while the person opens the copied address themselves.
export const openOrOffer = (
  open: (address: string) => Promise<void>,
  offer: (address: string) => void,
) =>
  Effect.fn("BrowserOpen.openOrOffer")(function* (address: string) {
    const opened = yield* Effect.promise(() =>
      open(address).then(
        () => true,
        () => false,
      ),
    );
    if (!opened) offer(address);
  });
