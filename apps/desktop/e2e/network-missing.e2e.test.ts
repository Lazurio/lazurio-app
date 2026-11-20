// End-to-end: without the Organization's network (a stable build with no setting), a page that
// does not load says that the network is not set up, not only that its host could not be found
// (#81, the first installation by a person on 2026-11-20).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;

beforeAll(async () => {
  // The page never answers, as an Environment without the network.
  server = NodeHttp.createServer((request) => request.socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `http://127.0.0.1:${address.port}/`,
      LAZURIO_APP_E2E_NETWORK_MISSING: "true",
    },
  });
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("Lazurio App GEN4 without the Organization's network", () => {
  it("says that the network is not set up when a page does not load", async () => {
    await app.evaluate(async ({ BaseWindow }) => {
      const cover = BaseWindow.getAllWindows()[0]?.contentView.children[2] as
        | Electron.WebContentsView
        | undefined;
      if (cover === undefined) throw new Error("no cover view");
      while (!cover.getVisible() || !cover.webContents.getURL().includes("problem=network")) {
        await new Promise<void>((resolve) => {
          cover.webContents.once("did-finish-load", () => setImmediate(resolve));
        });
      }
    });
    const page = app.windows().find((window) => window.url().includes("#waiting"));
    if (page === undefined) throw new Error("no cover page");
    await page.waitForURL(/problem=network/u);
    const main = page.locator('main[data-problem="network"]');
    await main.waitFor();
    assert.match(await main.innerText(), /not set up yet|zatím není nastavená/u);
    assert.match(await main.innerText(), /starts again by itself|sama spustí znovu/u);
  });
});
