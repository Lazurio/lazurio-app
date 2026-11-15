import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { installThenQuit, type Installer } from "./UpdateInstall.ts";

// The installer as electron-updater's BaseUpdater.install behaves: it returns false when it cannot
// start the installer (no downloaded file, an install already called, or a failed spawn, which it
// reports as `error`), and it throws nothing.
const installer = (started: boolean, calls: Array<string>): Installer => ({
  install: (isSilent, isForceRunAfter) => {
    calls.push(`install silent=${isSilent} runAfter=${isForceRunAfter}`);
    return started;
  },
});

describe("installThenQuit", () => {
  it.effect("quits only after the installer started", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* installThenQuit(
        installer(true, calls),
        { isSilent: true, isForceRunAfter: true },
        () => calls.push("quit"),
      );
      assert.deepStrictEqual(calls, ["install silent=true runAfter=true", "quit"]);
    }),
  );

  it.effect("fails and stays running when install returns false", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const exit = yield* installThenQuit(
        installer(false, calls),
        { isSilent: true, isForceRunAfter: true },
        () => calls.push("quit"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(calls, ["install silent=true runAfter=true"]);
    }),
  );

  it.effect("fails when install throws", () =>
    Effect.gen(function* () {
      const exit = yield* installThenQuit(
        {
          install: () => {
            throw new Error("spawn failed");
          },
        },
        { isSilent: true, isForceRunAfter: true },
        () => undefined,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
