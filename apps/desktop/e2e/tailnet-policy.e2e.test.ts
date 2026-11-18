// End-to-end on Windows: the tailnet helper the app ships reads the IT policy of tailnets
// (HKLM\SOFTWARE\Policies\Lazurio\App, value Tailnets) through the registry's API, as a packaged
// app asks it to (TailnetPolicy, docs/adr/0008), also when the environment names another system
// directory and no path. The runner's account is an administrator, so the test writes the real
// policy and removes it; a computer that already has one is left alone.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test runs the documented file from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the built helper on disk.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readWindows } from "../src/main/TailnetPolicy.ts";

const POLICY = `[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]`;
const LAZURIO_KEY = "HKLM\\SOFTWARE\\Policies\\Lazurio";
const POLICY_KEY = `${LAZURIO_KEY}\\App`;
// The person's own setting of the same shape, which needs no administrator.
const USER_LAZURIO_KEY = "HKCU\\Software\\Lazurio";
const USER_KEY = `${USER_LAZURIO_KEY}\\App`;
const HELPER = NodePath.resolve(
  import.meta.dirname,
  "../../../helpers/tailnet/bin/lazurio-tailnet.exe",
);

const run = (command: string, args: ReadonlyArray<string>, env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      // No input: the documented file's closing pause then ends at once.
      ChildProcess.make(command, [...args], {
        stdin: "ignore",
        stderr: "ignore",
        ...(env === undefined ? {} : { env, extendEnv: false }),
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { output, exitCode };
  }).pipe(Effect.scoped);

describe("the tailnet policy on Windows", () => {
  it.effect(
    "is read by the app's helper through the registry, whatever the environment",
    (context) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "win32") {
          context.skip("the registry exists only on Windows");
        }
        const systemRoot = yield* Config.String("SystemRoot").pipe(
          Config.withDefault("C:\\Windows"),
        );
        const reg = `${systemRoot}\\System32\\reg.exe`;
        if ((yield* run(reg, ["query", LAZURIO_KEY, "/reg:64"])).exitCode === 0) {
          context.skip("this computer already has a Lazurio policy, which the test does not touch");
        }
        yield* Effect.acquireRelease(
          run(reg, [
            "add",
            POLICY_KEY,
            "/v",
            "Tailnets",
            "/t",
            "REG_SZ",
            "/d",
            POLICY,
            "/f",
            "/reg:64",
          ]),
          () => run(reg, ["delete", LAZURIO_KEY, "/f", "/reg:64"]).pipe(Effect.ignore),
        );

        assert.deepStrictEqual(yield* readWindows(HELPER), Option.some(POLICY));
        // An environment that names another system directory and no path changes nothing.
        const forged = yield* run(HELPER, ["read-policy"], {
          SystemRoot: "C:\\Forged",
          windir: "C:\\Forged",
          PATH: "",
        });
        assert.deepStrictEqual(forged, { output: POLICY, exitCode: 0 });

        yield* run(reg, ["delete", POLICY_KEY, "/v", "Tailnets", "/f", "/reg:64"]);
        assert.isTrue(Option.isNone(yield* readWindows(HELPER)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads the person's own setting through the registry with read-user-setting",
    (context) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "win32") {
          context.skip("the registry exists only on Windows");
        }
        const systemRoot = yield* Config.String("SystemRoot").pipe(
          Config.withDefault("C:\\Windows"),
        );
        const reg = `${systemRoot}\\System32\\reg.exe`;
        if ((yield* run(reg, ["query", USER_LAZURIO_KEY])).exitCode === 0) {
          context.skip("this account already has a Lazurio setting, which the test does not touch");
        }
        yield* Effect.acquireRelease(
          run(reg, ["add", USER_KEY, "/v", "Tailnets", "/t", "REG_SZ", "/d", POLICY, "/f"]),
          () => run(reg, ["delete", USER_LAZURIO_KEY, "/f"]).pipe(Effect.ignore),
        );

        assert.deepStrictEqual(yield* readWindows(HELPER, "user"), Option.some(POLICY));
        const forged = yield* run(HELPER, ["read-user-setting"], {
          SystemRoot: "C:\\Forged",
          windir: "C:\\Forged",
          PATH: "",
        });
        assert.deepStrictEqual(forged, { output: POLICY, exitCode: 0 });
        // The machine's policy is another key: the person's setting is no policy.
        if ((yield* run(reg, ["query", LAZURIO_KEY, "/reg:64"])).exitCode !== 0) {
          assert.isTrue(Option.isNone(yield* readWindows(HELPER, "machine")));
        }

        // A value of another type is a failure to read (exit 4), never an absence.
        yield* run(reg, ["add", USER_KEY, "/v", "Tailnets", "/t", "REG_DWORD", "/d", "1", "/f"]);
        assert.strictEqual((yield* run(HELPER, ["read-user-setting"])).exitCode, 4);

        yield* run(reg, ["delete", USER_KEY, "/v", "Tailnets", "/f"]);
        assert.isTrue(Option.isNone(yield* readWindows(HELPER, "user")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The file Lazurio sends a person without an administrator (docs/it/tailnet-policy.md): run as
  // the person, as a double-click runs it, it writes their own HKCU through reg.exe, unelevated.
  it.effect(
    "is written by the documented file, without elevation, exactly as the helper reads it",
    (context) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "win32") {
          context.skip("the registry exists only on Windows");
        }
        const systemRoot = yield* Config.String("SystemRoot").pipe(
          Config.withDefault("C:\\Windows"),
        );
        const reg = `${systemRoot}\\System32\\reg.exe`;
        if ((yield* run(reg, ["query", USER_LAZURIO_KEY])).exitCode === 0) {
          context.skip("this account already has a Lazurio setting, which the test does not touch");
        }
        const template = NodeFS.readFileSync(
          NodePath.resolve(import.meta.dirname, "../../../docs/it/lazurio-app-tailnets.cmd"),
          "utf8",
        );
        const file = NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lazurio-tailnets-")),
          "lazurio-app-tailnets.cmd",
        );
        NodeFS.writeFileSync(
          file,
          template
            .replaceAll("<tailnet>", "org")
            .replaceAll("<control-server>", "headscale.org.lazurio.io")
            .replaceAll("<domain>", "org.lazurio.io"),
        );
        yield* Effect.acquireRelease(
          run(`${systemRoot}\\System32\\cmd.exe`, ["/d", "/c", file]),
          () => run(reg, ["delete", USER_LAZURIO_KEY, "/f"]).pipe(Effect.ignore),
        );
        assert.deepStrictEqual(yield* readWindows(HELPER, "user"), Option.some(POLICY));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
