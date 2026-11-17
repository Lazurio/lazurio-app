// End-to-end on Windows: the IT policy of tailnets is read through the system's reg.exe, as a
// packaged app reads it (TailnetPolicy, docs/adr/0008). The test writes its own key under HKCU,
// since only an administrator writes the policy's key under HKLM, and removes it afterwards.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readWindows } from "../src/main/TailnetPolicy.ts";

const POLICY = `[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]`;

const reg = (systemRoot: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(`${systemRoot}\\System32\\reg.exe`, [...args], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* child.exitCode);
  }).pipe(Effect.scoped);

describe("the tailnet policy on Windows", () => {
  it.effect("reads the Tailnets string back, and nothing from a key without it", (context) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") {
        context.skip("reg.exe and the registry exist only on Windows");
      }
      const systemRoot = yield* Config.String("SystemRoot").pipe(Config.withDefault("C:\\Windows"));
      const key = "HKCU\\Software\\LazurioAppE2E\\TailnetPolicy";
      yield* Effect.acquireRelease(
        reg(systemRoot, [
          "add",
          key,
          "/v",
          "Tailnets",
          "/t",
          "REG_SZ",
          "/d",
          POLICY,
          "/f",
          "/reg:64",
        ]),
        () => reg(systemRoot, ["delete", key, "/f", "/reg:64"]).pipe(Effect.ignore),
      );
      assert.deepStrictEqual(yield* readWindows(systemRoot, key), Option.some(POLICY));
      assert.isTrue(Option.isNone(yield* readWindows(systemRoot, `${key}Missing`)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
