import { create } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import {
  AppMessageSchema,
  HelperMessageSchema,
  type HelperMessage,
} from "@lazurio/app-contracts/helper/v1";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { HelperStatus } from "../shared/bridge.ts";

// Starts a helper process and holds the conversation of proto/lazurio/app/helper/v1 with it: the
// helper's Hello, a Ping answered by its Pong, and Shutdown when the scope closes.

const PROTOCOL_VERSION = 1;

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

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const start = Effect.fn("Helpers.start")(function* (binary: HelperBinary) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(binary.path, [], { stdin: "pipe", stderr: "inherit" }),
  );
  const outbox = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  yield* Stream.fromQueue(outbox).pipe(Stream.run(child.stdin), Effect.forkScoped);
  const replies = decodeFrames(HelperMessageSchema, Stream.toAsyncIterable(child.stdout));

  const failure = (problem: string) => new HelperProtocolError({ helper: binary.name, problem });
  const nextReply = Effect.tryPromise({
    try: () => replies.next(),
    catch: () => failure("its output could not be read"),
  }).pipe(
    Effect.flatMap((result) =>
      result.done === true
        ? Effect.fail(failure("it closed its output"))
        : Effect.succeed<HelperMessage>(result.value),
    ),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(failure("it did not answer in time")),
    }),
  );

  const hello = yield* nextReply;
  if (hello.kind.case !== "hello") return yield* failure("its first message was not Hello");
  if (hello.kind.value.protocolVersion !== PROTOCOL_VERSION) {
    return yield* failure(`it speaks protocol ${hello.kind.value.protocolVersion}`);
  }
  if (hello.kind.value.helperName !== binary.name) {
    return yield* failure(`it introduced itself as ${hello.kind.value.helperName}`);
  }

  yield* Effect.addFinalizer(() =>
    Queue.offer(
      outbox,
      encodeFrame(
        AppMessageSchema,
        create(AppMessageSchema, { requestId: 2n, kind: { case: "shutdown", value: {} } }),
      ),
    ).pipe(
      Effect.andThen(Queue.end(outbox)),
      Effect.andThen(child.exitCode.pipe(Effect.timeout("2 seconds"))),
      Effect.ignore,
    ),
  );

  const nonce = crypto.getRandomValues(new Uint8Array(16));
  yield* Queue.offer(
    outbox,
    encodeFrame(
      AppMessageSchema,
      create(AppMessageSchema, { requestId: 1n, kind: { case: "ping", value: { nonce } } }),
    ),
  );
  const pong = yield* nextReply;
  if (
    pong.requestId !== 1n ||
    pong.kind.case !== "pong" ||
    !sameBytes(pong.kind.value.nonce, nonce)
  ) {
    return yield* failure("it did not answer Ping with its Pong");
  }

  return hello.kind.value.helperVersion;
});

// Starts each helper for as long as the scope lives and reports how each one came up. A helper
// that fails does not stop the app; its status says why.
export const startAll = (binaries: ReadonlyArray<HelperBinary>) =>
  Effect.forEach(
    binaries,
    (binary) =>
      start(binary).pipe(
        Effect.map((version): HelperStatus => ({ name: binary.name, state: "ready", version })),
        Effect.catch((error) =>
          Effect.succeed<HelperStatus>({
            name: binary.name,
            state: "failed",
            problem: error.message,
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
