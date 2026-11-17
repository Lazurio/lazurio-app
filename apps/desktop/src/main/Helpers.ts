import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import {
  AppMessageSchema,
  HelperMessageSchema,
  type HelperMessage,
} from "@lazurio/app-contracts/helper/v1";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { HelperStatus } from "../shared/bridge.ts";

// Starts a helper process and holds the conversation of proto/lazurio/app/helper/v1 with it: the
// helper's Hello, a Ping answered by its Pong, requests that each wait for the reply with their id,
// the helper's own messages (request_id 0) as a stream of events that ends with its output, and
// Shutdown when the scope closes.

const PROTOCOL_VERSION = 1;

// What a request carries: the kind of an AppMessage, as `create` takes it.
type RequestKind = NonNullable<MessageInitShape<typeof AppMessageSchema>["kind"]>;
const REPLY_TIMEOUT = "10 seconds";
// A helper exits within this after Shutdown (docs/adr/0006, point 8).
const STOP_WITHIN = "2 seconds";

export interface HelperBinary {
  readonly name: string;
  readonly path: string;
  // Arguments for the program at path; end-to-end tests run a script through Node this way.
  readonly args?: ReadonlyArray<string>;
}

class HelperProtocolError extends Schema.TaggedError<HelperProtocolError>()("HelperProtocolError", {
  helper: Schema.String,
  problem: Schema.String,
}) {
  override get message(): string {
    return `${this.helper}: ${this.problem}`;
  }
}

export interface HelperConnection {
  readonly name: string;
  readonly version: string;
  // The process the app started, for end-to-end tests that end it by its PID.
  readonly pid: number;
  // Sends a request and waits for the helper's reply to it; fails at once once its output ended.
  readonly request: (kind: RequestKind) => Effect.Effect<HelperMessage, HelperProtocolError>;
  // The messages the helper sends on its own, after its Hello. They end with the helper's output.
  readonly events: Stream.Stream<HelperMessage>;
  // Waits until the helper's scope closed: true when, after Shutdown, the helper exited and its
  // output ended within two seconds, so every message it sent is among the events.
  readonly stopped: Effect.Effect<boolean>;
  // Whether the app began to stop the helper; an end of its output before that is unexpected.
  readonly stopping: Effect.Effect<boolean>;
  // Ends the helper's process by the PID the app started, never by its name: SIGTERM, which the
  // helper answers by ending what it started, and SIGKILL after two seconds (on Windows, Effect's
  // spawner runs `taskkill /T /F`). Waits until it exited; a process already gone is no failure.
  readonly end: Effect.Effect<void>;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const connect = Effect.fn("Helpers.connect")(function* (binary: HelperBinary) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(binary.path, [...(binary.args ?? [])], { stdin: "pipe", stderr: "inherit" }),
  );
  const failure = (problem: string) => new HelperProtocolError({ helper: binary.name, problem });

  const outbox = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  yield* Stream.fromQueue(outbox).pipe(Stream.run(child.stdin), Effect.forkScoped);
  const send = (requestId: bigint, kind: RequestKind) =>
    Queue.offer(
      outbox,
      encodeFrame(AppMessageSchema, create(AppMessageSchema, { requestId, kind })),
    );

  const replies = decodeFrames(HelperMessageSchema, Stream.toAsyncIterable(child.stdout));
  const first = yield* Effect.tryPromise({
    try: () => replies.next(),
    catch: () => failure("its output could not be read"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(failure("it did not say Hello in time")),
    }),
  );
  if (first.done === true) return yield* failure("it closed its output");
  const hello = first.value;
  if (hello.kind.case !== "hello") return yield* failure("its first message was not Hello");
  if (hello.kind.value.protocolVersion !== PROTOCOL_VERSION) {
    return yield* failure(`it speaks protocol ${hello.kind.value.protocolVersion}`);
  }
  if (hello.kind.value.helperName !== binary.name) {
    return yield* failure(`it introduced itself as ${hello.kind.value.helperName}`);
  }

