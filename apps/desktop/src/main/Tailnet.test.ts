import { create } from "@bufbuild/protobuf";
import { NodeStateSchema } from "@lazurio/app-contracts/tailnet/v1";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { NodeKeyError } from "./NodeKeys.ts";

import {
  afterEvent,
  afterReply,
  decodeTailnets,
  isSafeLoginUrl,
  pacDataUrl,
  pacScript,
  startingBoard,
  statusOf,
  stoppedForFailure,
  stoppedForKey,
} from "./Tailnet.ts";

// Evaluates a PAC script the way Chromium does, with its one helper this script uses.
const findProxy = (script: string, host: string): string => {
  const dnsDomainIs = (name: string, domain: string) => name.endsWith(domain);
  const evaluate = new Function(
    "dnsDomainIs",
    "url",
    "host",
    `${script}\nreturn FindProxyForURL(url, host);`,
  );
  return evaluate(dnsDomainIs, `https://${host}/`, host) as string;
};

describe("pacScript", () => {
  const script = pacScript(["Example-Org.Lazurio.io.", "other-org.lazurio.io"], {
    host: "127.0.0.1",
    port: 41234,
  });

  it("sends the tailnets' names to the proxy", () => {
    assert.strictEqual(
      findProxy(script, "launchpad.alice.example-org.lazurio.io"),
      "PROXY 127.0.0.1:41234",
    );
    assert.strictEqual(
      findProxy(script, "LAUNCHPAD.BOB.OTHER-ORG.LAZURIO.IO"),
      "PROXY 127.0.0.1:41234",
    );
    assert.strictEqual(findProxy(script, "example-org.lazurio.io"), "PROXY 127.0.0.1:41234");
  });

  it("sends a name with the root's trailing dot to the proxy too", () => {
    assert.strictEqual(
      findProxy(script, "launchpad.alice.example-org.lazurio.io."),
      "PROXY 127.0.0.1:41234",
    );
    assert.strictEqual(findProxy(script, "example-org.lazurio.io.."), "PROXY 127.0.0.1:41234");
  });

  it("sends every other name directly, look-alikes included", () => {
    assert.strictEqual(findProxy(script, "auth.lazurio.ai"), "DIRECT");
    assert.strictEqual(findProxy(script, "evil-example-org.lazurio.io"), "DIRECT");
    assert.strictEqual(findProxy(script, "example-org.lazurio.io.attacker.example"), "DIRECT");
  });

  it("sends everything directly when there is no tailnet", () => {
    assert.strictEqual(
      findProxy(pacScript([], { host: "127.0.0.1", port: 1 }), "launchpad.example-org.lazurio.io"),
      "DIRECT",
    );
  });

  it("travels as a data: URL", () => {
    const url = pacDataUrl(script);
    assert.match(url, /^data:application\/x-ns-proxy-autoconfig;base64,/u);
    assert.strictEqual(atob(url.slice(url.indexOf(",") + 1)), script);
  });
});

describe("statusOf", () => {
  it("reports what the node is doing", () => {
    const state = (value: Parameters<typeof create<typeof NodeStateSchema>>[1]) =>
      statusOf(create(NodeStateSchema, value));
    assert.deepStrictEqual(state({ tailnet: "example", state: { case: "starting", value: {} } }), {
      tailnet: "example",
      state: "starting",
    });
    assert.deepStrictEqual(
      state({
        tailnet: "example",
        state: { case: "needsLogin", value: { loginUrl: "https://x/" } },
      }),
      { tailnet: "example", state: "needs-login" },
    );
    assert.deepStrictEqual(
      state({
        tailnet: "example",
        state: { case: "running", value: { addresses: ["100.64.0.9"] } },
      }),
      { tailnet: "example", state: "running", addresses: ["100.64.0.9"] },
    );
    assert.deepStrictEqual(
      state({ tailnet: "example", state: { case: "stopped", value: { reason: "gone" } } }),
      { tailnet: "example", state: "stopped", problem: "gone" },
    );
  });
});

