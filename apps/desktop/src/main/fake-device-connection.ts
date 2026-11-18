// Tests only: a Device helper as the main process sees it, in the test's own process.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  HelperMessageSchema,
  type AppMessage,
  type HelperMessage,
} from "@lazurio/app-contracts/helper/v1";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { HelperConnection } from "./Helpers.ts";

export type RequestKind = NonNullable<AppMessage["kind"]>;
export type Reply = NonNullable<MessageInitShape<typeof HelperMessageSchema>["kind"]>;
// Besides a reply: a request the helper never answers, or one whose wait is interrupted.
type Answer = Reply | "no-answer" | "interrupted";
// What the helper does on the app's Shutdown: it ends every engine, says DeviceStopped and exits;
// it exits without DeviceStopped; or it does not exit at all.
type ShutdownMode = "confirms" | "no-device-stopped" | "does-not-exit";

// A Device helper as the main process sees it: the test answers each request and sends the
// helper's own messages; `stop` ends its output, as the helper's exit does.
export const fakeHelper = Effect.gen(function* () {
  const events = yield* Queue.unbounded<HelperMessage, Cause.Done>();
  const stopped = yield* Deferred.make<boolean>();
  const stopping = yield* Deferred.make<void>();
  const requests: Array<RequestKind> = [];
  // Each StartChannel's hand-over as the helper received it: the app wipes its copy afterwards.
  const handOvers: Array<string> = [];
  // How often the service ended the helper's process, and when it first did.
  const ended = { count: 0 };
  const endedOnce = yield* Deferred.make<void>();
  const answers: Array<(kind: RequestKind) => Answer | undefined> = [];
  const shutdown: { mode: ShutdownMode; count: number } = { mode: "confirms", count: 0 };
  const answerFor = (kind: RequestKind): Answer => {
    for (const answer of answers) {
      const reply = answer(kind);
      if (reply !== undefined) return reply;
    }
    if (kind.case === "configureDevice") {
      return { case: "deviceReady", value: { contractVersion: 3 } };
    }
    return { case: "failure", value: { code: "unknown_request", message: "not in this test" } };
  };
  const send = (kind: Reply) =>
    Queue.offer(events, create(HelperMessageSchema, { requestId: 0n, kind }));
  const connection: HelperConnection = {
    name: "lazurio-device",
    version: "0.0.0-test",
    request: (kind) =>
      Effect.suspend(() => {
        requests.push(kind as RequestKind);
        if (kind.case === "startChannel") {
          handOvers.push(new TextDecoder().decode(kind.value.handOver));
        }
        const answer = answerFor(kind as RequestKind);
        if (answer === "no-answer") return Effect.never;
        if (answer === "interrupted") return Effect.interrupt;
        return Effect.succeed(create(HelperMessageSchema, { requestId: 1n, kind: answer }));
      }),
    events: Stream.fromQueue(events),
    stopped: Deferred.await(stopped),
    stopping: Deferred.isDone(stopping),
    pid: 4242,
    end: Effect.sync(() => {
      ended.count += 1;
    }).pipe(Effect.andThen(Deferred.succeed(endedOnce, undefined)), Effect.asVoid),
    shutdown: Effect.gen(function* () {
      shutdown.count += 1;
      yield* Deferred.succeed(stopping, undefined);
      if (shutdown.mode === "does-not-exit") return false;
      if (shutdown.mode === "confirms") {
        yield* send({ case: "deviceStopped", value: { allEnginesEnded: true } });
      }
      yield* Queue.end(events);
      yield* Deferred.succeed(stopped, true);
      return true;
    }),
  };
  // The app stops the helper, which exits: its output ends, in time or not.
  const exit = (inTime: boolean) =>
    Deferred.succeed(stopping, undefined).pipe(
      Effect.andThen(Queue.end(events)),
      Effect.andThen(Deferred.succeed(stopped, inTime)),
    );
  // The helper dies on its own: its output ends while the app did not stop it.
  const die = Queue.end(events);
  return {
    connection,
    requests,
    handOvers,
    answers,
    shutdown,
    send,
    exit,
    die,
    ended,
    endedOnce,
  };
});

export type FakeHelper = Effect.Success<typeof fakeHelper>;