  const events = yield* Queue.unbounded<HelperMessage, Cause.Done>();
  const pending = new Map<bigint, Deferred.Deferred<HelperMessage, HelperProtocolError>>();
  // Once the output ended, no reply can come: every waiting request fails at once, and so does
  // every later one.
  let outputEnded = false;
  const endOutput = Effect.suspend(() => {
    outputEnded = true;
    const waiting = [...pending.values()];
    pending.clear();
    return Effect.forEach(waiting, (reply) =>
      Deferred.fail(reply, failure("its output ended")),
    ).pipe(Effect.andThen(Queue.end(events)));
  });
  const reader = yield* Stream.fromAsyncIterable(replies, () =>
    failure("its output could not be read"),
  ).pipe(
    Stream.runForEach((message) => {
      if (message.requestId === 0n) return Queue.offer(events, message);
      const waiting = pending.get(message.requestId);
      pending.delete(message.requestId);
      return waiting === undefined ? Effect.void : Deferred.succeed(waiting, message);
    }),
    Effect.ignore,
    Effect.ensuring(endOutput),
    Effect.forkScoped,
  );

  let nextRequestId = 1n;
  const request = Effect.fn("Helpers.request")(function* (kind: RequestKind) {
    const requestId = nextRequestId;
    nextRequestId += 1n;
    const reply = yield* Deferred.make<HelperMessage, HelperProtocolError>();
    pending.set(requestId, reply);
    if (outputEnded) {
      pending.delete(requestId);
      return yield* failure("its output ended");
    }
    yield* send(requestId, kind);
    return yield* Deferred.await(reply).pipe(
      Effect.timeoutOrElse({
        duration: REPLY_TIMEOUT,
        orElse: () => Effect.fail(failure(`it did not answer request ${requestId} in time`)),
      }),
    );
  });

  // Shutdown, the end of the helper's input, and then its exit and the end of its output, which
  // the reader takes in before the scope ends it.
  const stopped = yield* Deferred.make<boolean>();
  const stopping = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() =>
    Deferred.succeed(stopping, undefined).pipe(
      Effect.andThen(send(nextRequestId, { case: "shutdown", value: {} })),
      Effect.andThen(Queue.end(outbox)),
      Effect.andThen(
        Effect.all([child.exitCode, Fiber.await(reader)]).pipe(Effect.timeout(STOP_WITHIN)),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((inTime) => Deferred.succeed(stopped, inTime)),
    ),
  );

  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const pong = yield* request({ case: "ping", value: { nonce } });
  if (pong.kind.case !== "pong" || !sameBytes(pong.kind.value.nonce, nonce)) {
    return yield* failure("it did not answer Ping with its Pong");
  }

  const connection: HelperConnection = {
    name: binary.name,
    version: hello.kind.value.helperVersion,
    request,
    events: Stream.fromQueue(events),
    stopped: Deferred.await(stopped),
    stopping: Deferred.isDone(stopping),
    pid: child.pid,
    end: child.kill({ killSignal: "SIGTERM", forceKillAfter: STOP_WITHIN }).pipe(Effect.ignore),
  };
  return connection;
});

export interface StartedHelper {
  readonly status: HelperStatus;
  readonly connection: Option.Option<HelperConnection>;
}

// Starts each helper for as long as the scope lives and reports how each one came up. A helper
// that fails does not stop the app; its status says why.
export const startAll = (binaries: ReadonlyArray<HelperBinary>) =>
  Effect.forEach(
    binaries,
    (binary) =>
      connect(binary).pipe(
        Effect.map((connection): StartedHelper => ({
          status: { name: binary.name, state: "ready", version: connection.version },
          connection: Option.some(connection),
        })),
        Effect.catch((error) =>
          Effect.succeed<StartedHelper>({
            status: { name: binary.name, state: "failed", problem: error.message },
            connection: Option.none(),
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
