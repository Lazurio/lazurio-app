import type { ChannelState } from "@lazurio/app-contracts/device/v1";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  DeviceChannelState,
  DeviceStatus,
  DeviceSwitchPhase,
  DeviceSwitchProblem,
} from "../shared/bridge.ts";
import type { AuthClientShape, AuthState, HandOver, HandOverError } from "./AuthClient.ts";
import type { DeviceEnvironments } from "./DeviceEnvironments.ts";
import type { DeviceRequestError, DeviceService } from "./DeviceService.ts";
import { environmentOriginOf } from "./Navigation.ts";

// Agent Desktop's switches (docs/adr/0006, contract v3 in the app): off after every start, on only
// by a click in a native window. While on: sign in if needed, a hand-over for the Environment's
// origin, StartChannel; NeedsHandOver asks again, Refused or a final answer of Auth turns it off.
// The hand-over stays Redacted in memory, goes to the helper once and is wiped; nothing logs it.

// Lazurio Auth that does not answer, or answers 503, is asked again after this long, doubling up to
// the limit; a hand-over resets it.
const AUTH_RETRY_FIRST = Duration.seconds(1);
const AUTH_RETRY_MAX = Duration.seconds(60);
// A channel the helper could not start (it reports Off on its own) is started again after this.
const CHANNEL_RETRY = Duration.seconds(5);

export class DeviceSwitchError extends Schema.TaggedError<DeviceSwitchError>()(
  "DeviceSwitchError",
  {
    // not-listed: no Environment of that origin in the list; not-addable: the main window does not
    // show that Environment; not-saved: the list could not be written.
    problem: Schema.Literals(["not-listed", "not-addable", "not-saved"]),
  },
) {
  override get message(): string {
    return `Agent Desktop's switch: ${this.problem}`;
  }
}

// How the channel the last StartChannel opened ended, as the helper reports it.
type Outcome =
  | { readonly _tag: "NeedsHandOver"; readonly retryAfter: Duration.Duration }
  | { readonly _tag: "Refused"; readonly reason: string; readonly httpStatus: number }
  // No channel: the helper could not start one.
  | { readonly _tag: "Off" };

const outcomeOf = (state: ChannelState): Outcome | undefined => {
  switch (state.state.case) {
    case "needsHandOver":
      return {
        _tag: "NeedsHandOver",
        retryAfter: Duration.millis(Number(state.state.value.retryAfterMs)),
      };
    case "refused":
      return {
        _tag: "Refused",
        reason: state.state.value.reason,
        httpStatus: state.state.value.httpStatus,
      };
    case "off":
      return { _tag: "Off" };
    default:
      return undefined;
  }
};

// A final answer of Lazurio Auth to a hand-over turns the switch off; 503 is asked again.
const handOverProblem = (error: HandOverError): Option.Option<DeviceSwitchProblem> => {
  switch (error.reason) {
    case "unavailable":
      return Option.none();
    case "unknown-environment":
    case "not-permitted":
    case "environment-state-conflict":
      return Option.some({ from: "auth", reason: error.reason });
    default:
      return Option.some({ from: "auth", reason: "rejected" });
  }
};

interface Entry {
  phase: DeviceSwitchPhase;
  // The switch's work while it is on.
  fiber: Option.Option<Fiber.Fiber<void>>;
  // Whether the switch waits for how its channel ends; only then do outcomes count.
  accepting: boolean;
  readonly outcomes: Queue.Queue<Outcome>;
}

const OFF: DeviceSwitchPhase = { phase: "off", problem: null };
const NO_CHANNEL: DeviceChannelState = { state: "off" };

export interface DeviceSwitchesOptions {
  readonly device: Pick<
    DeviceService,
    "current" | "subscribe" | "onChannel" | "startChannel" | "stopChannel" | "stop"
  >;
  readonly auth: AuthClientShape;
  readonly environments: DeviceEnvironments;
}

