// End-to-end tests only (main.ts, LAZURIO_APP_E2E_TAILNET_HELPER): lazurio-tailnet's protocol without
// tsnet. A node needs a sign-in at once and runs once a GET of LAZURIO_FAKE_RUNNING_URL answers.
// With LAZURIO_FAKE_UPSTREAM its proxy tunnels every CONNECT there, as the real one does.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The fake proxy is a plain HTTP server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import { AppMessageSchema, HelperMessageSchema } from "@lazurio/app-contracts/helper/v1";

const runningUrl = process.env["LAZURIO_FAKE_RUNNING_URL"];
const upstream = process.env["LAZURIO_FAKE_UPSTREAM"];
// LAZURIO_FAKE_FAIL_FIRST_CONNECT: the first tunnel fails as one to a node that cannot reach
// its peer yet.
let failNextConnect = process.env["LAZURIO_FAKE_FAIL_FIRST_CONNECT"] === "true";
const CREDENTIALS = `Basic ${btoa("e2e:e2e")}`;

// The proxy asks for its credentials as the real one does, then tunnels to the upstream.
const startProxy = async (target: string): Promise<number> => {
  const [host = "", port = ""] = target.split(":");
  const proxy = NodeHttp.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  proxy.on("connect", (request: NodeHttp.IncomingMessage, client: NodeNet.Socket) => {
    if (request.headers["proxy-authorization"] !== CREDENTIALS) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Lazurio App"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (failNextConnect) {
      failNextConnect = false;
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const tunnel = NodeNet.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    tunnel.on("error", () => client.destroy());
    client.on("error", () => tunnel.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  return address !== null && typeof address === "object" ? address.port : 9;
};

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
    value: {
      host: "127.0.0.1",
      port: upstream === undefined ? 9 : await startProxy(upstream),
      username: "e2e",
      password: "e2e",
    },
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

// The app closed its end, as the real helper takes it: the proxy must not keep the process alive.
process.exit(0);
