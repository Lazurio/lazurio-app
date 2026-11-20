import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { permissionStep } from "../shared/macPermissions.ts";
import * as MacPermissions from "./MacPermissions.ts";

// macOS as MacPermissions sees it: the test sets what is allowed and records what it was asked.
const fakeMac = (allowed: { accessibility: boolean; screen: boolean }) => {
  const calls: Array<string> = [];
  const system: MacPermissions.PermissionSystem = {
    read: Effect.sync(() => {
      calls.push("read");
      return { ...allowed };
    }),
    enlist: (kind) =>
      Effect.sync(() => {
        calls.push(`enlist ${kind}`);
      }),
    openPane: (address) =>
      Effect.sync(() => {
        calls.push(`open ${address}`);
      }),
    restart: Effect.sync(() => {
      calls.push("restart");
    }),
  };
  return { allowed, calls, system };
};

const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

describe("MacPermissions", () => {
  it.effect("shows nothing until a switch found a permission missing", () =>
    Effect.gen(function* () {
      const mac = fakeMac({ accessibility: false, screen: false });
      const permissions = MacPermissions.make({ platform: "darwin", system: mac.system });
      yield* permissions.refresh;
      assert.isUndefined(permissions.current());
      assert.deepStrictEqual(mac.calls, []);
      assert.isFalse(yield* permissions.allowSwitch);
      assert.deepStrictEqual(permissions.current(), {
        accessibility: false,
        screen: false,
        screenPaneOpened: false,
      });
    }),
  );

  it.effect("lists the app and opens the pane of the permission asked for, nothing else", () =>
    Effect.gen(function* () {
      const mac = fakeMac({ accessibility: false, screen: false });
      const permissions = MacPermissions.make({ platform: "darwin", system: mac.system });
      yield* permissions.allowSwitch;
      mac.calls.length = 0;
      yield* permissions.openSettings("accessibility");
      assert.deepStrictEqual(mac.calls, ["enlist accessibility", `open ${ACCESSIBILITY_PANE}`]);
      assert.isFalse(permissions.current()?.screenPaneOpened);
      mac.calls.length = 0;
      yield* permissions.openSettings("screen");
      assert.deepStrictEqual(mac.calls, ["enlist screen", `open ${SCREEN_PANE}`]);
      assert.isTrue(permissions.current()?.screenPaneOpened);
    }),
  );

  it.effect(
    "offers the restart once only Screen Recording is missing and its pane was opened",
    () =>
      Effect.gen(function* () {
        const mac = fakeMac({ accessibility: false, screen: false });
        const permissions = MacPermissions.make({ platform: "darwin", system: mac.system });
        yield* permissions.allowSwitch;
        const current = () => {
          const now = permissions.current();
          if (now === undefined) return assert.fail("no permissions shown");
          return now;
        };
        assert.deepStrictEqual(permissionStep(current()), {
          action: "open",
          kind: "accessibility",
        });
        // Not offered yet: the restart is refused.
        const early = yield* Effect.exit(permissions.restartApp);
        assert.isTrue(Exit.isFailure(early));
        mac.allowed.accessibility = true;
        yield* permissions.refresh;
        assert.deepStrictEqual(permissionStep(current()), { action: "open", kind: "screen" });
        yield* permissions.openSettings("screen");
        assert.deepStrictEqual(permissionStep(current()), { action: "restart" });
        yield* permissions.restartApp;
        assert.include(mac.calls, "restart");
      }),
  );

  it.effect("tells the window when a read changes something, and goes once both are allowed", () =>
    Effect.gen(function* () {
      const mac = fakeMac({ accessibility: false, screen: true });
      const permissions = MacPermissions.make({ platform: "darwin", system: mac.system });
      let changes = 0;
      permissions.subscribe(() => {
        changes += 1;
      });
      yield* permissions.allowSwitch;
      assert.strictEqual(changes, 2);
      // A read that finds the same changes nothing.
      yield* permissions.refresh;
      assert.strictEqual(changes, 2);
      mac.allowed.accessibility = true;
      yield* permissions.refresh;
      assert.strictEqual(changes, 3);
      assert.isUndefined(permissions.current());
      // Hidden, it reads no more.
      const reads = mac.calls.length;
      yield* permissions.refresh;
      assert.strictEqual(mac.calls.length, reads);
      assert.isTrue(yield* permissions.allowSwitch);
    }),
  );

  it.effect("does nothing off macOS", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "linux"]) {
        const mac = fakeMac({ accessibility: false, screen: false });
        const permissions = MacPermissions.make({ platform, system: mac.system });
        assert.isTrue(yield* permissions.allowSwitch);
        yield* permissions.refresh;
        assert.isUndefined(permissions.current());
        const opened = yield* Effect.flip(permissions.openSettings("accessibility"));
        assert.strictEqual(opened.problem, "not-mac");
        const restarted = yield* Effect.flip(permissions.restartApp);
        assert.strictEqual(restarted.problem, "not-mac");
        assert.deepStrictEqual(mac.calls, []);
      }
    }),
  );

  it.effect("takes only a known kind from the window", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* MacPermissions.decodeKind("accessibility"), "accessibility");
      assert.strictEqual(yield* MacPermissions.decodeKind("screen"), "screen");
      for (const argument of [
        "camera",
        "Privacy_ScreenCapture",
        SCREEN_PANE,
        { kind: "screen" },
        ["screen"],
        undefined,
      ]) {
        const decoded = yield* Effect.exit(MacPermissions.decodeKind(argument));
        assert.isTrue(Exit.isFailure(decoded), String(argument));
      }
    }),
  );
});
