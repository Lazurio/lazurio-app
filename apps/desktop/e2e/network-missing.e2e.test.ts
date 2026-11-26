// End-to-end: without the Organization's network (a stable build with no setting), a page of the
// Organization's network that does not load says that the network is not set up (#81), while any
// other page that does not load, the public Dashboard's for one, keeps its own reason (review of
// #84). The status column stays hidden. Nothing serves launchpad.e2e.lazurio.io, so its name does not resolve.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the other page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

const ENVIRONMENT = "https://launchpad.e2e.lazurio.io/";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let other: string;

beforeAll(async () => {
  // A page outside the Organization's network that never answers.
  server = NodeHttp.createServer((request) => request.socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  other = `http://127.0.0.1:${address.port}/`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: ENVIRONMENT,
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

// The app's page in the page's place once it says the problem, and its text.
const problemShown = async (kind: string) => {
  await app.evaluate(async ({ BaseWindow }, wanted) => {
    const cover = BaseWindow.getAllWindows()[0]?.contentView.children[2] as
      | Electron.WebContentsView
      | undefined;
    if (cover === undefined) throw new Error("no cover view");
    while (!cover.getVisible() || !cover.webContents.getURL().includes(`problem=${wanted}`)) {
      await new Promise<void>((resolve) => {
        cover.webContents.once("did-finish-load", () => setImmediate(resolve));
      });
    }
  }, kind);
  const page = app.windows().find((window) => window.url().includes("#waiting"));
  if (page === undefined) throw new Error("no cover page");
  await page.waitForURL(new RegExp(`problem=${kind}`, "u"));
  const main = page.locator(`main[data-problem="${kind}"]`);
  await main.waitFor();
  return main.innerText();
};

describe("Lazurio App GEN4 without the Organization's network", () => {
  it("says that the network is not set up when an Environment does not load", async () => {
    const text = await problemShown("network");
    assert.match(text, /not set up yet|zatím není nastavená/u);
    assert.match(text, /starts again by itself|sama se spustí znovu/u);
    // It says it in the window's page, not by opening the status column.
    const shown = await app.evaluate(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows()[0];
      return {
        window: window?.isVisible() === true,
        column: window?.contentView.children[0]?.getVisible() === true,
      };
    });
    assert.deepStrictEqual(shown, { window: true, column: false });
  });

  it("keeps the own reason of a page outside the Organization's network", async () => {
    await app.evaluate(({ BaseWindow }, address) => {
      const remote = BaseWindow.getAllWindows()[0]?.contentView.children[1] as
        | Electron.WebContentsView
        | undefined;
      void remote?.webContents.loadURL(address).catch(() => undefined);
    }, other);
    const text = await problemShown("failed");
    assert.notMatch(text, /not set up yet|zatím není nastavená/u);
  });
});
