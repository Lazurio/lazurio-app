import { create } from "@bufbuild/protobuf";
import { NodeStateSchema } from "@lazurio/app-contracts/tailnet/v1";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeTailnets, pacDataUrl, pacScript, statusOf } from "./Tailnet.ts";

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
