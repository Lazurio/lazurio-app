import { create } from "@bufbuild/protobuf";
import { assert, describe, it } from "@effect/vitest";

import { decodeFrames, encodeFrame } from "./framing.ts";
import { HelperMessageSchema } from "./gen/lazurio/app/helper/v1/helper_pb.ts";

async function* chunksOf(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

const collect = async <T>(iterator: AsyncIterable<T>): Promise<Array<T>> => {
  const items: Array<T> = [];
  for await (const item of iterator) items.push(item);
  return items;
};

describe("framing", () => {
  it("decodes the helper's messages in order, however the stream splits them", async () => {
    const hello = create(HelperMessageSchema, {
      requestId: 0n,
      kind: {
        case: "hello",
        value: { protocolVersion: 1, helperName: "lazurio-tailnet", helperVersion: "0.0.0" },
      },
    });
    const pong = create(HelperMessageSchema, {
      requestId: 7n,
      kind: { case: "pong", value: { nonce: new Uint8Array([1, 2, 3]) } },
    });
    const stream = new Uint8Array([
      ...encodeFrame(HelperMessageSchema, hello),
      ...encodeFrame(HelperMessageSchema, pong),
    ]);

    const decoded = await collect(decodeFrames(HelperMessageSchema, chunksOf(stream, 3)));

    assert.deepStrictEqual(
      decoded.map((message) => [message.requestId, message.kind.case]),
      [
        [0n, "hello"],
        [7n, "pong"],
      ],
    );
  });
});