describe("decodeTailnets", () => {
  it.effect("reads the tailnets of the development setting", () =>
    Effect.gen(function* () {
      const tailnets = yield* decodeTailnets(
        '[{"tailnet":"example","controlUrl":"https://headscale.example-org.lazurio.io","hostname":"alice-app","domains":["example-org.lazurio.io"]}]',
      );
      assert.strictEqual(tailnets[0]?.tailnet, "example");
    }),
  );

  it.effect("refuses a setting without its fields", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(decodeTailnets('[{"tailnet":"example"}]'));
      assert.isTrue(Exit.isFailure(result));
    }),
  );
});

describe("isSafeLoginUrl", () => {
  const control = "https://headscale.example-org.lazurio.io";

  it("opens a sign-in on the tailnet's own control server over HTTPS", () => {
    assert.isTrue(isSafeLoginUrl(`${control}/register/abc`, control));
  });

  it("refuses any other scheme, credentials or host", () => {
    for (const unsafe of [
      "http://headscale.example-org.lazurio.io/register/abc",
      "file:///etc/passwd",
      "lazurio-app://shell/index.html",
      "ms-settings:privacy",
      "javascript:alert(1)",
      "https://user:secret@headscale.example-org.lazurio.io/register/abc",
      "https://evil.example/register/abc",
      "https://headscale.example-org.lazurio.io.evil.example/register/abc",
      "https://headscale.example-org.lazurio.io:8443/register/abc",
      "not an address",
    ]) {
      assert.isFalse(isSafeLoginUrl(unsafe, control), unsafe);
    }
  });
});

describe("the tailnet board", () => {
  const starting = { tailnet: "example", state: "starting" } as const;
  const running = { tailnet: "example", state: "running", addresses: ["100.64.0.9"] } as const;
  const login = { tailnet: "example", state: "needs-login" } as const;
  const failed = { tailnet: "example", state: "stopped", problem: "refused" } as const;

  it("keeps a node's report when the reply to its start comes after it", () => {
    const board = afterReply(afterEvent(startingBoard(["example"]), login), starting);
    assert.deepStrictEqual(board.statuses, [login]);
  });

  it("takes a node's report that comes after the reply", () => {
    const board = afterEvent(afterReply(startingBoard(["example"]), starting), running);
    assert.deepStrictEqual(board.statuses, [running]);
  });

  it("always takes a failed start", () => {
    const board = afterReply(afterEvent(startingBoard(["example"]), login), failed);
    assert.deepStrictEqual(board.statuses, [failed]);
  });
});

describe("a stopped tailnet's reason", () => {
  const recovery = {
    keyFile: "/data/tailnets/example.key",
    stateDirectory: "/data/tailnets/example",
  };

  it("names no keystore, and an unreadable key with the files that start the node afresh", () => {
    assert.deepStrictEqual(
      stoppedForKey("example", new NodeKeyError({ reason: "no-keystore", problem: "p" }), recovery),
      { tailnet: "example", state: "stopped", problem: "p", reason: "no-keystore" },
    );
    assert.deepStrictEqual(
      stoppedForKey(
        "example",
        new NodeKeyError({ reason: "key-unreadable", problem: "q" }),
        recovery,
      ),
      { tailnet: "example", state: "stopped", problem: "q", reason: "key-unreadable", recovery },
    );
    assert.deepStrictEqual(
      stoppedForKey(
        "example",
        new NodeKeyError({ reason: "key-not-saved", problem: "r" }),
        recovery,
      ),
      { tailnet: "example", state: "stopped", problem: "r" },
    );
  });

  it("names a sealed state that its key does not open, from the helper's code", () => {
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "state_unreadable", message: "m" }, recovery),
      { tailnet: "example", state: "stopped", problem: "m", reason: "state-unreadable", recovery },
    );
    assert.deepStrictEqual(
      stoppedForFailure("example", { code: "start_node_failed", message: "n" }, recovery),
      { tailnet: "example", state: "stopped", problem: "n" },
    );
  });
});
