import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  HelperMessageSchema,
  type AppMessage,
  type HelperMessage,
} from "@lazurio/app-contracts/helper/v1";
import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { DeviceStatus } from "../shared/bridge.ts";
import { run, type DeviceService } from "./DeviceService.ts";
import type { HelperConnection } from "./Helpers.ts";

type RequestKind = NonNullable<AppMessage["kind"]>;
type Reply = NonNullable<MessageInitShape<typeof HelperMessageSchema>["kind"]>;

const lock = (
  sequence: number,
  fields: { readonly idle?: boolean; readonly updateHold?: boolean; readonly holder?: string } = {},
): Reply => ({
  case: "lockState",
  value: {
    idle: fields.idle ?? true,
    updateHold: fields.updateHold ?? false,
    holderEnvironmentId: fields.holder ?? "",
    holderEnvironmentLabel: fields.holder === undefined ? "" : `Label of ${fields.holder}`,
    sequence: BigInt(sequence),
  },
});

// A Device helper as the main process sees it: the test answers each request and sends the
// helper's own messages; `stop` ends its output, as the helper's exit does.
const fakeHelper = Effect.gen(function* () {
  const events = yield* Queue.unbounded<HelperMessage, Cause.Done>();
  const stopped = yield* Deferred.make<boolean>();
  const requests: Array<RequestKind> = [];
  const answers: Array<(kind: RequestKind) => Reply | undefined> = [];
  const answerFor = (kind: RequestKind): Reply => {
    for (const answer of answers) {
      const reply = answer(kind);
      if (reply !== undefined) return reply;
    }
    if (kind.case === "configureDevice") {
      return { case: "deviceReady", value: { contractVersion: 1 } };
    }
    return { case: "failure", value: { code: "unknown_request", message: "not in this test" } };
  };
  const connection: HelperConnection = {
    name: "lazurio-device",
    version: "0.0.0-test",
    request: (kind) =>
      Effect.sync(() => {
        requests.push(kind as RequestKind);
        return create(HelperMessageSchema, { requestId: 1n, kind: answerFor(kind as RequestKind) });
      }),
    events: Stream.fromQueue(events),
    stopped: Deferred.await(stopped),
  };
  const send = (kind: Reply) =>
    Queue.offer(events, create(HelperMessageSchema, { requestId: 0n, kind }));
  // The helper exits: its output ends, in time or not.
  const exit = (inTime: boolean) =>
    Queue.end(events).pipe(Effect.andThen(Deferred.succeed(stopped, inTime)));
  return { connection, requests, answers, send, exit };
});

