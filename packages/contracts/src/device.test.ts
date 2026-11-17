import { create } from "@bufbuild/protobuf";
import { assert, describe, it } from "@effect/vitest";

import { decodeFrames, encodeFrame } from "./framing.ts";
import { AppMessageSchema, HelperMessageSchema } from "./gen/lazurio/app/helper/v1/helper_pb.ts";

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const collect = async <T>(iterator: AsyncIterable<T>): Promise<Array<T>> => {
  const items: Array<T> = [];
  for await (const item of iterator) items.push(item);
  return items;
};

// The Device helper's work travels in the helper envelope from field 20 on (ADR 0006, point 2).
describe("device protocol", () => {
  it("carries the Device's requests in the app's envelope", async () => {
    const start = create(AppMessageSchema, {
      requestId: 3n,
      kind: {
        case: "startChannel",
        value: {
          environmentId: "env-a",
          environmentLabel: "Environment A",
          attachUrl: "wss://launchpad.example.lazurio.io/.lazurio/computers/attach",
          handOver: new TextEncoder().encode("hX7qR2mK9vT4wL1pZ8nB3cF6yJ0sD5gA2eU7iO4kQ9r"),
          proxy: { host: "127.0.0.1", port: 41_000, username: "u", password: "p" },
        },
      },
    });

    const [decoded] = await collect(
      decodeFrames(AppMessageSchema, once(encodeFrame(AppMessageSchema, start))),
    );

    assert.strictEqual(decoded?.kind.case, "startChannel");
    if (decoded?.kind.case !== "startChannel") return;
    assert.strictEqual(decoded.kind.value.handOver.length, 43);
    assert.strictEqual(decoded.kind.value.proxy?.host, "127.0.0.1");
  });

  it("carries the helper's channel and lock states in its envelope", async () => {
    const working = create(HelperMessageSchema, {
      requestId: 0n,
      kind: {
        case: "channelState",
        value: {
          environmentId: "env-a",
          state: { case: "working", value: { tool: "desktop_click", application: "Outlook" } },
        },
      },
    });
    const lock = create(HelperMessageSchema, {
      requestId: 4n,
      kind: { case: "lockState", value: { idle: true, updateHold: true } },
    });
    const stream = new Uint8Array([
      ...encodeFrame(HelperMessageSchema, working),
      ...encodeFrame(HelperMessageSchema, lock),
    ]);

    const decoded = await collect(decodeFrames(HelperMessageSchema, once(stream)));

    assert.deepStrictEqual(
      decoded.map((message) => message.kind.case),
      ["channelState", "lockState"],
    );
    const [first] = decoded;
    if (first?.kind.case !== "channelState") return assert.fail("expected a channel state");
    assert.strictEqual(first.kind.value.state.case, "working");
  });
});
