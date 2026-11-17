import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { startAll } from "./Helpers.ts";

// A helper's last messages after Shutdown reach the app before the app learns that the helper
// stopped (docs/adr/0006, point 7): the updater installs only on a DeviceStopped it has read.
// Real processes on the real clock: the two seconds a helper gets to exit are the system's.

const runFake = (afterShutdown: "stop" | "linger") =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fake = path.join(import.meta.dirname, "fake-device-helper.ts");
    const helpersScope = yield* Scope.make();
    const [helper] = yield* startAll([
      { name: "lazurio-device", path: process.execPath, args: [fake, afterShutdown] },
    ]).pipe(Scope.provide(helpersScope));
    if (helper === undefined || Option.isNone(helper.connection)) {
      return assert.fail(`the fake helper did not start: ${JSON.stringify(helper?.status)}`);
    }
    const connection = helper.connection.value;
    // Read outside the helpers' scope, as the main process does.
    const reading = yield* connection.events.pipe(
      Stream.map((message) => message.kind.case),
      Stream.runCollect,
      Effect.forkScoped,
    );
    assert.isFalse(yield* connection.stopping);
    yield* Scope.close(helpersScope, Exit.void);
    assert.isTrue(yield* connection.stopping);
    const stopped = yield* connection.stopped;
    // The events end once the helper's output ended; a helper still running keeps them open.
    const received = stopped ? [...(yield* Fiber.join(reading))] : [];
    return { stopped, received };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Helpers", () => {
  it.live(
    "confirms a stop only after the helper's output ended with its last message, then ends its events",
    () =>
      Effect.gen(function* () {
        const { stopped, received } = yield* runFake("stop");
        assert.isTrue(stopped);
        assert.deepStrictEqual(received, ["deviceStopped"]);
      }),
  );

  it.live("does not confirm the stop of a helper that does not exit within two seconds", () =>
    Effect.gen(function* () {
      const { stopped } = yield* runFake("linger");
      assert.isFalse(stopped);
    }),
  );

  it.live(
    "fails a request at once when the helper's output ends, and never says the app stopped it",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fake = path.join(import.meta.dirname, "fake-device-helper.ts");
        const [helper] = yield* startAll([
          { name: "lazurio-device", path: process.execPath, args: [fake, "crash"] },
        ]);
        if (helper === undefined || Option.isNone(helper.connection)) {
          return assert.fail(`the fake helper did not start: ${JSON.stringify(helper?.status)}`);
        }
        const connection = helper.connection.value;
        assert.isNumber(connection.pid);
        const ending = yield* connection.events.pipe(Stream.runDrain, Effect.forkScoped);
        const answer = yield* connection
          .request({ case: "stopAgent", value: {} })
          .pipe(Effect.flip);
        assert.include(answer.message, "its output ended");
        yield* Fiber.join(ending);
        const again = yield* connection.request({ case: "stopAgent", value: {} }).pipe(Effect.flip);
        assert.include(again.message, "its output ended");
        assert.isFalse(yield* connection.stopping);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends by its PID a helper whose output ended while its process runs on", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fake = path.join(import.meta.dirname, "fake-device-helper.ts");
      const [helper] = yield* startAll([
        { name: "lazurio-device", path: process.execPath, args: [fake, "mute"] },
      ]);
      if (helper === undefined || Option.isNone(helper.connection)) {
        return assert.fail(`the fake helper did not start: ${JSON.stringify(helper?.status)}`);
      }
      const connection = helper.connection.value;
      yield* connection.events.pipe(Stream.runDrain);
      assert.isFalse(yield* connection.stopping);
      assert.isTrue(isAlive(connection.pid));
      yield* connection.end;
      assert.isFalse(isAlive(connection.pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Signal 0 checks that the process exists and ends nothing.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
