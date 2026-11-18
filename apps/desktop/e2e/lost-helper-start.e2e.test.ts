// End-to-end: a Device helper lost at the app's start, right after it is ready and without
// DeviceStopped, so nothing confirms that its engines ended. Even at a hidden start (--hidden,
// as at the sign-in to Windows) the window and its status column show, with the warning and no
// Stop (docs/adr/0006).
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
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
    args: [NodePath.resolve(import.meta.dirname, ".."), "--hidden"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: "data:text/html,<title>remote</title><p>remote</p>",
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_DEVICE_HELPER: NodePath.resolve(
        import.meta.dirname,
        "..",
        "src",
        "main",
        "fake-device-helper.ts",
      ),
      LAZURIO_FAKE_DEVICE_EXIT_AFTER_READY: "true",
    },
  });
  shell = await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
});

describe("Lazurio App with a Device helper lost at its start", () => {
  it("shows its window and status column with the warning, also after --hidden", async () => {
    await shell.locator('[data-device-state="lost"] [data-device-problem="lost"]').waitFor({
      state: "attached",
    });
    // A request after the state's change: the main process answers in order.
    await shell.evaluate(() => window.lazurio.status());
    const inView = await app.evaluate(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows()[0];
      const local = window?.contentView.children[0];
      return { window: window?.isVisible() === true, column: local?.getVisible() === true };
    });
    assert.deepStrictEqual(inView, { window: true, column: true });
    assert.strictEqual(await shell.locator('[data-action="device-stop"]').count(), 0);
  });
});
