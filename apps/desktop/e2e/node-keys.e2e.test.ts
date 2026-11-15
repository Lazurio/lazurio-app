// End-to-end: a tailnet whose sealed key does not open shows the person what to do, and a tailnet
// without a key gets one, sealed by the system's keystore (ADR 0003, the review of #10). The app
// keeps its data in a directory of this test (LAZURIO_APP_E2E_USER_DATA).
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test prepares the app's data on disk.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

const UNREADABLE_KEY = new TextEncoder().encode("not a key any keystore sealed");

let userData: string;
let app: ElectronApplication;
let shell: Page;

const tailnet = (name: string) => ({
  tailnet: name,
  controlUrl: "https://headscale.e2e.lazurio.invalid",
  hostname: "e2e-app",
  domains: [`${name}.lazurio.invalid`],
});

beforeAll(async () => {
  userData = temporaryUserData();
  NodeFS.mkdirSync(NodePath.join(userData, "tailnets"), { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(userData, "tailnets", "e2e-key.key"), UNREADABLE_KEY);
  // A key "file" that cannot be read, as a file without permission or on a failing disk.
  NodeFS.mkdirSync(NodePath.join(userData, "tailnets", "e2e-dir.key"));

  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
        import.meta.dirname,
        "fake-tailnet-helper.ts",
      ),
      LAZURIO_APP_DEV_TAILNETS: JSON.stringify([
        tailnet("e2e-key"),
        tailnet("e2e-dir"),
        tailnet("e2e-fresh"),
      ]),
    },
  });
  shell = await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
});

describe("Lazurio App GEN4 node keys", () => {
  it("tells the person which files to delete when a tailnet's key does not open", async () => {
    const stopped = shell.locator(
      '[data-tailnet="e2e-key"][data-state="stopped"][data-reason="key-unreadable"]',
    );
    await stopped.waitFor();
    const reason = (await stopped.locator(".shell__reason").textContent()) ?? "";
    assert.include(reason, NodePath.join(userData, "tailnets", "e2e-key.key"));
    assert.include(reason, NodePath.join(userData, "tailnets", "e2e-key"));
    // The app never replaces a key it cannot open.
    const onDisk = NodeFS.readFileSync(NodePath.join(userData, "tailnets", "e2e-key.key"));
    assert.deepStrictEqual([...onDisk], [...UNREADABLE_KEY]);
  });

  it("advises deleting nothing when a tailnet's key file cannot be read", async () => {
    const stopped = shell.locator(
      '[data-tailnet="e2e-dir"][data-state="stopped"][data-reason="key-inaccessible"]',
    );
    await stopped.waitFor();
    const reason = (await stopped.locator(".shell__reason").textContent()) ?? "";
    assert.include(reason, NodePath.join(userData, "tailnets", "e2e-dir.key"));
    assert.notMatch(reason, /smažte|\bdelete\b(?! nothing)/iu);
    assert.isTrue(
      NodeFS.statSync(NodePath.join(userData, "tailnets", "e2e-dir.key")).isDirectory(),
    );
  });

  it("gives a tailnet without a key a new one, sealed, and starts its node", async () => {
    await shell.locator('[data-tailnet="e2e-fresh"][data-state="needs-login"]').waitFor();
    const keyFile = NodePath.join(userData, "tailnets", "e2e-fresh.key");
    assert.isTrue(NodeFS.existsSync(keyFile));
    assert.isTrue(NodeFS.readFileSync(keyFile).length > 0);
  });
});
