// End-to-end: the app's status column is hidden by default and the page takes the whole window
// (Matěj, 2026-11-18). View → App status in the window's menu shows it beside the page, the
// column's Hide hides it again, and the menu replaces Electron's English default.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";
import { columnPage } from "./local-page.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;

beforeAll(async () => {
  server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>remote</title><p>remote</p>`);
  });
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
    },
  });
  await columnPage(app);
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// The local column (first view) and the page (second view) as the window lays them out.
const views = () =>
  app.evaluate(({ BaseWindow }) => {
    const children = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
    const local = children[0];
    const page = children[1];
    if (local === undefined || page === undefined) throw new Error("no views");
    return {
      columnVisible: local.getVisible(),
      columnWidth: local.getBounds().width,
      pageX: page.getBounds().x,
    };
  });

// Clicks View → the status item of the window's menu, found by its accelerator.
const clickStatusItem = () =>
  app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []);
    const item = items?.find((candidate) => candidate.accelerator === "CmdOrCtrl+Shift+D");
    if (item === undefined) throw new Error("no status item in the window's menu");
    item.click();
    return item.label;
  });

describe("Lazurio App GEN4's status column", () => {
  it("is hidden at start, and the page takes the whole window", async () => {
    assert.deepStrictEqual(await views(), { columnVisible: false, columnWidth: 0, pageX: 0 });
  });

  it("has a menu of the app's own instead of Electron's English default", async () => {
    const labels = await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label),
    );
    assert.notInclude(labels, "File");
    assert.notInclude(labels, "Window");
    assert.isTrue(labels.includes("View") || labels.includes("Zobrazit"), labels.join(", "));
  });

  it("shows beside the page from View, and hides with its own Hide", async () => {
    const label = await clickStatusItem();
    assert.match(label, /App status|Stav aplikace/u);
    assert.deepStrictEqual(await views(), { columnVisible: true, columnWidth: 360, pageX: 360 });

    const shell = app.windows().find((window) => !window.url().endsWith("#waiting"));
    if (shell === undefined) throw new Error("no local page");
    await shell.locator('[data-action="status-hide"]').click();
    // A request after the click's: the main process answers them in order.
    await shell.evaluate(() => window.lazurio.status());
    assert.deepStrictEqual(await views(), { columnVisible: false, columnWidth: 0, pageX: 0 });
  });
});
