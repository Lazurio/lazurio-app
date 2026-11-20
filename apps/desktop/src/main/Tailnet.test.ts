import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeStateSchema, ProxyEndpointSchema } from "@lazurio/app-contracts/tailnet/v1";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  afterEvent,
  afterReply,
  decodeTailnets,
  isSafeLoginUrl,
  keptSignIns,
  pacDataUrl,
  pacScript,
  proxyForHost,
  servingTailnet,
  signInsAfter,
  startingBoard,
  statusOf,
  withSignIns,
} from "./Tailnet.ts";
import { fromText } from "./TailnetDirectory.ts";

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
      { tailnet: "example", state: "needs-login", canCopySignIn: false },
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

describe("the sign-in addresses", () => {
  const control = "https://headscale.example-org.lazurio.io";
  const address = `${control}/register/abc`;
  const report = (init: MessageInitShape<typeof NodeStateSchema>) =>
    create(NodeStateSchema, { tailnet: "example", ...init });
  const waiting = signInsAfter(
    new Map(),
    report({ state: { case: "needsLogin", value: { loginUrl: address } } }),
    control,
  );

  it("keeps the address while the node waits for sign-in", () => {
    assert.strictEqual(waiting.get("example"), address);
    assert.deepStrictEqual(
      withSignIns([{ tailnet: "example", state: "needs-login", canCopySignIn: false }], waiting),
      [{ tailnet: "example", state: "needs-login", canCopySignIn: true }],
    );
  });

  it("drops it once the node runs, stops or starts again", () => {
    for (const next of [
      report({ state: { case: "running", value: { addresses: ["100.64.0.9"] } } }),
      report({ state: { case: "stopped", value: { reason: "gone" } } }),
      report({ state: { case: "starting", value: {} } }),
    ]) {
      assert.isFalse(signInsAfter(waiting, next, control).has("example"), next.state.case);
    }
  });

  it("drops it when the board no longer waits for sign-in, as after a failed start", () => {
    assert.isFalse(
      keptSignIns(waiting, [{ tailnet: "example", state: "stopped", problem: "refused" }]).has(
        "example",
      ),
    );
    assert.isTrue(
      keptSignIns(waiting, [{ tailnet: "example", state: "needs-login", canCopySignIn: true }]).has(
        "example",
      ),
    );
  });

  it("keeps no address outside the tailnet's control server, nor an earlier one after it", () => {
    for (const unsafe of [
      "https://evil.example/register/abc",
      "http://headscale.example-org.lazurio.io/register/abc",
    ]) {
      const next = signInsAfter(
        waiting,
        report({ state: { case: "needsLogin", value: { loginUrl: unsafe } } }),
        control,
      );
      assert.isFalse(next.has("example"), unsafe);
      assert.deepStrictEqual(
        withSignIns([{ tailnet: "example", state: "needs-login", canCopySignIn: false }], next),
        [{ tailnet: "example", state: "needs-login", canCopySignIn: false }],
      );
    }
  });
});

describe("the tailnet board", () => {
  const starting = { tailnet: "example", state: "starting" } as const;
  const running = { tailnet: "example", state: "running", addresses: ["100.64.0.9"] } as const;
  const login = { tailnet: "example", state: "needs-login", canCopySignIn: false } as const;
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

describe("servingTailnet", () => {
  const tailnets = [
    {
      tailnet: "example-org",
      controlUrl: "https://headscale.example-org.lazurio.io",
      hostname: "app",
      domains: ["example-org.lazurio.io"],
    },
    {
      tailnet: "personal",
      controlUrl: "https://headscale.personal.lazurio.io",
      hostname: "app",
      domains: [".Alice.Personal.Lazurio.io."],
    },
  ];

  it("names the tailnet whose domains serve the address, as the PAC script routes it", () => {
    assert.strictEqual(
      servingTailnet(tailnets, "https://launchpad.bob.example-org.lazurio.io/"),
      "example-org",
    );
    assert.strictEqual(servingTailnet(tailnets, "https://example-org.lazurio.io/"), "example-org");
    assert.strictEqual(
      servingTailnet(tailnets, "https://notes.alice.personal.lazurio.io./x"),
      "personal",
    );
    assert.strictEqual(
      servingTailnet(tailnets, "https://LAUNCHPAD.ALICE.PERSONAL.LAZURIO.IO/"),
      "personal",
    );
  });

  it("names none for other names, look-alikes and what is not an address", () => {
    assert.isUndefined(servingTailnet(tailnets, "https://dashboard.lazurio.ai/"));
    assert.isUndefined(servingTailnet(tailnets, "https://evil-example-org.lazurio.io/"));
    assert.isUndefined(
      servingTailnet(tailnets, "https://example-org.lazurio.io.attacker.example/"),
    );
    assert.isUndefined(servingTailnet(tailnets, "not an address"));
    assert.isUndefined(servingTailnet([], "https://launchpad.bob.example-org.lazurio.io/"));
  });
});

describe("the PAC script of a directory", () => {
  it.effect("builds for what a mixed directory joins, a suffix outside ASCII among them", () =>
    Effect.gen(function* () {
      const directory = yield* fromText(
        JSON.stringify([
          {
            tailnet: "accent",
            controlUrl: "https://headscale.org.lazurio.io",
            domains: ["ž.lazurio.io"],
          },
          {
            tailnet: "org",
            controlUrl: "https://headscale.org.lazurio.io",
            domains: ["org.lazurio.io"],
          },
        ]),
        "Desk",
      );
      const domains = directory.tailnets.flatMap((tailnet) => tailnet.domains);
      const url = pacDataUrl(pacScript(domains, { host: "127.0.0.1", port: 1 }));
      assert.isTrue(url.startsWith("data:application/x-ns-proxy-autoconfig;base64,"));
      assert.deepStrictEqual(domains, ["org.lazurio.io"]);
    }),
  );
});

describe("proxyForHost", () => {
  const tailnets = [
    {
      tailnet: "example-org",
      controlUrl: "https://headscale.example-org.lazurio.io",
      hostname: "app",
      domains: ["example-org.lazurio.io"],
    },
  ];
  const proxy = create(ProxyEndpointSchema, {
    host: "127.0.0.1",
    port: 41234,
    username: "u",
    password: "p",
  });

  it("gives the helper's proxy for a host in a tailnet's domains", () => {
    assert.deepStrictEqual(
      proxyForHost(tailnets, proxy, "launchpad.bob.example-org.lazurio.io"),
      Option.some(proxy),
    );
    assert.deepStrictEqual(
      proxyForHost(tailnets, proxy, "Launchpad.Bob.Example-Org.Lazurio.io."),
      Option.some(proxy),
    );
  });

  it("gives none for a host outside every tailnet, a look-alike or what is no host", () => {
    for (const host of [
      "dashboard.lazurio.ai",
      "evil-example-org.lazurio.io",
      "example-org.lazurio.io.attacker.example",
      "user@launchpad.bob.example-org.lazurio.io",
      "attacker.example/launchpad.bob.example-org.lazurio.io",
      "launchpad.bob.example-org.lazurio.io:8443",
      "",
    ]) {
      assert.deepStrictEqual(proxyForHost(tailnets, proxy, host), Option.none(), host);
    }
    assert.deepStrictEqual(
      proxyForHost([], proxy, "launchpad.bob.example-org.lazurio.io"),
      Option.none(),
    );
  });
});
