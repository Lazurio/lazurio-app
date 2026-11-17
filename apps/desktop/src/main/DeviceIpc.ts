import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import {
  DEVICE_STATE_CHANGED_CHANNEL,
  DEVICE_STATE_CHANNEL,
  DEVICE_STOP_CHANNEL,
  type DeviceStatus,
} from "../shared/bridge.ts";
import type { DeviceRequestError } from "./DeviceService.ts";
import { localViews } from "./Hardening.ts";
import { destinationOf } from "./Navigation.ts";

// Agent Desktop's requests from the app's local windows (docs/adr/0006, point 5): its state and
// Stop. Only a local view of the app, showing the app's own files, may ask; a remote page has no
// preload and is refused here as well. Every argument goes through Schema.

export interface DeviceControls {
  readonly current: () => DeviceStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly stop: Effect.Effect<void, DeviceRequestError>;
}

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return (
    url !== undefined && destinationOf(url)._tag === "Local" && localViews().includes(event.sender)
  );
};

// Neither request takes an argument.
const decodeNoArgument = Schema.decodeUnknownEffect(Schema.Undefined);

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
