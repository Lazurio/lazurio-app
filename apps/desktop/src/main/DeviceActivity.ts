import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// Whether an agent works on this computer through the Device helper, as the updater needs it: an
// update never installs while an agent holds the computer (docs/adr/0006, point 7). DeviceService
// replaces this reference while the Device helper runs; without it, the computer is always idle.

export interface DeviceActivityShape {
  readonly isIdle: Effect.Effect<boolean>;
  // Each change of `isIdle`.
  readonly idleChanges: Stream.Stream<boolean>;
  // `true` only when the computer is idle; until the scope closes, the Device helper then refuses
  // every new call of a tool. On `false`, wait for the next `true` of `idleChanges` and ask again.
  readonly holdForUpdate: Effect.Effect<boolean, never, Scope.Scope>;
  // After the helpers stopped, right before an install: `true` only when the updater's hold was
  // still granted by the helper's last word on the lock, the Device helper said DeviceStopped with
  // every engine ended, and it exited within two seconds. On `false` nothing installs.
  readonly confirmStopped: Effect.Effect<boolean>;
}

const alwaysIdle: DeviceActivityShape = {
  isIdle: Effect.succeed(true),
  idleChanges: Stream.empty,
  holdForUpdate: Effect.succeed(true),
  confirmStopped: Effect.succeed(true),
};

export const DeviceActivity = Context.Reference<DeviceActivityShape>(
  "@lazurio/app-desktop/DeviceActivity",
  { defaultValue: () => alwaysIdle },
);
