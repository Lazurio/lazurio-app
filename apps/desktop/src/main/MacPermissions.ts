import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DevicePermissionKind, DevicePermissions } from "../shared/bridge.ts";
import { permissionStep } from "../shared/macPermissions.ts";

// macOS's permissions for Agent Desktop (docs/adr/0006, point 6). On a Mac a switch goes on only
// with Accessibility and Screen Recording allowed; otherwise it stays off and the window shows both
// from that click until both are allowed. Off macOS nothing is read. Without Electron, for tests.

// The panes of System Settings, and no other address: the window sends only the kind.
const SETTINGS_PANES: Readonly<Record<DevicePermissionKind, string>> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

// The window's argument for openPermissionSettings: a kind, and nothing else.
export const decodeKind = Schema.decodeUnknownEffect(Schema.Literals(["accessibility", "screen"]));

export class MacPermissionsError extends Schema.TaggedError<MacPermissionsError>()(
  "MacPermissionsError",
  {
    // not-mac: this is no Mac; not-offered: the window offers no restart now; not-opened: System
    // Settings did not open.
    problem: Schema.Literals(["not-mac", "not-offered", "not-opened"]),
  },
) {
  override get message(): string {
    return `macOS's permissions: ${this.problem}`;
  }
}

// What macOS answers and does. Reading asks nothing and writes nothing.
export interface PermissionSystem {
  readonly read: Effect.Effect<{ readonly accessibility: boolean; readonly screen: boolean }>;
  // Puts the app into the permission's list in System Settings, with macOS's own prompt, without
  // capturing anything.
  readonly enlist: (kind: DevicePermissionKind) => Effect.Effect<void>;
  readonly openPane: (address: string) => Effect.Effect<void, MacPermissionsError>;
  // Starts the app again: the app quits its own way, as with Quit in the tray.
  readonly restart: Effect.Effect<void>;
}

export interface MacPermissions {
  // Whether a switch may go on now. Always off macOS; on a Mac only with both allowed, and when one
  // is missing the window shows them from then on.
  readonly allowSwitch: Effect.Effect<boolean>;
  // For the window: only on a Mac, after a refused switch, while one is missing.
  readonly current: () => DevicePermissions | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  // Reads both again while the window shows them; the window's focus and a timer call it.
  readonly refresh: Effect.Effect<void>;
  readonly openSettings: (kind: DevicePermissionKind) => Effect.Effect<void, MacPermissionsError>;
  readonly restartApp: Effect.Effect<void, MacPermissionsError>;
}

export const make = (options: {
  readonly platform: string;
  readonly system: PermissionSystem;
}): MacPermissions => {
  const { platform, system } = options;
  const mac = platform === "darwin";
  const listeners = new Set<() => void>();
  // Set by the first click on a switch that found a permission missing; until then nothing shows.
  let asked = false;
  let state: DevicePermissions = { accessibility: false, screen: false, screenPaneOpened: false };
  const missing = () => !state.accessibility || !state.screen;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  // Reads both and tells the window when something changed.
  const read = Effect.gen(function* () {
    const now = yield* system.read;
    if (now.accessibility === state.accessibility && now.screen === state.screen) return;
    state = { ...state, ...now };
    changed();
  });
  const shown = () => mac && asked && missing();
  const notMac = new MacPermissionsError({ problem: "not-mac" });

  return {
    allowSwitch: Effect.gen(function* () {
      if (!mac) return true;
      yield* read;
      if (!missing()) return true;
      if (!asked) {
        asked = true;
        changed();
      }
      yield* Effect.logWarning("Agent Desktop's switch stays off: macOS permissions are missing", {
        accessibility: state.accessibility,
        screen: state.screen,
      });
      return false;
    }),
    current: () => (shown() ? state : undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: Effect.suspend(() => (shown() ? read : Effect.void)),
    openSettings: Effect.fn("MacPermissions.openSettings")(function* (kind: DevicePermissionKind) {
      if (!mac) return yield* notMac;
      yield* system.enlist(kind);
      yield* system.openPane(SETTINGS_PANES[kind]);
      if (kind === "screen" && !state.screenPaneOpened) {
        state = { ...state, screenPaneOpened: true };
        changed();
      }
    }),
    restartApp: Effect.gen(function* () {
      if (!mac) return yield* notMac;
      if (!shown() || permissionStep(state).action !== "restart") {
        return yield* new MacPermissionsError({ problem: "not-offered" });
      }
      yield* Effect.logInfo("the app restarts for Screen Recording");
      yield* system.restart;
    }),
  };
};
