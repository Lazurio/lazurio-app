import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// Whether an agent works on this computer through the Device helper (LZD-0018, docs/adr/0006),
// as the updater needs it: an update never installs while an agent holds the computer
// (docs/adr/0005, point 5). The Device helper's layer replaces this reference; until it exists,
// the computer is always idle.

export interface DeviceActivityShape {
  readonly isIdle: Effect.Effect<boolean>;
  // Each change of `isIdle`.
  readonly idleChanges: Stream.Stream<boolean>;
  // `true` only when the computer is idle; until the scope closes, the Device helper then refuses
  // every new call of a tool. On `false`, wait for the next `true` of `idleChanges` and ask again.
  readonly holdForUpdate: Effect.Effect<boolean, never, Scope.Scope>;
}

const alwaysIdle: DeviceActivityShape = {
  isIdle: Effect.succeed(true),
  idleChanges: Stream.empty,
  holdForUpdate: Effect.succeed(true),
};

export const DeviceActivity = Context.Reference<DeviceActivityShape>(
  "@lazurio/app-desktop/DeviceActivity",
  { defaultValue: () => alwaysIdle },
);