export interface DeviceSwitches {
  readonly current: () => DeviceStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly stop: Effect.Effect<void, DeviceRequestError>;
  readonly setSwitch: (origin: string, on: boolean) => Effect.Effect<void, DeviceSwitchError>;
  readonly addEnvironment: (origin: string) => Effect.Effect<void, DeviceSwitchError>;
  readonly removeEnvironment: (origin: string) => Effect.Effect<void, DeviceSwitchError>;
  // Fails with not-saved when the sealed session could not be removed: the next start opens it.
  readonly signOut: Effect.Effect<void, DeviceSwitchError>;
  // The address the main window's page shows now.
  readonly pageShown: (address: string) => void;
}

const hostOf = (origin: string): string => URL.parse(origin)?.hostname ?? origin;

// Runs the switches for as long as the scope lives; closing it ends every switch's work.
export const run = Effect.fn("DeviceSwitches.run")(function* (options: DeviceSwitchesOptions) {
  const { device, auth, environments } = options;
  const scope = yield* Effect.scope;

  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const entries = new Map<string, Entry>();
  const entryOf = Effect.fn("DeviceSwitches.entryOf")(function* (origin: string) {
    const known = entries.get(origin);
    if (known !== undefined) return known;
    const entry: Entry = {
      phase: OFF,
      fiber: Option.none(),
      accepting: false,
      outcomes: yield* Queue.unbounded<Outcome>(),
    };
    entries.set(origin, entry);
    return entry;
  });
  for (const origin of environments.origins()) yield* entryOf(origin);

  let account: AuthState = yield* auth.state;
  yield* auth.changes.pipe(
    Stream.runForEach((next) =>
      Effect.sync(() => {
        account = next;
        changed();
      }),
    ),
    Effect.forkIn(scope),
  );

  let shownOrigin: string | undefined;

  const stopListening = device.onChannel((state) => {
    const entry = entries.get(state.environmentId);
    const outcome = outcomeOf(state);
    if (entry?.accepting === true && outcome !== undefined) {
      entry.accepting = false;
      Queue.offerUnsafe(entry.outcomes, outcome);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(stopListening));

  const setPhase = (entry: Entry, phase: DeviceSwitchPhase) =>
    Effect.sync(() => {
      entry.phase = phase;
      changed();
    });

  // One sign-in for every switch that waits for it. It runs apart from the switches, so turning one
  // off does not end the sign-in another waits for; it ends when no switch waits any more.
  const signInLock = yield* Semaphore.make(1);
  let signInFiber: Option.Option<Fiber.Fiber<void, Effect.Error<AuthClientShape["signIn"]>>> =
    Option.none();
  const signIn = signInLock
    .withPermits(1)(
      Effect.gen(function* () {
        if (Option.isSome(signInFiber)) return signInFiber.value;
        const fiber = yield* auth.signIn.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              signInFiber = Option.none();
            }),
          ),
          Effect.forkIn(scope),
        );
        signInFiber = Option.some(fiber);
        return fiber;
      }),
    )
    .pipe(Effect.flatMap(Fiber.join));
  const endUnwantedSignIn = Effect.suspend(() => {
    const waiting = [...entries.values()].some((entry) => entry.phase.phase === "signing-in");
    return waiting || Option.isNone(signInFiber) ? Effect.void : Fiber.interrupt(signInFiber.value);
  });

  // Gives the helper the hand-over once, then wipes the app's copy of its bytes.
  const startChannel = (origin: string, handOver: HandOver) =>
    Effect.suspend(() => {
      const bytes = new TextEncoder().encode(Redacted.value(handOver.handOver));
      Redacted.wipeUnsafe(handOver.handOver);
      const host = hostOf(origin);
      return device
        .startChannel({
          environmentId: origin,
          environmentLabel: host,
          attachUrl: `wss://${host}/.lazurio/computers/attach`,
          handOver: bytes,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              bytes.fill(0);
            }),
          ),
        );
    });

  // The switch went off by itself: the helper's channel is stopped as when the person turns it off,
  // and the reason stays with the switch until it is turned on again.
  const turnedOff = Effect.fn("DeviceSwitches.turnedOff")(function* (
    origin: string,
    entry: Entry,
    problem: DeviceSwitchProblem,
  ) {
    entry.accepting = false;
    yield* Effect.logWarning("Agent Desktop's switch went off", { origin, problem });
    yield* device.stopChannel(origin).pipe(Effect.ignore);
    entry.fiber = Option.none();
    yield* setPhase(entry, { phase: "off", problem });
  });

  // The work of a switch that is on, until it goes off by itself or the person turns it off.
  const work = Effect.fn("DeviceSwitches.work")(function* (origin: string, entry: Entry) {
    // A sign-in may still happen in the first round: the app may not be signed in yet, or the
    // session it kept may no longer be valid. Later a lost session turns the switch off.
    let maySignIn = true;
    let authRetry = AUTH_RETRY_FIRST;
    const waitForAuth = Effect.gen(function* () {
      yield* setPhase(entry, { phase: "retrying", cause: "auth-unavailable" });
      yield* Effect.sleep(authRetry);
      authRetry = Duration.min(Duration.times(authRetry, 2), AUTH_RETRY_MAX);
    });
    while (true) {
      if ((yield* auth.state) === "signedOut") {
        if (!maySignIn) {
          return yield* turnedOff(origin, entry, { from: "auth", reason: "signed-out" });
        }
        yield* setPhase(entry, { phase: "signing-in" });
        const signedIn = yield* Effect.result(signIn);
        if (Result.isFailure(signedIn)) {
          const error = signedIn.failure;
          yield* Effect.logWarning("Agent Desktop's sign-in did not finish", {
            origin,
            problem: error.message,
          });
          // The browser has not opened when the issuer's discovery fails, so it may be asked again.
          if (error._tag === "AuthUnreachableError" && error.operation === "discovery") {
            yield* waitForAuth;
            continue;
          }
          return yield* turnedOff(origin, entry, { from: "auth", reason: "sign-in-failed" });
        }
        maySignIn = false;
      }
      yield* setPhase(entry, { phase: "connecting" });
      const handOver = yield* Effect.result(auth.handOver(origin));
      if (Result.isFailure(handOver)) {
        const error = handOver.failure;
        yield* Effect.logWarning("Agent Desktop got no hand-over", {
          origin,
          problem: error.message,
        });
        if (error._tag === "SignedOutError") {
          if (maySignIn && (yield* auth.state) === "signedOut") {
            maySignIn = false;
            // The session the app kept was no longer valid: sign in once, then ask again.
            yield* setPhase(entry, { phase: "signing-in" });
            const signedIn = yield* Effect.result(signIn);
            if (Result.isSuccess(signedIn)) continue;
            return yield* turnedOff(origin, entry, { from: "auth", reason: "sign-in-failed" });
          }
          return yield* turnedOff(origin, entry, { from: "auth", reason: "signed-out" });
        }
        if (error._tag === "AuthUnreachableError") {
          yield* waitForAuth;
          continue;
        }
        const problem = handOverProblem(error);
        if (Option.isNone(problem)) {
          yield* waitForAuth;
          continue;
        }
        return yield* turnedOff(origin, entry, problem.value);
      }
      maySignIn = false;
      authRetry = AUTH_RETRY_FIRST;

      // Outcomes count from before the start, so none that comes quickly is missed.
      yield* Queue.clear(entry.outcomes);
      entry.accepting = true;
      const started = yield* Effect.result(startChannel(origin, handOver.success));
      if (Result.isFailure(started)) {
        yield* Effect.logWarning("the Device helper did not take the channel", {
          origin,
          problem: started.failure.message,
        });
        return yield* turnedOff(origin, entry, { from: "app", reason: "helper-unavailable" });
      }
      yield* setPhase(entry, { phase: "channel" });
      const outcome = yield* Queue.take(entry.outcomes);
      switch (outcome._tag) {
        case "Refused":
          return yield* turnedOff(origin, entry, {
            from: "helper",
            reason: outcome.reason,
            httpStatus: outcome.httpStatus,
          });
        case "NeedsHandOver":
          yield* setPhase(entry, { phase: "retrying", cause: "needs-hand-over" });
          yield* Effect.sleep(outcome.retryAfter);
          break;
        case "Off":
          yield* setPhase(entry, { phase: "retrying", cause: "needs-hand-over" });
          yield* Effect.sleep(CHANNEL_RETRY);
          break;
      }
    }
  });

  // What the person does, one at a time.
  const personLock = yield* Semaphore.make(1);
  const byPerson = <A, E>(effect: Effect.Effect<A, E>) => personLock.withPermits(1)(effect);

  const turnOn = Effect.fn("DeviceSwitches.turnOn")(function* (origin: string) {
    const entry = entries.get(origin);
    if (entry === undefined || !environments.origins().includes(origin)) {
      return yield* new DeviceSwitchError({ problem: "not-listed" });
    }
    if (Option.isSome(entry.fiber)) return;
    yield* Effect.logInfo("Agent Desktop's switch on", { origin });
    yield* setPhase(entry, { phase: "connecting" });
    entry.fiber = Option.some(yield* work(origin, entry).pipe(Effect.forkIn(scope)));
  });

  const turnOff = Effect.fn("DeviceSwitches.turnOff")(function* (origin: string) {
    const entry = entries.get(origin);
    if (entry === undefined) return;
    const fiber = entry.fiber;
    entry.fiber = Option.none();
    entry.accepting = false;
    if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
    const wasOn = entry.phase.phase !== "off";
    yield* setPhase(entry, OFF);
    yield* endUnwantedSignIn;
    if (!wasOn) return;
    yield* Effect.logInfo("Agent Desktop's switch off", { origin });
    yield* device.stopChannel(origin).pipe(
      Effect.tapError((error) => Effect.logWarning(error.message)),
      Effect.ignore,
    );
  });

  const addable = (): string | null =>
    shownOrigin === undefined || environments.origins().includes(shownOrigin) ? null : shownOrigin;

  const switches: DeviceSwitches = {
    current: () => {
      const helper = device.current();
      const channelOf = (origin: string) =>
        helper.environments.find((environment) => environment.environmentId === origin)?.channel ??
        NO_CHANNEL;
      return {
        ...helper,
        account: account === "signedIn" ? "signed-in" : "signed-out",
        switches: environments.origins().map((origin) => ({
          origin,
          host: hostOf(origin),
          switch: entries.get(origin)?.phase ?? OFF,
          channel: channelOf(origin),
        })),
        addable: addable(),
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const stopDevice = device.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stopDevice();
      };
    },
    stop: device.stop,
    setSwitch: (origin, on) => byPerson(on ? turnOn(origin) : turnOff(origin)),
    addEnvironment: (origin) =>
      byPerson(
        Effect.gen(function* () {
          if (origin !== addable()) return yield* new DeviceSwitchError({ problem: "not-addable" });
          yield* environments
            .add(origin)
            .pipe(Effect.mapError(() => new DeviceSwitchError({ problem: "not-saved" })));
          yield* entryOf(origin);
          yield* Effect.logInfo("Agent Desktop's Environment added", { origin });
          changed();
        }),
      ),
    removeEnvironment: (origin) =>
      byPerson(
        Effect.gen(function* () {
          if (!environments.origins().includes(origin)) {
            return yield* new DeviceSwitchError({ problem: "not-listed" });
          }
          yield* turnOff(origin);
          yield* environments
            .remove(origin)
            .pipe(Effect.mapError(() => new DeviceSwitchError({ problem: "not-saved" })));
          entries.delete(origin);
          yield* Effect.logInfo("Agent Desktop's Environment removed", { origin });
          changed();
        }),
      ),
    signOut: byPerson(
      Effect.gen(function* () {
        for (const origin of entries.keys()) yield* turnOff(origin);
        if (Option.isSome(signInFiber)) yield* Fiber.interrupt(signInFiber.value);
        yield* auth.signOut.pipe(
          Effect.mapError(() => new DeviceSwitchError({ problem: "not-saved" })),
        );
      }),
    ).pipe(Effect.withSpan("DeviceSwitches.signOut")),
    pageShown: (address) => {
      const next = environmentOriginOf(address);
      if (next === shownOrigin) return;
      shownOrigin = next;
      changed();
    },
  };
  return switches;
});
