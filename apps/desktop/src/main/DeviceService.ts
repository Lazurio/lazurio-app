import { create } from "@bufbuild/protobuf";
import {
  ConfigureDeviceSchema,
  StartChannelSchema,
  type ChannelState,
  type LockState,
} from "@lazurio/app-contracts/device/v1";
import type { HelperMessage } from "@lazurio/app-contracts/helper/v1";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  DeviceChannelState,
  DeviceEnvironmentStatus,
  DeviceStatus,
} from "../shared/bridge.ts";
import type { DeviceActivityShape } from "./DeviceActivity.ts";
import type { HelperConnection } from "./Helpers.ts";
import type { Tailnets } from "./Tailnet.ts";

// The main process's side of the Device helper (docs/adr/0006, points 2, 5 and 7): it configures
// the helper once, follows each Environment's channel and who holds the computer, sends Stop, and
// gives the updater the computer's activity. It alone reads the helper's events, outside the
// helpers' scope, so the helper's last message after Shutdown still arrives.

export const DEVICE_HELPER = "lazurio-device";

// A helper that still runs gets this long to take the hold's release.
const RELEASE_WITHIN = "1 second";
// The helpers' scope has closed when the updater asks, so the helper's stop is known by then; a
// helper that still runs confirms nothing.
const CONFIRM_WITHIN = "2 seconds";

export class DeviceRequestError extends Schema.TaggedError<DeviceRequestError>()(
  "DeviceRequestError",
  {
    request: Schema.String,
    problem: Schema.String,
  },
) {
  override get message(): string {
    return `device helper, ${this.request}: ${this.problem}`;
  }
}

// What the Device helper reports, without the app's switches (DeviceSwitches adds them).
export type DeviceHelperStatus = Pick<DeviceStatus, "state" | "environments" | "agent">;

// What the helper said last about who holds the computer. Only a LockState with a greater
// sequence replaces it (docs/adr/0006, point 7).
interface LockSnapshot {
  readonly sequence: bigint;
  readonly idle: boolean;
  readonly updateHold: boolean;
  readonly holderId: string;
  readonly holderLabel: string;
}

const channelStateOf = (state: ChannelState): DeviceChannelState => {
  switch (state.state.case) {
    case "connecting":
      return { state: "connecting", failedAttempts: state.state.value.failedAttempts };
    case "connected":
      return { state: "connected" };
    case "refused":
      return { state: "refused", reason: state.state.value.reason };
    case "needsHandOver":
      return { state: "needs-hand-over", reason: state.state.value.reason };
    case "working":
      return {
        state: "working",
        tool: state.state.value.tool,
        application: state.state.value.application,
      };
    case "off":
    case undefined:
      return { state: "off" };
  }
};

// What a channel's start carries (contract v3).
export interface ChannelStart {
  readonly environmentId: string;
  readonly environmentLabel: string;
  // `wss://<the Environment's Lazurio host>/.lazurio/computers/attach`.
  readonly attachUrl: string;
  // Lazurio Auth's one-time hand-over for this Environment, valid for 60 s. The helper sends it once
  // and drops it; every start needs a new one.
  readonly handOver: Uint8Array;
}

export interface DeviceServiceOptions {
  readonly connection: HelperConnection;
  // `<userData>/device`: the helper keeps its history there.
  readonly dataDirectory: string;
  readonly computerName: string;
  readonly tailnets: Pick<Tailnets, "proxyFor">;
}

export interface DeviceService {
  // The state for the local windows' bridge, outside any Effect.
  readonly current: () => DeviceHelperStatus;
  // Calls the listener after every change of the state; the result stops it.
  readonly subscribe: (listener: () => void) => () => void;
  // Calls the listener with every ChannelState the helper sends, answers included, in the order the
  // app reads them, before the state's listeners; the result stops it. The switches learn from it
  // when a channel needs a new hand-over or was refused, and after how long to ask again.
  readonly onChannel: (listener: (state: ChannelState) => void) => () => void;
  // Stop: ends the work of the agent that holds the computer now, whatever its Environment.
  readonly stop: Effect.Effect<void, DeviceRequestError>;
  // Succeeds only when the helper answers that the Environment's channel is Off.
  readonly stopChannel: (environmentId: string) => Effect.Effect<void, DeviceRequestError>;
  // The fail-safe when a channel's stop was not confirmed: ends the helper's process, which ends
  // every channel. True only when it exited and said DeviceStopped with every engine ended; until
  // the app starts again the helper counts as lost. Runs once; later calls get the first answer.
  readonly endHelper: Effect.Effect<boolean>;
  // Opens a channel with a hand-over of Lazurio Auth (contract v3). Only DeviceSwitches calls it,
  // while the person's switch in a native window is on, with a new hand-over for each start and
  // after each NeedsHandOver (docs/adr/0006).
  readonly startChannel: (start: ChannelStart) => Effect.Effect<void, DeviceRequestError>;
  // The computer's activity for the updater, once the helper took its configuration; none
  // otherwise, and the default (no channel, so always idle) stays.
  readonly activity: Option.Option<DeviceActivityShape>;
}

