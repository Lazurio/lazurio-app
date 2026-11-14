// End-to-end tests only (main.ts, LAZURIO_APP_E2E_TAILNET_HELPER): the helper protocol of
// lazurio-tailnet without a tsnet node. A started node needs a sign-in at once, and runs only
// once a GET of LAZURIO_FAKE_RUNNING_URL answers, so the test decides when that happens.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import { AppMessageSchema, HelperMessageSchema } from "@lazurio/app-contracts/helper/v1";

const runningUrl = process.env["LAZURIO_FAKE_RUNNING_URL"];

const send = (message: MessageInitShape<typeof HelperMessageSchema>) => {
  process.stdout.write(encodeFrame(HelperMessageSchema, create(HelperMessageSchema, message)));
};

const reportRunningWhenTold = async (tailnet: string) => {
  if (runningUrl === undefined) return;
  // @effect-diagnostics-next-line globalFetch:off - A fixture outside Effect, as small as it can be.
  const answer = await fetch(runningUrl);
  if (!answer.ok) throw new Error(`the test's control answered ${answer.status}`);
  send({
    requestId: 0n,
    kind: {
      case: "nodeState",
      value: { tailnet, state: { case: "running", value: { addresses: ["100.64.0.99"] } } },
    },
  });
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
      // A failure here ends the helper, and the test sees no "running".
      reportRunningWhenTold(tailnet).catch((error: unknown) => {
        process.stderr.write(`fake-tailnet-helper: ${String(error)}\n`);
        process.exit(1);
      });
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
