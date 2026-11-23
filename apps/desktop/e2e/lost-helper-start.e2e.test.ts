// End-to-end: a Device helper lost at the app's start, right after it is ready and without
// DeviceStopped, so nothing confirms that its engines ended. Even at a hidden start (--hidden,
// as at the sign-in to Windows) the window shows, and the Agent Desktop window with the warning
// and no Stop (docs/adr/0006); the status column, a surface for support, stays hidden.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";
import { columnPage, localPage } from "./local-page.ts";

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
  shell = await columnPage(app);
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
});

describe("Lazurio App with a Device helper lost at its start", () => {
  it("shows its window and the Agent Desktop window with the warning, also after --hidden", async () => {
    const panel = await localPage(app, "view=agent-desktop");
    await panel.locator('[data-device-state="lost"]').waitFor();
    // A request after the state's change: the main process answers in order.
    await shell.evaluate(() => window.lazurio.status());
    // The helper may be lost before the main window exists; the window shows once its page loaded.
    const inView = await app.evaluate(async ({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      if (window === undefined) return null;
      if (!window.isVisible())
        await new Promise<void>((resolve) => window.once("show", () => resolve()));
      const local = window.contentView.children[0];
      return { window: window.isVisible(), column: local?.getVisible() === true };
    });
    assert.deepStrictEqual(inView, { window: true, column: false });
    assert.strictEqual(await panel.locator('[data-action="device-stop"]').count(), 0);
  });
});
