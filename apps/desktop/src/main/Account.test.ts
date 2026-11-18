import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { signOutOf } from "./Account.ts";

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
});
