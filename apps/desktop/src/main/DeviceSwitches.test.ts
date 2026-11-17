import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { DeviceStatus, DeviceSwitchStatus } from "../shared/bridge.ts";
import {
  AuthUnreachableError,
  HandOverError,
  SignedOutError,
  SignOutError,
  type AuthClientShape,
  type AuthState,
  type HandOver,
  SignInError,
} from "./AuthClient.ts";
import * as DeviceEnvironments from "./DeviceEnvironments.ts";
import * as DeviceService from "./DeviceService.ts";
import { run, type DeviceSwitches } from "./DeviceSwitches.ts";
import { fakeHelper, type FakeHelper, type Reply } from "./fake-device-connection.ts";

const ORIGIN = "https://launchpad.bob.example-org.lazurio.io";
const OTHER = "https://launchpad.carol.example-org.lazurio.io";
const HOST = "launchpad.bob.example-org.lazurio.io";

// A hand-over as Lazurio Auth gives it: 43 characters of base64url, unique per call.
const handOverNumber = (index: number) =>
  `HANDOVER${String(index).padStart(4, "0")}`.padEnd(43, "x");

type HandOverAnswer = "ok" | HandOverError | AuthUnreachableError | SignedOutError;
type SignInAnswer = "ok" | SignInError | AuthUnreachableError;

// The app's AuthClient as the switches use it: the test answers each sign-in and each hand-over.
const fakeAuth = (initial: AuthState) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<AuthState>(initial);
    const signIns = yield* Queue.unbounded<SignInAnswer>();
    const handOverAnswers: Array<HandOverAnswer> = [];
    const handOverOrigins: Array<string> = [];
    const calls = { signIn: 0, signOut: 0 };
    const signOutAnswers: Array<"ok" | "not-removed"> = [];
    let issued = 0;
    const shape: AuthClientShape = {
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      signIn: Effect.gen(function* () {
        calls.signIn += 1;
        const answer = yield* Queue.take(signIns);
        if (answer !== "ok") return yield* answer;
        yield* SubscriptionRef.set(state, "signedIn");
      }),
      signOut: Effect.gen(function* () {
        calls.signOut += 1;
        yield* SubscriptionRef.set(state, "signedOut");
        if (signOutAnswers.shift() === "not-removed") {
          return yield* new SignOutError({ reason: "session-not-removed" });
        }
      }),
      handOver: (origin) =>
        Effect.gen(function* () {
          handOverOrigins.push(origin);
          if ((yield* SubscriptionRef.get(state)) === "signedOut") {
            return yield* new SignedOutError();
          }
          const answer = handOverAnswers.shift() ?? "ok";
          if (answer !== "ok") {
            // A refused refresh ends the session, as AuthClient does.
            if (answer._tag === "SignedOutError") yield* SubscriptionRef.set(state, "signedOut");
            return yield* answer;
          }
          issued += 1;
          return {
            handOver: Redacted.make(handOverNumber(issued), { label: "handOver" }),
            expiresIn: Duration.seconds(60),
          } satisfies HandOver;
        }),
    };
    return { shape, state, signIns, handOverAnswers, handOverOrigins, signOutAnswers, calls };
  });

const memoryEnvironments = (origins: ReadonlyArray<string>) => {
  let list = [...origins];
  const environments: DeviceEnvironments.DeviceEnvironments = {
    origins: () => list,
    add: (origin) =>
      Effect.sync(() => {
        if (!list.includes(origin)) list = [...list, origin];
      }),
    remove: (origin) =>
      Effect.sync(() => {
        list = list.filter((known) => known !== origin);
      }),
  };
  return environments;
};

// The Device helper answers StartChannel with Connecting and StopChannel with Off, as the real one.
const answerChannels = (helper: FakeHelper) =>
  helper.answers.push((kind): Reply | undefined => {
    if (kind.case === "startChannel") {
      return {
        case: "channelState",
        value: {
          environmentId: kind.value.environmentId,
          state: { case: "connecting", value: { failedAttempts: 0 } },
        },
      };
    }
    if (kind.case === "stopChannel") {
      return {
        case: "channelState",
        value: { environmentId: kind.value.environmentId, state: { case: "off", value: {} } },
      };
    }
    return undefined;
  });

const setUp = (options: {
  readonly account: AuthState;
  readonly origins?: ReadonlyArray<string>;
  readonly environments?: DeviceEnvironments.DeviceEnvironments;
}) =>
  Effect.gen(function* () {
    const helper = yield* fakeHelper;
    answerChannels(helper);
    const device = yield* DeviceService.run({
      connection: helper.connection,
      dataDirectory: "/data/device",
      computerName: "Work laptop",
      tailnets: {
        proxyFor: (host) =>
          host === HOST
            ? Option.some({
                $typeName: "lazurio.app.tailnet.v1.ProxyEndpoint" as const,
                host: "127.0.0.1",
                port: 41000,
                username: "u",
                password: "p",
              })
            : Option.none(),
      },
    });
    const auth = yield* fakeAuth(options.account);
    const switches = yield* run({
      device,
      auth: auth.shape,
      environments: options.environments ?? memoryEnvironments(options.origins ?? [ORIGIN]),
    });
    return { helper, auth, switches };
  });

