import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  builtInAllowed,
  fromFile,
  fromText,
  networkMissing,
  nodeHostname,
  refusalOf,
} from "./TailnetDirectory.ts";

const withDirectory = <A, E>(
  text: string,
  run: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const path = (yield* Path.Path).join(directory, "directory.json");
    yield* fileSystem.writeFileString(path, text);
    return yield* run(path);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("nodeHostname", () => {
  it("names the node after the computer, in a form a tailnet takes", () => {
    assert.strictEqual(nodeHostname("DESKTOP-7Q1A"), "lazurio-app-desktop-7q1a");
    assert.strictEqual(nodeHostname("Matěj's MacBook.local"), "lazurio-app-mat-j-s-macbook-local");
    assert.strictEqual(nodeHostname(""), "lazurio-app-device");
    assert.strictEqual(nodeHostname("---"), "lazurio-app-device");
    assert.isAtMost(nodeHostname("x".repeat(200)).length, "lazurio-app-".length + 40);
  });
});

describe("fromFile", () => {
  it.effect("reads the directory's tailnets with this computer's node name", () =>
    withDirectory(
      JSON.stringify([
        {
          tailnet: "example",
          controlUrl: "https://headscale.example.lazurio.io",
          domains: ["example.lazurio.io"],
        },
      ]),
      (path) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* fromFile(path, "Desk"), {
            tailnets: [
              {
                tailnet: "example",
                controlUrl: "https://headscale.example.lazurio.io",
                hostname: "lazurio-app-desk",
                domains: ["example.lazurio.io"],
              },
            ],
            refused: [],
          });
        }),
    ),
  );

  it.effect("refuses a directory that does not decode", () =>
    withDirectory('[{"tailnet":"example"}]', (path) =>
      Effect.gen(function* () {
        assert.isTrue(Exit.isFailure(yield* fromFile(path, "Desk").pipe(Effect.exit)));
      }),
    ),
  );

  it.effect("ships a directory of Lazurio's own tailnet only", () =>
    Effect.gen(function* () {
      const path = (yield* Path.Path).resolve(import.meta.dirname, "../../tailnets/directory.json");
      const { tailnets, refused } = yield* fromFile(path, "Desk");
      assert.deepStrictEqual(
        tailnets.map((tailnet) => tailnet.controlUrl),
        ["https://headscale.lazurioexampleorganization.lazurio.io"],
      );
      assert.deepStrictEqual(refused, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const entry = (controlUrl: string, domains: ReadonlyArray<string>) => ({
  tailnet: "org",
  controlUrl,
  domains,
});

describe("refusalOf", () => {
  it("takes a control server and suffixes below Lazurio's domains", () => {
    assert.isUndefined(refusalOf(entry("https://headscale.org.lazurio.io", ["org.lazurio.io"])));
    assert.isUndefined(refusalOf(entry("https://control.lazurio.ai/", ["org.lazurio.ai."])));
    assert.isUndefined(
      refusalOf(entry("https://headscale.org.lazurio.io", ["xn--org-yva.lazurio.io"])),
    );
  });

  it("refuses what could send a person's names elsewhere", () => {
    const refused: ReadonlyArray<[string, ReadonlyArray<string>]> = [
      ["http://headscale.org.lazurio.io", ["org.lazurio.io"]],
      ["https://headscale.org.example.com", ["org.lazurio.io"]],
      ["https://headscale.org.lazurio.io.example.com", ["org.lazurio.io"]],
      ["https://evil-lazurio.io", ["org.lazurio.io"]],
      ["https://user@headscale.org.lazurio.io", ["org.lazurio.io"]],
      ["https://headscale.org.lazurio.io:8443", ["org.lazurio.io"]],
      ["not an address", ["org.lazurio.io"]],
      ["https://headscale.org.lazurio.io", ["org.example.com"]],
      ["https://headscale.org.lazurio.io", ["lazurio.io"]],
      ["https://headscale.org.lazurio.io", []],
    ];
    for (const [controlUrl, domains] of refused) {
      assert.isString(refusalOf(entry(controlUrl, domains)), `${controlUrl} ${domains.join(",")}`);
    }
  });

  it("refuses a suffix the PAC script cannot carry as it is", () => {
    for (const domain of [
      "ž.lazurio.io",
      "org_x.lazurio.io",
      "-org.lazurio.io",
      "org..lazurio.io",
    ]) {
      assert.isString(refusalOf(entry("https://headscale.org.lazurio.io", [domain])), domain);
    }
  });

  it("takes as a name only one plain path component, since it names the tailnet's files", () => {
    const names = ["", " ", "../../outside", "..", "a/b", "a\\b", "Org", "org.x", "-org", "C:org"];
    const reserved = ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9", "com0"];
    for (const tailnet of [...names, ...reserved, "x".repeat(64)]) {
      assert.isString(
        refusalOf({ tailnet, controlUrl: "https://h.org.lazurio.io", domains: ["org.lazurio.io"] }),
        JSON.stringify(tailnet),
      );
    }
    assert.isUndefined(
      refusalOf({
        tailnet: "console-1",
        controlUrl: "https://h.org.lazurio.io",
        domains: ["org.lazurio.io"],
      }),
    );
  });
});

describe("fromText", () => {
  it.effect("joins the entries it takes and names the ones it refuses", () =>
    Effect.gen(function* () {
      const directory = yield* fromText(
        JSON.stringify([
          entry("https://headscale.org.lazurio.io", ["org.lazurio.io"]),
          {
            tailnet: "other",
            controlUrl: "https://headscale.example.com",
            domains: ["example.com"],
          },
        ]),
        "Desk",
      );
      assert.deepStrictEqual(
        directory.tailnets.map((tailnet) => tailnet.tailnet),
        ["org"],
      );
      assert.deepStrictEqual(directory.refused, [
        {
          tailnet: "other",
          reason: "its control server headscale.example.com is no name below Lazurio's domains",
        },
      ]);
    }),
  );

  it.effect("joins the valid entries of a mixed directory", () =>
    Effect.gen(function* () {
      const directory = yield* fromText(
        JSON.stringify([
          {
            tailnet: "accent",
            controlUrl: "https://headscale.org.lazurio.io",
            domains: ["ž.lazurio.io"],
          },
          entry("https://headscale.org.lazurio.io", ["org.lazurio.io"]),
          {
            tailnet: "../../outside",
            controlUrl: "https://h.x.lazurio.io",
            domains: ["x.lazurio.io"],
          },
          { tailnet: "org", controlUrl: "https://h.y.lazurio.io", domains: ["y.lazurio.io"] },
        ]),
        "Desk",
      );
      assert.deepStrictEqual(
        directory.tailnets.map((tailnet) => tailnet.tailnet),
        ["org"],
      );
      assert.deepStrictEqual(
        directory.refused.map((refused) => refused.tailnet),
        ["accent", "../../outside", "org"],
      );
      assert.strictEqual(directory.refused[2]?.reason, "an earlier entry has the same name");
    }),
  );
});

describe("networkMissing", () => {
  it("says the network is missing without a source of the person's own, or with an empty list", () => {
    // Only the built-in list, on any channel and system: the account's sign-in brings the network.
    assert.isTrue(networkMissing("built-in", 1));
    assert.isTrue(networkMissing("lazurio-auth", 0));
    assert.isFalse(networkMissing("lazurio-auth", 1));
    assert.isFalse(networkMissing("user-setting", 1));
    assert.isFalse(networkMissing("policy", 0));
  });
});

describe("builtInAllowed", () => {
  it("keeps a stable Windows build out of the built-in network, and nothing else", () => {
    assert.isTrue(builtInAllowed("0.1.1-nightly.20261119.20", "win32"));
    assert.isFalse(builtInAllowed("0.1.0", "win32"));
    assert.isFalse(builtInAllowed("0.1.1", "win32"));
    // A Mac (and Linux) has no other source of networks yet, so its stable build keeps it.
    assert.isTrue(builtInAllowed("0.1.1", "darwin"));
    assert.isTrue(builtInAllowed("0.1.1", "linux"));
    assert.isTrue(builtInAllowed("0.1.1-nightly.20261119.20", "darwin"));
  });
});
