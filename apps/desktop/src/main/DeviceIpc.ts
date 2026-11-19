import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import {
  DEVICE_ADD_ENVIRONMENT_CHANNEL,
  DEVICE_OPEN_WINDOW_CHANNEL,
  DEVICE_REMOVE_ENVIRONMENT_CHANNEL,
  DEVICE_SET_SWITCH_CHANNEL,
  DEVICE_SIGN_OUT_CHANNEL,
  DEVICE_STATE_CHANGED_CHANNEL,
  DEVICE_STATE_CHANNEL,
  DEVICE_STOP_CHANNEL,
  type DeviceStatus,
} from "../shared/bridge.ts";
import type { DeviceRequestError } from "./DeviceService.ts";
import type { DeviceSwitchError } from "./DeviceSwitches.ts";
import { localViews } from "./Hardening.ts";
import { destinationOf } from "./Navigation.ts";

// Agent Desktop's requests from the app's local windows (docs/adr/0006, point 5): state, Stop, the
// switches, adding and removing an Environment, signing out. Only a local view of the app may ask,
// so only a native window turns a switch on; a remote page has no preload and is refused here too.
// Every argument goes through Schema.

export interface DeviceControls {
  readonly current: () => DeviceStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly stop: Effect.Effect<void, DeviceRequestError>;
  readonly setSwitch: (origin: string, on: boolean) => Effect.Effect<void, DeviceSwitchError>;
  readonly addEnvironment: (origin: string) => Effect.Effect<void, DeviceSwitchError>;
  readonly removeEnvironment: (origin: string) => Effect.Effect<void, DeviceSwitchError>;
  readonly signOut: Effect.Effect<void, DeviceSwitchError>;
  readonly openWindow: Effect.Effect<void>;
}

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return (
    url !== undefined && destinationOf(url)._tag === "Local" && localViews().includes(event.sender)
  );
};

const decodeNoArgument = Schema.decodeUnknownEffect(Schema.Undefined);
const decodeSwitch = Schema.decodeUnknownEffect(
  Schema.Struct({ origin: Schema.String, on: Schema.Boolean }),
);
const decodeOrigin = Schema.decodeUnknownEffect(Schema.String);

class DeviceIpcRefused extends Schema.TaggedError<DeviceIpcRefused>()("DeviceIpcRefused", {}) {
  override get message(): string {
    return "refused: not a local window of the app";
  }
}

export const serve = Effect.fn("DeviceIpc.serve")(function* (device: DeviceControls) {
  const services = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect);
  const handle = <A, E>(channel: string, answer: (argument: unknown) => Effect.Effect<A, E>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Electron.ipcMain.handle(channel, (event, argument: unknown) =>
          run<A, E | DeviceIpcRefused>(
            isLocalSender(event) ? answer(argument) : Effect.fail(new DeviceIpcRefused()),
          ),
        ),
      ),
      () => Effect.sync(() => Electron.ipcMain.removeHandler(channel)),
    );
  yield* handle(DEVICE_STATE_CHANNEL, (argument) =>
    decodeNoArgument(argument).pipe(Effect.map(() => device.current())),
  );
  yield* handle(DEVICE_STOP_CHANNEL, (argument) =>
    decodeNoArgument(argument).pipe(Effect.andThen(device.stop)),
  );
  yield* handle(DEVICE_SET_SWITCH_CHANNEL, (argument) =>
    decodeSwitch(argument).pipe(Effect.flatMap(({ origin, on }) => device.setSwitch(origin, on))),
  );
  yield* handle(DEVICE_ADD_ENVIRONMENT_CHANNEL, (argument) =>
    decodeOrigin(argument).pipe(Effect.flatMap(device.addEnvironment)),
  );
  yield* handle(DEVICE_REMOVE_ENVIRONMENT_CHANNEL, (argument) =>
    decodeOrigin(argument).pipe(Effect.flatMap(device.removeEnvironment)),
  );
  yield* handle(DEVICE_OPEN_WINDOW_CHANNEL, (argument) =>
    decodeNoArgument(argument).pipe(Effect.andThen(device.openWindow)),
  );
  yield* handle(DEVICE_SIGN_OUT_CHANNEL, (argument) =>
    decodeNoArgument(argument).pipe(Effect.andThen(device.signOut)),
  );
  // Every change goes to every local window. A window reads the state after subscribing, so no
  // change falls between.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      device.subscribe(() => {
        const status = device.current();
        for (const contents of localViews()) contents.send(DEVICE_STATE_CHANGED_CHANNEL, status);
      }),
    ),
    (stop) => Effect.sync(stop),
  );
});
