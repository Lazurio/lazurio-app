// End-to-end: without the Organization's network (a stable build with no setting), the first page
// outside it, the public Overview and its sign-in for one, loads as usual; the bar over every page
// says that the network is missing, with a button for what to do, and the status column stays
// hidden. A page of the network says it in the page's place as well (network-missing.e2e.test.ts).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the pages.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let overview: string;

beforeAll(async () => {
  // Stands in for the public Overview and its sign-in: pages outside the Organization's network.
  server = NodeHttp.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>${request.url ?? "/"}</title><p>Lazurio</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  overview = `http://127.0.0.1:${address.port}/`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: overview,
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

// The main window as the screen shows it: the bar's height, the status column, the window.
const shown = () =>
  app.evaluate(({ BaseWindow, WebContentsView }) => {
    const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
    const bar = main?.contentView.children.find(
      (child): child is Electron.WebContentsView =>
        child instanceof WebContentsView && child.webContents.getURL().includes("view=agent-bar"),
    );
    return {
      window: main?.isVisible() === true,
      column: main?.contentView.children[0]?.getVisible() === true,
      bar: bar?.getBounds().height ?? 0,
    };
  });

describe("Lazurio App GEN4 without the Organization's network, on a page outside it", () => {
  it("says in the bar over the page that the network is missing, without the status column", async () => {
    const bar = await localPage(app, "view=agent-bar");
    await bar.locator('[data-agent-bar="network"]').waitFor();
    assert.match(
      await bar.locator(".agent-bar__text").innerText(),
      /not set up yet|zatím není nastavená/u,
    );
    assert.deepStrictEqual(await shown(), { window: true, column: false, bar: 36 });
    const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
    if (directory !== undefined && directory !== "") {
      await bar.screenshot({ path: NodePath.join(directory, "network-bar.png") });
    }
  });

  it("keeps saying it after the page moves on, as after a sign-in", async () => {
    const moved = await app.evaluate(async ({ BaseWindow, WebContentsView }, address) => {
      const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      const views = (main?.contentView.children ?? []).filter(
        (child): child is Electron.WebContentsView => child instanceof WebContentsView,
      );
      const loaded = () =>
        views
          .map((view) => view.webContents)
          .find((contents) => contents.getURL().startsWith(address) && !contents.isLoading());
      // The first page has finished loading: a navigation in the middle of it would abort it, and
      // Electron rejects the new load with that abort (-3).
      const page =
        loaded() ??
        (await new Promise<Electron.WebContents>((resolve) => {
          for (const view of views) {
            view.webContents.on("did-stop-loading", () => {
              const found = loaded();
              if (found !== undefined) resolve(found);
            });
          }
        }));
      await page.loadURL(`${address}signed-in`);
      return page.getURL();
    }, overview);
    assert.strictEqual(moved, `${overview}signed-in`);
    const bar = await localPage(app, "view=agent-bar");
    await bar.locator('[data-agent-bar="network"]').waitFor();
    assert.deepStrictEqual(await shown(), { window: true, column: false, bar: 36 });
  });

  it("says what to do in a dialog of the system", async () => {
    // The dialog is the system's: the test records what it would show instead of showing it.
    await app.evaluate(({ dialog }) => {
      const first = Promise.withResolvers<unknown>();
      Reflect.set(globalThis, "lazurioE2eDialog", first.promise);
      const record = async (...args: Array<unknown>) => {
        first.resolve(args.at(-1));
        return { response: 0, checkboxChecked: false };
      };
      Reflect.set(dialog, "showMessageBox", record);
    });
    const bar = await localPage(app, "view=agent-bar");
    await bar.locator('[data-action="network-help"]').click();
    const dialogs = [
      (await app.evaluate(() => Reflect.get(globalThis, "lazurioE2eDialog"))) as {
        readonly message?: string;
        readonly detail?: string;
      },
    ];
    assert.lengthOf(dialogs, 1);
    assert.match(dialogs[0]?.message ?? "", /not set up yet|zatím není nastavená/u);
    assert.match(dialogs[0]?.detail ?? "", /starts again by itself|sama spustí znovu/u);
  });
});
