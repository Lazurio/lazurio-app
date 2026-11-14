// @effect-diagnostics globalTimers:off - A test fixture outside Effect: it reports on a timer.
// A tailnet helper for end-to-end tests only. It speaks the helper protocol as lazurio-tailnet
// does, but runs no tsnet node: after a StartNode it answers "starting", then reports on its own
// that the node needs a sign-in and, after LAZURIO_FAKE_RUNNING_AFTER_MS, that it runs. The app
// starts it only when an end-to-end test names it (main.ts, LAZURIO_APP_E2E_TAILNET_HELPER).
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import { AppMessageSchema, HelperMessageSchema } from "@lazurio/app-contracts/helper/v1";

const runningAfter = Number(process.env["LAZURIO_FAKE_RUNNING_AFTER_MS"] ?? "800");

const send = (message: MessageInitShape<typeof HelperMessageSchema>) => {
  process.stdout.write(encodeFrame(HelperMessageSchema, create(HelperMessageSchema, message)));
};

send({
  requestId: 0n,
  kind: {
    case: "hello",
    value: { protocolVersion: 1, helperName: "lazurio-tailnet", helperVersion: "0.0.0-e2e" },
  },
});
send({
  requestId: 0n,
  kind: {
    case: "proxyEndpoint",
    value: { host: "127.0.0.1", port: 9, username: "e2e", password: "e2e" },
  },
});

for await (const message of decodeFrames(AppMessageSchema, process.stdin)) {
  switch (message.kind.case) {
    case "ping":
      send({
        requestId: message.requestId,
        kind: { case: "pong", value: { nonce: message.kind.value.nonce } },
      });
      break;
    case "shutdown":
      process.exit(0);
      break;
    case "startNode": {
      const { tailnet, controlUrl } = message.kind.value;
      send({
        requestId: message.requestId,
        kind: { case: "nodeState", value: { tailnet, state: { case: "starting", value: {} } } },
      });
      send({
        requestId: 0n,
        kind: {
          case: "nodeState",
          value: {
            tailnet,
            state: { case: "needsLogin", value: { loginUrl: `${controlUrl}/register/e2e` } },
          },
        },
      });
      setTimeout(() => {
        send({
          requestId: 0n,
          kind: {
            case: "nodeState",
            value: { tailnet, state: { case: "running", value: { addresses: ["100.64.0.99"] } } },
          },
        });
      }, runningAfter);
      break;
    }
    case undefined:
      send({
        requestId: message.requestId,
        kind: {
          case: "failure",
          value: { code: "unknown_request", message: "the fake serves no such request" },
        },
      });
      break;
  }
}