// Waits until the switches' state passes the check, from the change that made it so.
const stateWhere = (switches: DeviceSwitches, check: (status: DeviceStatus) => boolean) =>
  Effect.callback<DeviceStatus>((resume) => {
    if (check(switches.current())) {
      resume(Effect.succeed(switches.current()));
      return;
    }
    const stop = switches.subscribe(() => {
      if (!check(switches.current())) return;
      stop();
      resume(Effect.succeed(switches.current()));
    });
    return Effect.sync(stop);
  });

const switchOf = (status: DeviceStatus, origin = ORIGIN): DeviceSwitchStatus | undefined =>
  status.switches.find((entry) => entry.origin === origin);
const phaseIs =
  (phase: string, origin = ORIGIN) =>
  (status: DeviceStatus) =>
    switchOf(status, origin)?.switch.phase === phase;

const startsOf = (helper: FakeHelper) =>
  helper.requests.flatMap((kind) => (kind.case === "startChannel" ? [kind.value] : []));
const stopsOf = (helper: FakeHelper) =>
  helper.requests.flatMap((kind) =>
    kind.case === "stopChannel" ? [kind.value.environmentId] : [],
  );

const needsHandOver = (retryAfterMs: number, reason = "expired"): Reply => ({
  case: "channelState",
  value: {
    environmentId: ORIGIN,
    state: {
      case: "needsHandOver",
      value: { reason, failedAttempts: 0, retryAfterMs: BigInt(retryAfterMs), httpStatus: 0 },
    },
  },
});
const refused = (reason: string, httpStatus = 0): Reply => ({
  case: "channelState",
  value: { environmentId: ORIGIN, state: { case: "refused", value: { reason, httpStatus } } },
});