// Follows the Device helper for as long as the scope lives. The scope must outlive the helpers'
// own scope, which the updater closes before it installs.
export const run = Effect.fn("DeviceService.run")(function* (options: DeviceServiceOptions) {
  const { connection } = options;
  let state: DeviceHelperStatus["state"] = "starting";
  let lock: Option.Option<LockSnapshot> = Option.none();
  const channels = new Map<string, DeviceChannelState>();
  const labels = new Map<string, string>();
  // DeviceStopped, the helper's last message, and whether its events ended after it.
  let allEnginesEnded: Option.Option<boolean> = Option.none();
  const drained = yield* Deferred.make<void>();
  // The helper's output ended while the app was not stopping it: the helper died, or its output
  // failed while it may run on. The app cannot reach it any more.
  let lost = false;

  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const channelListeners = new Set<(state: ChannelState) => void>();
  // A helper that died without DeviceStopped leaves no proof that its engine's process tree ended,
  // so the computer counts as busy and no update holds it until the app starts its helpers again
  // (docs/adr/0006, points 7 and 8).
  const idleNow = () =>
    !lost && Option.match(lock, { onNone: () => true, onSome: (held) => held.idle });
  const idleChanges = yield* PubSub.unbounded<boolean>();

  const applyLock = (next: LockState) =>
    Effect.suspend(() => {
      if (Option.isSome(lock) && next.sequence <= lock.value.sequence) return Effect.void;
      const wasIdle = idleNow();
      lock = Option.some({
        sequence: next.sequence,
        idle: next.idle,
        updateHold: next.updateHold,
        holderId: next.holderEnvironmentId,
        holderLabel: next.holderEnvironmentLabel,
      });
      if (next.holderEnvironmentId !== "" && next.holderEnvironmentLabel !== "") {
        labels.set(next.holderEnvironmentId, next.holderEnvironmentLabel);
      }
      changed();
      return next.idle === wasIdle ? Effect.void : PubSub.publish(idleChanges, next.idle);
    });
  const applyChannel = (next: ChannelState) =>
    Effect.sync(() => {
      channels.set(next.environmentId, channelStateOf(next));
      for (const listener of channelListeners) listener(next);
      changed();
    });
  const apply = (message: HelperMessage) => {
    switch (message.kind.case) {
      case "lockState":
        return applyLock(message.kind.value);
      case "channelState":
        return applyChannel(message.kind.value);
      case "deviceStopped": {
        const ended = message.kind.value.allEnginesEnded;
        return Effect.sync(() => {
          allEnginesEnded = Option.some(ended);
        });
      }
      default:
        return Effect.void;
    }
  };
  // Runs only when the events end, not when the scope interrupts their reader. The helper may run
  // on with a failed output, so the app ends it by its PID. On Windows the engine's job object kills
  // on close and Windows ends the tree unobserved; on macOS and Linux the engine's process group can
  // outlive a helper that died or got SIGKILL. So without DeviceStopped the agent's state is unknown.
  const afterEnd = Effect.gen(function* () {
    if (yield* connection.stopping) return;
    const wasIdle = idleNow();
    lost = true;
    state = "lost";
    changed();
    if (wasIdle) yield* PubSub.publish(idleChanges, false);
    yield* Effect.logWarning("the connection to the Device helper was lost; ending it by its PID", {
      pid: connection.pid,
      deviceStopped: Option.getOrElse(allEnginesEnded, () => "missing"),
    });
    yield* connection.end;
  });
  yield* connection.events.pipe(
    Stream.runForEach(apply),
    Effect.andThen(afterEnd),
    Effect.ensuring(Deferred.succeed(drained, undefined)),
    Effect.forkScoped,
  );

  const ask = (request: string, kind: Parameters<HelperConnection["request"]>[0]) =>
    Effect.suspend(() =>
      lost
        ? Effect.fail(
            new DeviceRequestError({ request, problem: "the helper cannot be reached any more" }),
          )
        : connection
            .request(kind)
            .pipe(
              Effect.mapError(
                (error) => new DeviceRequestError({ request, problem: error.message }),
              ),
            ),
    ).pipe(
      Effect.filterOrFail(
        (reply) => reply.kind.case !== "failure",
        (reply) =>
          new DeviceRequestError({
            request,
            problem: reply.kind.case === "failure" ? reply.kind.value.message : "failed",
          }),
      ),
    );

  const configured = yield* ask("ConfigureDevice", {
    case: "configureDevice",
    value: create(ConfigureDeviceSchema, {
      dataDirectory: options.dataDirectory,
      computerName: options.computerName,
    }),
  }).pipe(
    Effect.map((reply) => reply.kind.case === "deviceReady"),
    Effect.tapError((error) => Effect.logWarning(error.message)),
    Effect.orElseSucceed(() => false),
  );
  state = configured ? "ready" : "failed";
  changed();

  const stop = ask("StopAgent", { case: "stopAgent", value: {} }).pipe(
    Effect.flatMap((reply) =>
      reply.kind.case === "lockState" ? applyLock(reply.kind.value) : Effect.void,
    ),
    Effect.withSpan("DeviceService.stop"),
  );
  const stopChannel = (environmentId: string) =>
    ask("StopChannel", { case: "stopChannel", value: { environmentId } }).pipe(
      Effect.filterOrFail(
        (reply) =>
          reply.kind.case === "channelState" &&
          reply.kind.value.environmentId === environmentId &&
          reply.kind.value.state.case === "off",
        () => new DeviceRequestError({ request: "StopChannel", problem: "no Off in the answer" }),
      ),
      Effect.flatMap((reply) =>
        reply.kind.case === "channelState" ? applyChannel(reply.kind.value) : Effect.void,
      ),
      Effect.withSpan("DeviceService.stopChannel"),
    );
  const startChannel = (start: ChannelStart) =>
    Effect.suspend(() => {
      const host = URL.parse(start.attachUrl)?.hostname ?? "";
      const proxy = options.tailnets.proxyFor(host);
      labels.set(start.environmentId, start.environmentLabel);
      return ask("StartChannel", {
        case: "startChannel",
        value: create(StartChannelSchema, {
          environmentId: start.environmentId,
          environmentLabel: start.environmentLabel,
          attachUrl: start.attachUrl,
          handOver: start.handOver,
          proxy: Option.match(proxy, {
            onNone: () => undefined,
            onSome: (endpoint) => ({
              host: endpoint.host,
              port: endpoint.port,
              username: endpoint.username,
              password: endpoint.password,
            }),
          }),
        }),
      });
    }).pipe(
      Effect.flatMap((reply) =>
        reply.kind.case === "channelState" ? applyChannel(reply.kind.value) : Effect.void,
      ),
      Effect.withSpan("DeviceService.startChannel"),
    );

  // The updater's hold: granted only by the helper's last word on the lock. Its release goes to a
  // helper that still runs; a stopped helper holds nothing.
  const holdGranted = () =>
    Option.match(lock, { onNone: () => false, onSome: (held) => held.updateHold });
  const askHold = (hold: boolean) =>
    ask("HoldForUpdate", { case: "holdForUpdate", value: { hold } }).pipe(
      Effect.flatMap((reply) =>
        reply.kind.case === "lockState" ? applyLock(reply.kind.value) : Effect.void,
      ),
    );
  const release = Deferred.isDone(drained).pipe(
    Effect.flatMap((ended) =>
      ended ? Effect.void : askHold(false).pipe(Effect.timeout(RELEASE_WITHIN)),
    ),
    Effect.ignore,
  );
  const holdForUpdate = Effect.acquireRelease(
    askHold(true).pipe(
      Effect.map(holdGranted),
      Effect.tapError((error) => Effect.logWarning(error.message)),
      Effect.orElseSucceed(() => false),
    ),
    (granted) => (granted ? release : Effect.void),
  );
  // After the helpers' scope closed: the hold was still granted by the highest-sequence LockState,
  // the helper said DeviceStopped with every engine ended, and it exited in time with its output
  // read to the end. A helper still running confirms nothing.
  const confirmStopped = Effect.gen(function* () {
    if (lost || !(yield* connection.stopped)) return false;
    yield* Deferred.await(drained);
    return holdGranted() && Option.getOrElse(allEnginesEnded, () => false);
  }).pipe(
    Effect.timeoutOrElse({ duration: CONFIRM_WITHIN, orElse: () => Effect.succeed(false) }),
    Effect.withSpan("DeviceService.confirmStopped"),
  );

  const activity: DeviceActivityShape = {
    isIdle: Effect.sync(idleNow),
    idleChanges: Stream.fromPubSub(idleChanges),
    holdForUpdate,
    confirmStopped,
    reachable: Effect.sync(() => !lost),
  };

  const environments = (): ReadonlyArray<DeviceEnvironmentStatus> =>
    [...channels].map(([environmentId, channel]) => ({
      environmentId,
      label: labels.get(environmentId) ?? environmentId,
      channel,
    }));
  // An agent works while it holds the computer, or while its channel says it runs a tool.
  const agent = (): DeviceStatus["agent"] => {
    if (Option.isSome(lock) && !lock.value.idle && lock.value.holderId !== "") {
      const { holderId } = lock.value;
      return { environmentId: holderId, label: labels.get(holderId) ?? holderId };
    }
    const working = [...channels].find(([, channel]) => channel.state === "working");
    return working === undefined
      ? null
      : { environmentId: working[0], label: labels.get(working[0]) ?? working[0] };
  };

  // After a lost connection only a DeviceStopped with every engine ended says no agent works.
  const lostStatus = (): DeviceHelperStatus => {
    const confirmed = Option.getOrElse(allEnginesEnded, () => false);
    return {
      state: "lost",
      environments: [...channels.keys()].map((environmentId) => ({
        environmentId,
        label: labels.get(environmentId) ?? environmentId,
        channel: confirmed ? { state: "off" } : { state: "unknown" },
      })),
      agent: confirmed ? null : "unknown",
    };
  };

  const helperEnded = yield* Deferred.make<boolean>();
  let ending = false;
  const endOnce = Effect.gen(function* () {
    const wasIdle = idleNow();
    lost = true;
    state = "lost";
    changed();
    if (wasIdle) yield* PubSub.publish(idleChanges, false);
    yield* Effect.logWarning("a channel's stop was not confirmed; ending the Device helper", {
      pid: connection.pid,
    });
    const exited = yield* connection.shutdown;
    // Its last message, DeviceStopped, is read once its output ended.
    const drainedInTime = exited
      ? yield* Deferred.await(drained).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({ duration: CONFIRM_WITHIN, orElse: () => Effect.succeed(false) }),
        )
      : false;
    const confirmed = drainedInTime && Option.getOrElse(allEnginesEnded, () => false);
    yield* Effect.logWarning("the Device helper ended", { exited, allEnginesEnded: confirmed });
    yield* Deferred.succeed(helperEnded, confirmed);
    changed();
    return confirmed;
  }).pipe(Effect.uninterruptible, Effect.withSpan("DeviceService.endHelper"));
  const endHelper = Effect.suspend(() => {
    if (ending) return Deferred.await(helperEnded);
    ending = true;
    return endOnce;
  });

  const service: DeviceService = {
    current: () => (lost ? lostStatus() : { state, environments: environments(), agent: agent() }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onChannel: (listener) => {
      channelListeners.add(listener);
      return () => channelListeners.delete(listener);
    },
    stop,
    stopChannel,
    endHelper,
    startChannel,
    activity: configured ? Option.some(activity) : Option.none(),
  };
  return service;
});

// The state of a build that runs no Device helper, or whose helper did not start.
export const withoutHelper = (state: "absent" | "failed"): DeviceStatus => ({
  state,
  environments: [],
  agent: null,
  account: "signed-out",
  switches: [],
  addable: null,
});
