import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { INSTALL_UPDATE_CHANNEL, SET_UPDATE_CHANNEL_CHANNEL } from "../shared/bridge.ts";
import { destinationOf } from "./Navigation.ts";
import { UpdateChannel } from "./UpdateChannel.ts";
import type { Updates } from "./Updates.ts";

// The local windows' requests about updates (docs/adr/0005, point 4): pick the channel, install a
// downloaded update. Only a frame of the app's own files may ask, as for the status (MainWindow.ts),
// and the channel goes through Schema.

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

const decodeChannel = Schema.decodeUnknownEffect(UpdateChannel);

class UpdatesIpcRefused extends Schema.TaggedError<UpdatesIpcRefused>()("UpdatesIpcRefused", {}) {
  override get message(): string {
    return "refused: not a local window of the app";
  }
}

export const serve = Effect.fn("UpdatesIpc.serve")(function* (updates: Updates) {
  const services = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect);
  const handle = <E>(channel: string, answer: (argument: unknown) => Effect.Effect<void, E>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Electron.ipcMain.handle(channel, (event, argument: unknown) =>
          run<void, E | UpdatesIpcRefused>(
            isLocalSender(event) ? answer(argument) : Effect.fail(new UpdatesIpcRefused()),
          ),
        ),
      ),
      () => Effect.sync(() => Electron.ipcMain.removeHandler(channel)),
    );
  yield* handle(SET_UPDATE_CHANNEL_CHANNEL, (argument) =>
    decodeChannel(argument).pipe(Effect.flatMap(updates.setChannel)),
  );
  // The install waits for the computer and quits the app; the window gets its progress as status.
  yield* handle(INSTALL_UPDATE_CHANNEL, () =>
    Effect.sync(() => {
      Effect.runForkWith(services)(updates.install);
    }),
  );
});
