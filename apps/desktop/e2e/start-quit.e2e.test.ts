// End-to-end: a quit that comes while the app starts waits for the app's own quit, which stops the
// helpers (review of #57). The app is a plain process, since its window does not open yet. Its start
// stops at the test's gate (LAZURIO_APP_E2E_START_GATE) right before its quit is ready; a second
// start with --quit asks it to quit there; the gate opens; the app ends with both helpers. The test
// waits for the app's own lines, never for time.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The app runs as a plain process of Electron.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test opens the start's gate on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its data on disk.
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";

import { removeUserData, temporaryUserData } from "./user-data.ts";

const APP_DIRECTORY = NodePath.resolve(import.meta.dirname, "..");
const ELECTRON = NodeModule.createRequire(import.meta.url)("electron") as string;
const SANDBOX = process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true" ? [] : ["--no-sandbox"];

const userData = temporaryUserData();
const gate = NodePath.join(userData, "start-gate");

interface Started {
  readonly child: NodeChildProcess.ChildProcess;
  readonly output: Array<string>;
  readonly exit: Promise<number | null>;
}

const start = (args: ReadonlyArray<string>): Started => {
  const output: Array<string> = [];
  const child = NodeChildProcess.spawn(ELECTRON, [APP_DIRECTORY, ...SANDBOX, ...args], {
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_START_GATE: gate,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, output, exit };
};

// Resolves with the app's output once it has written the line, including earlier output.
const outputLine = (started: Started, line: string): Promise<string> =>
  new Promise((resolve) => {
    const check = () => {
      const written = started.output.join("");
      if (!written.includes(line)) return;
      started.child.stdout?.off("data", check);
      resolve(written);
    };
    started.child.stdout?.on("data", check);
    check();
  });

// Signal 0 checks that the process exists and ends nothing.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let first: Started | undefined;

afterAll(async () => {
  // Opens the gate of a start a failed test left waiting, so the app can quit its own way.
  NodeFS.writeFileSync(gate, "");
  if (first !== undefined && first.child.exitCode === null) {
    first.child.kill("SIGTERM");
    await first.exit;
  }
  removeUserData(userData);
});

describe("Lazurio App quit while it starts", () => {
  it("holds a --quit until its own quit is ready, then stops the helpers and ends", async () => {
    first = start([]);
    const gated = await outputLine(first, "lazurio-app-e2e start-gated");
    const pids = [...gated.matchAll(/lazurio-app-e2e helper \S+ (\d+)/gu)].map((match) =>
      Number(match[1]),
    );
    assert.lengthOf(pids, 2);
    for (const pid of pids) assert.isTrue(isAlive(pid));

    const second = start(["--quit"]);
    assert.strictEqual(await second.exit, 0);
    await outputLine(first, "lazurio-app-e2e quit-held");
    // Held: the app and its helpers still run.
    assert.isNull(first.child.exitCode);
    for (const pid of pids) assert.isTrue(isAlive(pid));

    NodeFS.writeFileSync(gate, "");
    assert.strictEqual(await first.exit, 0);
    for (const pid of pids) assert.isFalse(isAlive(pid));
  });
});
