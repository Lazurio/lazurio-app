import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import {
  COPY_STATUS_CHANNEL,
  COPY_TAILNET_SIGN_IN_CHANNEL,
  OPEN_TAILNET_SIGN_IN_CHANNEL,
  FIRST_PAGE_CHANNEL,
  NETWORK_HELP_CHANNEL,
  RETRY_PAGE_CHANNEL,
  STATUS_PANEL_CHANNEL,
} from "../shared/bridge.ts";
import { destinationOf } from "./Navigation.ts";

// The local windows' requests about the window itself: show or hide the app's status column, copy
// the app's status as text, and copy a tailnet's sign-in address. Only a frame of the app's own
// files may ask (UpdatesIpc.ts).

const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

const decodeShown = Schema.decodeUnknownEffect(Schema.Boolean);
const decodeTailnet = Schema.decodeUnknownEffect(Schema.String);

class WindowIpcRefused extends Schema.TaggedError<WindowIpcRefused>()("WindowIpcRefused", {}) {
  override get message(): string {
    return "refused: not a local window of the app";
  }
}

// The tailnet waits for no sign-in, or its address was not one the app keeps (Tailnet.ts).
class NoSignInAddress extends Schema.TaggedError<NoSignInAddress>()("NoSignInAddress", {}) {
  override get message(): string {
    return "no sign-in address to copy";
  }
}

export interface WindowControls {
  readonly setStatusShown: (shown: boolean) => void;
  // The app's status as text without secrets (statusText.ts).
  readonly statusText: Effect.Effect<string>;
  // The sign-in address of a tailnet that waits for sign-in (Tailnets.signInAddress).
  readonly signInAddress: (tailnet: string) => Option.Option<string>;
  // Opens again, in the system's browser, the sign-in of every tailnet that waits for one.
  readonly openSignIns: Effect.Effect<void>;
  // Loads the Environment's page again, until the attempt has shown or failed.
  readonly retryPage: Effect.Effect<void>;
  // Loads the window's first page instead, until the attempt has shown or failed.
  readonly firstPage: Effect.Effect<void>;
  // Says in a dialog of the system what a person without the Organization's network does.
  readonly networkHelp: Effect.Effect<void>;
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
  yield* handle(COPY_TAILNET_SIGN_IN_CHANNEL, (argument) =>
    decodeTailnet(argument).pipe(
      Effect.flatMap((tailnet) =>
        Option.match(controls.signInAddress(tailnet), {
          onNone: () => Effect.fail(new NoSignInAddress()),
          onSome: (address) => Effect.promise(async () => Electron.clipboard.writeText(address)),
        }),
      ),
    ),
  );
  yield* handle(OPEN_TAILNET_SIGN_IN_CHANNEL, () => controls.openSignIns);
  yield* handle(RETRY_PAGE_CHANNEL, () => controls.retryPage);
  yield* handle(FIRST_PAGE_CHANNEL, () => controls.firstPage);
  yield* handle(NETWORK_HELP_CHANNEL, () => controls.networkHelp);
});
