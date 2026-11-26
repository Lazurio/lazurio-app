import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { make } from "./SignInAddress.ts";

describe("the address of the sign-in under way", () => {
  it.effect("is gone after a failed attempt, and a retry offers only its own", () =>
    Effect.gen(function* () {
      let changes = 0;
      const address = make(() => {
        changes += 1;
      });
      // The first attempt hands its address to the browser, then fails (a timeout, a denial).
      const failed = yield* Effect.flip(
        address.attempt(
          Effect.sync(() => address.offer("https://auth/first")).pipe(
            Effect.andThen(Effect.fail("timed out" as const)),
          ),
        ),
      );
      assert.strictEqual(failed, "timed out");
      assert.isTrue(Option.isNone(address.current()));
      // An immediate retry: nothing to copy while it has not handed over its own address.
      const offered = yield* Deferred.make<void>();
      const handedOver = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const retry = yield* Effect.forkChild(
        address.attempt(
          Deferred.await(offered).pipe(
            Effect.andThen(Effect.sync(() => address.offer("https://auth/second"))),
            Effect.andThen(Deferred.succeed(handedOver, undefined)),
            Effect.andThen(Deferred.await(proceed)),
          ),
        ),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(address.current()));
      yield* Deferred.succeed(offered, undefined);
      yield* Deferred.await(handedOver);
      assert.deepStrictEqual(address.current(), Option.some("https://auth/second"));
      // The attempt ends: nothing to copy any more.
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(retry);
      assert.isTrue(Option.isNone(address.current()));
      assert.isAbove(changes, 3);
    }),
  );

  it.effect("keeps the running attempt's address when another window asks for a sign-in", () =>
    Effect.gen(function* () {
      const address = make(() => {});
      const handedOver = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        address.attempt(
          Effect.sync(() => address.offer("https://auth/first")).pipe(
            Effect.andThen(Deferred.succeed(handedOver, undefined)),
            Effect.andThen(Deferred.await(proceed)),
          ),
        ),
      );
      yield* Deferred.await(handedOver);
      // The network page asks while the bar's attempt waits; AuthClient refuses it.
      const second = yield* Effect.flip(address.attempt(Effect.fail("in-progress" as const)));
      assert.strictEqual(second, "in-progress");
      assert.deepStrictEqual(address.current(), Option.some("https://auth/first"));
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(first);
      assert.isTrue(Option.isNone(address.current()));
    }),
  );
});