const start = (helper: Effect.Success<typeof fakeHelper>, proxyHosts: ReadonlyArray<string> = []) =>
  run({
    connection: helper.connection,
    dataDirectory: "/data/device",
    computerName: "Work laptop",
    tailnets: {
      proxyFor: (host) =>
        proxyHosts.includes(host)
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

// Waits until the service's state passes the check, from the change that made it so.
const stateWhere = (service: DeviceService, check: (status: DeviceStatus) => boolean) =>
  Effect.callback<DeviceStatus>((resume) => {
    if (check(service.current())) {
      resume(Effect.succeed(service.current()));
      return;
    }
    const stop = service.subscribe(() => {
      if (!check(service.current())) return;
      stop();
      resume(Effect.succeed(service.current()));
    });
    return Effect.sync(stop);
  });

const activityOf = (service: DeviceService) =>
  Option.match(service.activity, {
    onNone: () => assert.fail("the configured service gives no activity"),
    onSome: (activity) => activity,
  });

describe("DeviceService", () => {
  it.effect("configures the helper once with its data directory and the computer's name", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      const service = yield* start(helper);
      assert.strictEqual(service.current().state, "ready");
      assert.deepStrictEqual(
        helper.requests.map((kind) => kind.case),
        ["configureDevice"],
      );
      const [configure] = helper.requests;
      assert.strictEqual(configure?.case, "configureDevice");
      if (configure?.case === "configureDevice") {
        assert.strictEqual(configure.value.dataDirectory, "/data/device");
        assert.strictEqual(configure.value.computerName, "Work laptop");
      }
      assert.isTrue(Option.isSome(service.activity));
    }).pipe(Effect.scoped),
  );

  it.effect("fails and leaves the computer's activity to the default when configuring fails", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "configureDevice"
          ? { case: "failure", value: { code: "invalid_request", message: "no lock" } }
          : undefined,
      );
      const service = yield* start(helper);
      assert.strictEqual(service.current().state, "failed");
      assert.isTrue(Option.isNone(service.activity));
    }).pipe(Effect.scoped),
  );

  it.effect("follows each Environment's channel and shows who works on the computer", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      const service = yield* start(helper);
      yield* helper.send({
        case: "channelState",
        value: { environmentId: "env-a", state: { case: "connecting", value: {} } },
      });
      yield* helper.send({
        case: "channelState",
        value: {
          environmentId: "env-a",
          state: { case: "working", value: { tool: "click", application: "Outlook" } },
        },
      });
      yield* helper.send({
        case: "channelState",
        value: {
          environmentId: "env-b",
          state: { case: "refused", value: { reason: "not-paired" } },
        },
      });
      const status = yield* stateWhere(service, (status) => status.environments.length === 2);
      assert.deepStrictEqual(status.environments, [
        {
          environmentId: "env-a",
          label: "env-a",
          channel: { state: "working", tool: "click", application: "Outlook" },
        },
        {
          environmentId: "env-b",
          label: "env-b",
          channel: { state: "refused", reason: "not-paired" },
        },
      ]);
      assert.deepStrictEqual(status.agent, { environmentId: "env-a", label: "env-a" });
    }).pipe(Effect.scoped),
  );

  it.effect("sends Stop and StopChannel and takes their answers", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "stopAgent"
          ? lock(3)
          : kind.case === "stopChannel"
            ? {
                case: "channelState",
                value: {
                  environmentId: kind.value.environmentId,
                  state: { case: "off", value: {} },
                },
              }
            : undefined,
      );
      const service = yield* start(helper);
      yield* helper.send(lock(2, { idle: false, holder: "env-a" }));
      yield* stateWhere(service, (status) => status.agent !== null);
      yield* service.stop;
      assert.isNull(service.current().agent);
      yield* service.stopChannel("env-a");
      assert.deepStrictEqual(
        helper.requests.map((kind) => kind.case),
        ["configureDevice", "stopAgent", "stopChannel"],
      );
      assert.deepStrictEqual(service.current().environments, [
        { environmentId: "env-a", label: "Label of env-a", channel: { state: "off" } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("gives StartChannel the tailnet's proxy only for a host a tailnet serves", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "startChannel"
          ? {
              case: "channelState",
              value: {
                environmentId: kind.value.environmentId,
                state: { case: "connecting", value: { failedAttempts: 0 } },
              },
            }
          : undefined,
      );
      const service = yield* start(helper, ["launchpad.bob.example-org.lazurio.io"]);
      const request = {
        environmentId: "env-a",
        environmentLabel: "Bob's Environment",
        deviceId: "work-laptop",
        keySeed: new Uint8Array(32),
      };
      yield* service.startChannel({
        ...request,
        attachUrl: "wss://launchpad.bob.example-org.lazurio.io/.lazurio/computers/attach",
      });
      yield* service.startChannel({
        ...request,
        attachUrl: "wss://launchpad.example.com/.lazurio/computers/attach",
      });
      const proxies = helper.requests.flatMap((kind) =>
        kind.case === "startChannel" ? [kind.value.proxy?.host ?? "direct"] : [],
      );
      assert.deepStrictEqual(proxies, ["127.0.0.1", "direct"]);
      assert.strictEqual(service.current().environments[0]?.label, "Bob's Environment");
    }).pipe(Effect.scoped),
  );
});