describe("DeviceSwitches", () => {
  it.effect("signs in when the switch goes on without a session, then starts the channel", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedOut" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("signing-in"));
      assert.lengthOf(startsOf(helper), 0);
      yield* Queue.offer(auth.signIns, "ok");
      const status = yield* stateWhere(switches, phaseIs("channel"));
      assert.strictEqual(auth.calls.signIn, 1);
      assert.strictEqual(status.account, "signed-in");
      assert.deepStrictEqual(auth.handOverOrigins, [ORIGIN]);
      const [start] = startsOf(helper);
      assert.strictEqual(start?.environmentId, ORIGIN);
      assert.strictEqual(start?.environmentLabel, HOST);
      assert.strictEqual(start?.attachUrl, `wss://${HOST}/.lazurio/computers/attach`);
      // The Environment lies in the app's tailnet: the channel goes through its proxy.
      assert.strictEqual(start?.proxy?.host, "127.0.0.1");
      assert.strictEqual(start?.proxy?.port, 41000);
      assert.deepStrictEqual(helper.handOvers, [handOverNumber(1)]);
      yield* helper.send({
        case: "channelState",
        value: { environmentId: ORIGIN, state: { case: "connected", value: {} } },
      });
      const connected = yield* stateWhere(
        switches,
        (current) => switchOf(current)?.channel.state === "connected",
      );
      assert.deepStrictEqual(switchOf(connected), {
        origin: ORIGIN,
        host: HOST,
        switch: { phase: "channel" },
        channel: { state: "connected" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("connects directly to an Environment outside the app's tailnets", () =>
    Effect.gen(function* () {
      const { helper, switches } = yield* setUp({ account: "signedIn", origins: [OTHER] });
      yield* switches.setSwitch(OTHER, true);
      yield* stateWhere(switches, phaseIs("channel", OTHER));
      assert.isUndefined(startsOf(helper)[0]?.proxy);
    }).pipe(Effect.scoped),
  );

  it.effect("asks for a new hand-over after the helper's retry_after_ms", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      yield* helper.send(needsHandOver(5000));
      yield* stateWhere(switches, phaseIs("retrying"));
      assert.deepStrictEqual(switchOf(switches.current())?.switch, {
        phase: "retrying",
        cause: "needs-hand-over",
      });
      yield* TestClock.adjust(Duration.millis(4999));
      assert.lengthOf(startsOf(helper), 1);
      yield* TestClock.adjust(Duration.millis(1));
      yield* stateWhere(
        switches,
        (status) => phaseIs("channel")(status) && startsOf(helper).length === 2,
      );
      assert.deepStrictEqual(helper.handOvers, [handOverNumber(1), handOverNumber(2)]);
      assert.deepStrictEqual(auth.handOverOrigins, [ORIGIN, ORIGIN]);
      assert.strictEqual(auth.calls.signIn, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("turns the switch off with the reason when the helper refuses the channel", () =>
    Effect.gen(function* () {
      const { helper, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      yield* helper.send(refused("agent_desktop_paired"));
      const status = yield* stateWhere(switches, phaseIs("off"));
      assert.deepStrictEqual(switchOf(status)?.switch, {
        phase: "off",
        problem: { from: "helper", reason: "agent_desktop_paired", httpStatus: 0 },
      });
      // As when the person turns it off: the helper forgets the channel.
      assert.deepStrictEqual(stopsOf(helper), [ORIGIN]);
      // Nothing starts again by itself.
      yield* TestClock.adjust(Duration.minutes(5));
      assert.lengthOf(startsOf(helper), 1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [404, "unknown-environment"],
    [403, "not-permitted"],
    [409, "environment-state-conflict"],
  ] as const)(
    "turns the switch off when Lazurio Auth answers the hand-over with %i",
    ([status, reason]) =>
      Effect.gen(function* () {
        const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
        auth.handOverAnswers.push(new HandOverError({ reason, status }));
        yield* switches.setSwitch(ORIGIN, true);
        const current = yield* stateWhere(switches, phaseIs("off"));
        assert.deepStrictEqual(switchOf(current)?.switch, {
          phase: "off",
          problem: { from: "auth", reason },
        });
        assert.lengthOf(startsOf(helper), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("tries again with a back-off when Lazurio Auth answers 503 or does not answer", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
      auth.handOverAnswers.push(
        new HandOverError({ reason: "unavailable", status: 503 }),
        new AuthUnreachableError({ operation: "hand-over" }),
      );
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("retrying"));
      assert.deepStrictEqual(switchOf(switches.current())?.switch, {
        phase: "retrying",
        cause: "auth-unavailable",
      });
      yield* TestClock.adjust(Duration.seconds(1));
      yield* stateWhere(switches, () => auth.handOverOrigins.length === 2);
      yield* stateWhere(switches, phaseIs("retrying"));
      // The second wait is twice as long.
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(auth.handOverOrigins, 2);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* stateWhere(switches, phaseIs("channel"));
      assert.lengthOf(auth.handOverOrigins, 3);
      assert.lengthOf(startsOf(helper), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("turns the switch off when the session ended while it was on", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      // The 8 hours are over and Lazurio Auth refuses the refresh token.
      auth.handOverAnswers.push(new SignedOutError());
      yield* helper.send(needsHandOver(1000, "expired"));
      yield* stateWhere(switches, phaseIs("retrying"));
      yield* TestClock.adjust(Duration.seconds(1));
      const status = yield* stateWhere(switches, phaseIs("off"));
      assert.deepStrictEqual(switchOf(status)?.switch, {
        phase: "off",
        problem: { from: "auth", reason: "signed-out" },
      });
      assert.strictEqual(status.account, "signed-out");
      assert.strictEqual(auth.calls.signIn, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("signs in once when the session it kept is no longer valid at the switch's click", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
      auth.handOverAnswers.push(new SignedOutError());
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("signing-in"));
      yield* Queue.offer(auth.signIns, "ok");
      yield* stateWhere(switches, phaseIs("channel"));
      assert.strictEqual(auth.calls.signIn, 1);
      assert.lengthOf(startsOf(helper), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("turns the switch off when the sign-in does not finish", () =>
    Effect.gen(function* () {
      const { auth, switches } = yield* setUp({ account: "signedOut" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("signing-in"));
      yield* Queue.offer(auth.signIns, new SignInError({ reason: "denied" }));
      const status = yield* stateWhere(switches, phaseIs("off"));
      assert.deepStrictEqual(switchOf(status)?.switch, {
        phase: "off",
        problem: { from: "auth", reason: "sign-in-failed" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("sends StopChannel when the person turns the switch off", () =>
    Effect.gen(function* () {
      const { helper, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      yield* switches.setSwitch(ORIGIN, false);
      assert.deepStrictEqual(switchOf(switches.current()), {
        origin: ORIGIN,
        host: HOST,
        switch: { phase: "off", problem: null },
        channel: { state: "off" },
      });
      assert.deepStrictEqual(stopsOf(helper), [ORIGIN]);
      // A NeedsHandOver of the stopped channel asks for nothing.
      yield* helper.send(needsHandOver(1000));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.lengthOf(startsOf(helper), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("signs out and turns every switch off", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({
        account: "signedIn",
        origins: [ORIGIN, OTHER],
      });
      yield* switches.setSwitch(ORIGIN, true);
      yield* switches.setSwitch(OTHER, true);
      yield* stateWhere(
        switches,
        (status) => phaseIs("channel")(status) && phaseIs("channel", OTHER)(status),
      );
      yield* switches.signOut;
      const status = switches.current();
      assert.strictEqual(auth.calls.signOut, 1);
      assert.deepStrictEqual(
        status.switches.map((entry) => entry.switch),
        [
          { phase: "off", problem: null },
          { phase: "off", problem: null },
        ],
      );
      assert.deepStrictEqual(stopsOf(helper).toSorted(), [ORIGIN, OTHER].toSorted());
      yield* stateWhere(switches, (current) => current.account === "signed-out");
    }).pipe(Effect.scoped),
  );

  it.effect("tells the window when the sign-out does not last past a restart", () =>
    Effect.gen(function* () {
      const { helper, auth, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      auth.signOutAnswers.push("not-removed");
      const failure = yield* Effect.flip(switches.signOut);
      assert.strictEqual(failure.problem, "not-saved");
      // The switches are off and the channel stopped all the same.
      assert.deepStrictEqual(switches.current().switches[0]?.switch, {
        phase: "off",
        problem: null,
      });
      assert.deepStrictEqual(stopsOf(helper), [ORIGIN]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the hand-over out of every log and of the windows' state", () =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const capture = Logger.map(Logger.formatJson, (line) => {
        logs.push(line);
      });
      yield* Effect.gen(function* () {
        const { helper, switches } = yield* setUp({ account: "signedIn" });
        yield* switches.setSwitch(ORIGIN, true);
        yield* stateWhere(switches, phaseIs("channel"));
        yield* helper.send(needsHandOver(1000));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* stateWhere(switches, () => startsOf(helper).length === 2);
        yield* helper.send(refused("hand_over_refused", 401));
        const status = yield* stateWhere(switches, phaseIs("off"));
        assert.deepStrictEqual(helper.handOvers, [handOverNumber(1), handOverNumber(2)]);
        // The app's copy of each hand-over's bytes is wiped once the helper took it.
        for (const start of startsOf(helper)) {
          assert.isTrue(start.handOver.every((byte) => byte === 0));
        }
        const written = [...logs, JSON.stringify(status)].join("\n");
        assert.isAbove(logs.length, 0);
        for (const handOver of helper.handOvers) assert.notInclude(written, handOver);
      }).pipe(
        Effect.scoped,
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
    }),
  );

  it.effect("offers to add only the Environment the main window shows", () =>
    Effect.gen(function* () {
      const { switches } = yield* setUp({ account: "signedOut", origins: [] });
      assert.isNull(switches.current().addable);
      switches.pageShown("https://dashboard.lazurio.ai/orgs/example");
      assert.isNull(switches.current().addable);
      switches.pageShown(`${ORIGIN}/settings/tools`);
      assert.strictEqual(switches.current().addable, ORIGIN);
      const refusedAdd = yield* switches.addEnvironment(OTHER).pipe(Effect.flip);
      assert.strictEqual(refusedAdd.problem, "not-addable");
      yield* switches.addEnvironment(ORIGIN);
      const status = switches.current();
      assert.isNull(status.addable);
      assert.deepStrictEqual(status.switches, [
        {
          origin: ORIGIN,
          host: HOST,
          switch: { phase: "off", problem: null },
          channel: { state: "off" },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes an Environment and stops its channel first", () =>
    Effect.gen(function* () {
      const { helper, switches } = yield* setUp({ account: "signedIn" });
      yield* switches.setSwitch(ORIGIN, true);
      yield* stateWhere(switches, phaseIs("channel"));
      yield* switches.removeEnvironment(ORIGIN);
      assert.deepStrictEqual(switches.current().switches, []);
      assert.deepStrictEqual(stopsOf(helper), [ORIGIN]);
      const refusedSwitch = yield* switches.setSwitch(ORIGIN, true).pipe(Effect.flip);
      assert.strictEqual(refusedSwitch.problem, "not-listed");
    }).pipe(Effect.scoped),
  );

  it.effect("starts with every switch off and the saved Environments of the last run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const file = (yield* Path.Path).join(directory, "agent-desktop-environments.json");
      const first = yield* DeviceEnvironments.open(file);
      yield* first.add(ORIGIN);
      yield* first.add(OTHER);
      // The app starts again.
      const { helper, switches } = yield* setUp({
        account: "signedIn",
        environments: yield* DeviceEnvironments.open(file),
      });
      assert.deepStrictEqual(
        switches.current().switches.map((entry) => [entry.origin, entry.switch]),
        [
          [ORIGIN, { phase: "off", problem: null }],
          [OTHER, { phase: "off", problem: null }],
        ],
      );
      assert.lengthOf(startsOf(helper), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
