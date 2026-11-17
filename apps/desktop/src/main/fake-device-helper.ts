// Tests only (Helpers.test.ts runs it through Node, by path): the handshake of the helper protocol
// as lazurio-device speaks it, and its last message after Shutdown. Its argument says what it does
// then: "stop" sends DeviceStopped and exits, as the real helper does; "linger" sends
// DeviceStopped and never exits, so its end is not confirmed in time.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import { AppMessageSchema, HelperMessageSchema } from "@lazurio/app-contracts/helper/v1";

const afterShutdown = process.argv[2] ?? "stop";

const send = (message: MessageInitShape<typeof HelperMessageSchema>) => {
  process.stdout.write(encodeFrame(HelperMessageSchema, create(HelperMessageSchema, message)));
};

const stopped = () => {
  send({ requestId: 0n, kind: { case: "deviceStopped", value: { allEnginesEnded: true } } });
  if (afterShutdown === "linger") {
    // Keeps the process alive until the test's scope ends it by its PID.
    // @effect-diagnostics-next-line globalTimers:off - A fixture outside Effect, as small as it can be.
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
};

send({
  requestId: 0n,
  kind: {
    case: "hello",
    value: { protocolVersion: 1, helperName: "lazurio-device", helperVersion: "0.0.0-test" },
  },
});

for await (const message of decodeFrames(AppMessageSchema, process.stdin)) {
  if (message.kind.case === "ping") {
    send({
      requestId: message.requestId,
      kind: { case: "pong", value: { nonce: message.kind.value.nonce } },
    });
  } else if (message.kind.case === "shutdown") {
    stopped();
    break;
  }
}