describe("DeviceService's activity of the computer", () => {
  it.effect("grants the updater's hold by the helper's answer and releases it with its scope", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "holdForUpdate"
          ? lock(kind.value.hold ? 1 : 2, { updateHold: kind.value.hold })
          : undefined,
      );
      const activity = activityOf(yield* start(helper));
      const holdScope = yield* Scope.make();
      assert.isTrue(yield* activity.holdForUpdate.pipe(Scope.provide(holdScope)));
      yield* Scope.close(holdScope, Exit.void);
      const holds = helper.requests.flatMap((kind) =>
        kind.case === "holdForUpdate" ? [kind.value.hold] : [],
      );
      assert.deepStrictEqual(holds, [true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the hold while an agent works, and says when the computer is idle", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "holdForUpdate" ? lock(1, { idle: false, holder: "env-a" }) : undefined,
      );
      const activity = activityOf(yield* start(helper));
      const changes = yield* activity.idleChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isFalse(yield* Effect.scoped(activity.holdForUpdate));
      assert.isFalse(yield* activity.isIdle);
      // The holder's engine ended: the helper says so on its own.
      yield* helper.send(lock(2));
      assert.deepStrictEqual([...(yield* Fiber.join(changes))], [false, true]);
      assert.isTrue(yield* activity.isIdle);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a grant that comes after a revocation with a higher sequence", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      // The revocation (sequence 5) is applied before the grant's answer (sequence 4) arrives.
      helper.answers.push((kind) =>
        kind.case === "holdForUpdate" && kind.value.hold
          ? lock(4, { updateHold: true })
          : undefined,
      );
      const service = yield* start(helper);
      const activity = activityOf(service);
      yield* helper.send(lock(5, { idle: false, holder: "env-a" }));
      yield* stateWhere(service, (status) => status.agent !== null);
      assert.isFalse(yield* Effect.scoped(activity.holdForUpdate));
      assert.isFalse(yield* activity.isIdle);
    }).pipe(Effect.scoped),
  );

  it.effect("ends a granted hold when the helper revokes it", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "holdForUpdate" && kind.value.hold
          ? lock(1, { updateHold: true })
          : undefined,
      );
      const activity = activityOf(yield* start(helper));
      const changes = yield* activity.idleChanges.pipe(Stream.runHead, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isTrue(yield* activity.holdForUpdate);
      yield* helper.send(lock(2, { idle: false, updateHold: false, holder: "env-a" }));
      assert.deepStrictEqual(yield* Fiber.join(changes), Option.some(false));
      yield* helper.send({ case: "deviceStopped", value: { allEnginesEnded: true } });
      yield* helper.exit(true);
      assert.isFalse(yield* activity.confirmStopped);
    }).pipe(Effect.scoped),
  );
});

describe("DeviceService's confirmation that the helper stopped", () => {
  // The updater held the computer, then stopped the helpers; what the helper said last decides.
  const afterGrant = (end: (helper: Effect.Success<typeof fakeHelper>) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      helper.answers.push((kind) =>
        kind.case === "holdForUpdate" && kind.value.hold
          ? lock(1, { updateHold: true })
          : undefined,
      );
      const activity = activityOf(yield* start(helper));
      assert.isTrue(yield* activity.holdForUpdate);
      yield* end(helper);
      return yield* activity.confirmStopped;
    }).pipe(Effect.scoped);

  it.effect("confirms when the helper said every engine ended and exited in time", () =>
    Effect.gen(function* () {
      const confirmed = yield* afterGrant((helper) =>
        helper
          .send({ case: "deviceStopped", value: { allEnginesEnded: true } })
          .pipe(Effect.andThen(helper.exit(true))),
      );
      assert.isTrue(confirmed);
    }),
  );

  it.effect("does not confirm when the helper said an engine may still run", () =>
    Effect.gen(function* () {
      const confirmed = yield* afterGrant((helper) =>
        helper
          .send({ case: "deviceStopped", value: { allEnginesEnded: false } })
          .pipe(Effect.andThen(helper.exit(true))),
      );
      assert.isFalse(confirmed);
    }),
  );

  it.effect("does not confirm without DeviceStopped", () =>
    Effect.gen(function* () {
      const confirmed = yield* afterGrant((helper) => helper.exit(true));
      assert.isFalse(confirmed);
    }),
  );

  it.effect("does not confirm a helper that did not exit within two seconds", () =>
    Effect.gen(function* () {
      const confirmed = yield* afterGrant((helper) =>
        helper
          .send({ case: "deviceStopped", value: { allEnginesEnded: true } })
          .pipe(Effect.andThen(helper.exit(false))),
      );
      assert.isFalse(confirmed);
    }),
  );

  it.effect("does not confirm a helper that was never asked to hold the computer", () =>
    Effect.gen(function* () {
      const helper = yield* fakeHelper;
      const activity = activityOf(yield* start(helper));
      yield* helper.send({ case: "deviceStopped", value: { allEnginesEnded: true } });
      yield* helper.exit(true);
      assert.isFalse(yield* activity.confirmStopped);
    }).pipe(Effect.scoped),
  );
});
