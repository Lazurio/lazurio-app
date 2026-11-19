import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { COPY_STATUS_CHANNEL, RETRY_PAGE_CHANNEL, STATUS_PANEL_CHANNEL } from "../shared/bridge.ts";
import { destinationOf } from "./Navigation.ts";

// The local windows' requests about the window itself: show or hide the app's status column, and
// copy the app's status as text. Only a frame of the app's own files may ask (UpdatesIpc.ts).

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

const decodeShown = Schema.decodeUnknownEffect(Schema.Boolean);

class WindowIpcRefused extends Schema.TaggedError<WindowIpcRefused>()("WindowIpcRefused", {}) {
  override get message(): string {
    return "refused: not a local window of the app";
  }
}

export interface WindowControls {
  readonly setStatusShown: (shown: boolean) => void;
  // The app's status as text without secrets (statusText.ts).
  readonly statusText: Effect.Effect<string>;
  // Loads the Environment's page again, until the attempt has shown or failed.
  readonly retryPage: Effect.Effect<void>;
}

export const serve = Effect.fn("WindowIpc.serve")(function* (controls: WindowControls) {
  const services = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect);
  const handle = <E>(channel: string, answer: (argument: unknown) => Effect.Effect<void, E>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Electron.ipcMain.handle(channel, (event, argument: unknown) =>
          run<void, E | WindowIpcRefused>(
            isLocalSender(event) ? answer(argument) : Effect.fail(new WindowIpcRefused()),
          ),
        ),
      ),
      () => Effect.sync(() => Electron.ipcMain.removeHandler(channel)),
    );
  yield* handle(STATUS_PANEL_CHANNEL, (argument) =>
    decodeShown(argument).pipe(Effect.map(controls.setStatusShown)),
  );
  yield* handle(COPY_STATUS_CHANNEL, () =>
    controls.statusText.pipe(
      Effect.flatMap((text) => Effect.promise(async () => Electron.clipboard.writeText(text))),
    ),
  );
  yield* handle(RETRY_PAGE_CHANNEL, () => controls.retryPage);
});
