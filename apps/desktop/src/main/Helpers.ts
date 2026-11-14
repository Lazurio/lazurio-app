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
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { HelperStatus } from "../shared/bridge.ts";

// Starts a helper process and holds the conversation of proto/lazurio/app/helper/v1 with it: the
// helper's Hello, a Ping answered by its Pong, requests that each wait for the reply with their id,
// the helper's own messages (request_id 0) as a stream of events, and Shutdown when the scope
// closes.

const PROTOCOL_VERSION = 1;

// What a request carries: the kind of an AppMessage, as `create` takes it.
type RequestKind = NonNullable<MessageInitShape<typeof AppMessageSchema>["kind"]>;
const REPLY_TIMEOUT = "10 seconds";

export interface HelperBinary {
  readonly name: string;
  readonly path: string;
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
  // Sends a request and waits for the helper's reply to it.
  readonly request: (kind: RequestKind) => Effect.Effect<HelperMessage, HelperProtocolError>;
  // The messages the helper sends on its own, after its Hello.
  readonly events: Stream.Stream<HelperMessage>;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const connect = Effect.fn("Helpers.connect")(function* (binary: HelperBinary) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(binary.path, [], { stdin: "pipe", stderr: "inherit" }),
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

  const events = yield* Queue.unbounded<HelperMessage>();
  const pending = new Map<bigint, Deferred.Deferred<HelperMessage>>();
  yield* Stream.fromAsyncIterable(replies, () => failure("its output could not be read")).pipe(
    Stream.runForEach((message) => {
      if (message.requestId === 0n) return Queue.offer(events, message);
      const waiting = pending.get(message.requestId);
      pending.delete(message.requestId);
      return waiting === undefined ? Effect.void : Deferred.succeed(waiting, message);
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  let nextRequestId = 1n;
  const request = Effect.fn("Helpers.request")(function* (kind: RequestKind) {
    const requestId = nextRequestId;
    nextRequestId += 1n;
    const reply = yield* Deferred.make<HelperMessage>();
    pending.set(requestId, reply);
    yield* send(requestId, kind);
    return yield* Deferred.await(reply).pipe(
      Effect.timeoutOrElse({
        duration: REPLY_TIMEOUT,
        orElse: () => Effect.fail(failure(`it did not answer request ${requestId} in time`)),
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    send(nextRequestId, { case: "shutdown", value: {} }).pipe(
      Effect.andThen(Queue.end(outbox)),
      Effect.andThen(child.exitCode.pipe(Effect.timeout("2 seconds"))),
      Effect.ignore,
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
