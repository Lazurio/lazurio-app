// End-to-end: a tailnet's status changes while the app's window is still starting, and the window
// shows the change (the review of Lazurio/lazurio-app#3). The fake tailnet helper reports "running"
// 800 ms after its node starts, while the slow remote page keeps the window's start busy for 2.5 s.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the slow page's host.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its fixture on disk.
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

const SLOW_PAGE_MS = 2500;

let server: NodeHttp.Server;
let app: ElectronApplication;
let shell: Page;

beforeAll(async () => {
  server = NodeHttp.createServer((_request, response) => {
    // @effect-diagnostics-next-line globalTimers:off - The page answers late on purpose.
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>slow</title><p>slow</p>");
    }, SLOW_PAGE_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");

  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_REMOTE_URL: `http://127.0.0.1:${address.port}/`,
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
        import.meta.dirname,
        "fake-tailnet-helper.ts",
      ),
      LAZURIO_FAKE_RUNNING_AFTER_MS: "800",
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
  shell = await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("Lazurio App GEN4 status", () => {
  it("shows a tailnet change that happens while its window is still starting", async () => {
    await shell.locator('[data-tailnet="e2e"][data-state="running"]').waitFor({ timeout: 10_000 });
  });
});
