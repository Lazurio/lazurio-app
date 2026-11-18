import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as SubscriptionRef from "effect/SubscriptionRef";

import { signOutOf, withoutSwitches } from "./Account.ts";
import type { AuthState } from "./AuthClient.ts";

describe("Account.signOutOf", () => {
  it.effect("signs out through Agent Desktop's switches when they exist", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const record = (call: string) =>
        Effect.sync(() => {
          calls.push(call);
        });
      yield* signOutOf(Option.some({ signOut: record("switches") }), { signOut: record("auth") });
      assert.deepStrictEqual(calls, ["switches"]);
    }),
  );

  it.effect("signs out of the app itself without a Device helper, absent or failed", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* signOutOf<never>(Option.none(), {
        signOut: Effect.sync(() => {
          calls.push("auth");
        }),
      });
      assert.deepStrictEqual(calls, ["auth"]);
    }),
  );

  // The state Agent Desktop's section shows when its helper did not start: the app's real account,
  // a sign-out that ends it, and a change that reaches the window.
  it.effect("shows and ends the real account when the Device helper failed or is absent", () =>
    Effect.gen(function* () {
      for (const reason of ["failed", "absent"] as const) {
        const state = yield* SubscriptionRef.make<AuthState>("signedIn");
        const controls = yield* withoutSwitches(reason, {
          state: SubscriptionRef.get(state),
          changes: SubscriptionRef.changes(state),
          signOut: SubscriptionRef.set(state, "signedOut"),
        });
        assert.deepStrictEqual(
          [controls.current().state, controls.current().account],
          [reason, "signed-in"],
        );
        const notified = yield* Deferred.make<void>();
        const stop = controls.subscribe(() => {
          if (controls.current().account === "signed-out") {
            Deferred.doneUnsafe(notified, Exit.void);
          }
        });
        yield* controls.signOut;
        yield* Deferred.await(notified);
        assert.strictEqual(controls.current().account, "signed-out");
        stop();
      }
    }).pipe(Effect.scoped),
  );
});
