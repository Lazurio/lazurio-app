// End-to-end: a tailnet's status changes while the app's main window is still opening, and the
// window shows the change (the review of Lazurio/lazurio-app#3). The test sets the order with
// events, not timers:
//   1. the local window has read its status and follows changes (data-status="live");
//   2. the app has asked for the remote page, whose answer the test holds, so the main window is
//      still opening;
//   3. the test lets the fake tailnet helper report "running" (e2e/fake-tailnet-helper.ts);
//   4. the window must show it while the remote page is still held.
// With a subscription made only after the window has opened, step 4 never happens.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server holds the page and the helper's cue.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its fixture on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";
import { columnPage } from "./local-page.ts";

const page = Promise.withResolvers<void>();
const pageRequested = Promise.withResolvers<void>();
const running = Promise.withResolvers<void>();

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let shell: Page;

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    if (request.url === "/running") {
      void running.promise.then(() => response.end());
      return;
    }
    pageRequested.resolve();
    void page.promise.then(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>held</title><p>held</p>");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  const origin = `http://127.0.0.1:${address.port}`;

  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--show-status"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `${origin}/`,
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
        import.meta.dirname,
        "fake-tailnet-helper.ts",
      ),
      LAZURIO_FAKE_RUNNING_URL: `${origin}/running`,
      LAZURIO_APP_DEV_TAILNETS: JSON.stringify([
        {
          tailnet: "e2e",
          controlUrl: "https://headscale.e2e.lazurio.invalid",
          hostname: "e2e-app",
          domains: ["e2e.lazurio.invalid"],
        },
      ]),
    },
  });
  shell = await columnPage(app);
});

afterAll(async () => {
  page.resolve();
  running.resolve();
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("Lazurio App GEN4 status", () => {
  it("shows a tailnet change that happens while its main window is still opening", async () => {
    const tailnet = shell.locator('[data-tailnet="e2e"]');
    // The status column is hidden by default (#61), so its page is waited for as loaded, not as
    // visible: on Windows a hidden view's elements are not visible.
    await shell.locator('main[data-status="live"]').waitFor({ state: "attached" });
    await pageRequested.promise;
    assert.notStrictEqual(await tailnet.getAttribute("data-state"), "running");

    running.resolve();
    await shell
      .locator('[data-tailnet="e2e"][data-state="running"]')
      .waitFor({ state: "attached", timeout: 10_000 });
    page.resolve();
  });
});
