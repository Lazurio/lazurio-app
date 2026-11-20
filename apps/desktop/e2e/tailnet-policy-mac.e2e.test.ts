// End-to-end on a Mac: the app reads the network of an Organization the way a packaged app does
// (TailnetPolicy.readMac, #36 2026-11-20), through the system's own programs. The person's own
// setting is written by the documented `.command` file as the runner's account; IT's policy is a
// managed preference, which the test writes with sudo where the runner allows it. An account or
// computer that already has a Lazurio setting is left alone.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test runs the documented files from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the documented files.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { macSystem, readMac } from "../src/main/TailnetPolicy.ts";

const POLICY = `[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]`;
const ACCOUNT = NodeOS.userInfo().username;
const MANAGED = "/Library/Managed Preferences";
const COMPUTER_POLICY = `${MANAGED}/io.lazurio.app.plist`;
const docs = (name: string) => NodePath.resolve(import.meta.dirname, "../../../docs/it", name);
const run = macSystem.run;
const temporaryFile = (name: string, text: string) => {
  const file = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lazurio-tailnets-")),
    name,
  );
  NodeFS.writeFileSync(file, text);
  return file;
};

describe("the tailnet setting on a Mac", () => {
  it.effect(
    "is written by the documented .command file without an administrator, and read back",
    (context) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "darwin") {
          context.skip("defaults and managed preferences exist only on a Mac");
        }
        if (
          (yield* run("/usr/bin/defaults", ["read", "io.lazurio.app", "Tailnets"])).exitCode === 0
        ) {
          context.skip("this account already has a Lazurio setting, which the test does not touch");
        }
        const file = temporaryFile(
          "lazurio-app-tailnets.command",
          NodeFS.readFileSync(docs("lazurio-app-tailnets.command"), "utf8")
            .replaceAll("<tailnet>", "org")
            .replaceAll("<control-server>", "headscale.org.lazurio.io")
            .replaceAll("<domain>", "org.lazurio.io"),
        );
        const written = yield* Effect.acquireRelease(run("/bin/sh", [file]), () =>
          run("/usr/bin/defaults", ["delete", "io.lazurio.app", "Tailnets"]).pipe(Effect.ignore),
        );
        assert.deepStrictEqual(written, {
          output: "Done. The network setting is saved for this Mac account.\n",
          exitCode: 0,
        });
        assert.deepStrictEqual(yield* readMac(macSystem, ACCOUNT, "user"), Option.some(POLICY));

        yield* run("/usr/bin/defaults", ["delete", "io.lazurio.app", "Tailnets"]);
        assert.isTrue(Option.isNone(yield* readMac(macSystem, ACCOUNT, "user")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads IT's managed preference, which only an administrator writes", (context) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") {
        context.skip("defaults and managed preferences exist only on a Mac");
      }
      if ((yield* run("/usr/bin/sudo", ["-n", "/usr/bin/true"])).exitCode !== 0) {
        context.skip("this account has no sudo without a password");
      }
      if (NodeFS.existsSync(COMPUTER_POLICY)) {
        context.skip("this computer already has a Lazurio policy, which the test does not touch");
      }
      const madeFolder = !NodeFS.existsSync(MANAGED);
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          if (madeFolder) yield* run("/usr/bin/sudo", ["-n", "/bin/mkdir", MANAGED]);
          // The managed preference file, written directly, so no preferences cache is between.
          const plist = temporaryFile(
            "io.lazurio.app.plist",
            `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Tailnets</key><string>${POLICY}</string></dict></plist>
`,
          );
          return yield* run("/usr/bin/sudo", ["-n", "/bin/cp", plist, COMPUTER_POLICY]);
        }),
        () =>
          Effect.gen(function* () {
            yield* run("/usr/bin/sudo", ["-n", "/bin/rm", "-f", COMPUTER_POLICY]);
            if (madeFolder) yield* run("/usr/bin/sudo", ["-n", "/bin/rmdir", MANAGED]);
          }).pipe(Effect.ignore),
      );
      assert.deepStrictEqual(yield* readMac(macSystem, ACCOUNT, "machine"), Option.some(POLICY));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
