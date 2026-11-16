// End-to-end: the local window shows the updater's state and lets the person pick the channel
// (docs/adr/0005, point 4). An unpackaged app does not update itself and says so; a switch to
// nightly reaches the main process, which keeps it in <userData>/updates.json and sends the new
// status back. The test waits for the window's attributes, never for time.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test reads the app's settings file on disk.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its data on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

let userData: string;
let app: ElectronApplication;
let shell: Page;

beforeAll(async () => {
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: userData },
  });
  shell = await app.firstWindow();
  await shell.locator('main[data-status="live"]').waitFor();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
});

describe("Lazurio App GEN4 updates", () => {
  // A directory where updates.json belongs makes the save fail; the window says so and the
  // person can try again once it is gone.
  it("says when the channel could not be saved, and lets the person try again", async () => {
    const settings = NodePath.join(userData, "updates.json");
    NodeFS.mkdirSync(settings);
    await shell.locator('input[name="update-channel"][value="nightly"]').click();
    await shell.locator('[data-updates-problem="channel-not-saved"]').waitFor();
    await shell.locator("fieldset.shell__channel:not([disabled])").waitFor();
    const section = shell.locator("section[data-updates-phase]");
    assert.strictEqual(await section.getAttribute("data-updates-channel"), "latest");
    NodeFS.rmdirSync(settings);
    await shell.locator('input[name="update-channel"][value="nightly"]').click();
    await shell.locator('section[data-updates-channel="nightly"]').waitFor();
    assert.strictEqual(
      await shell.locator('[data-updates-problem="channel-not-saved"]').count(),
      0,
    );
    await shell.locator('input[name="update-channel"][value="latest"]').click();
    await shell.locator('section[data-updates-channel="latest"]').waitFor();
  });

  it("says that an unpackaged app does not update itself, and starts on stable", async () => {
    const section = shell.locator("section[data-updates-phase]");
    await section.waitFor();
    assert.strictEqual(await section.getAttribute("data-updates-phase"), "off");
    assert.strictEqual(await section.getAttribute("data-updates-reason"), "unpackaged");
    assert.strictEqual(await section.getAttribute("data-updates-channel"), "latest");
    assert.strictEqual(await shell.locator('[data-action="install"]').count(), 0);
  });

  // The radio follows the main process's status, so the click shows only once the main process
  // has kept the choice and sent the new status.
  it("keeps the channel the person picks", async () => {
    await shell.locator('input[name="update-channel"][value="nightly"]').click();
    await shell.locator('section[data-updates-channel="nightly"]').waitFor();
    const saved = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userData, "updates.json"), "utf8"),
    ) as unknown;
    assert.deepStrictEqual(saved, { channel: "nightly" });
  });
});
