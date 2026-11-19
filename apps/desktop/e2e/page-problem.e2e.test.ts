// End-to-end: the window's page never stays blank (Lazurio/lazurio-app#36). A first page refused
// a redirect and a failed load put the app's page with the reason and Retry in the page's place;
// Retry loads the page again, and Copy status names the outcome by its code.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
// What the page's server does: send the first load elsewhere, outside Lazurio; then close the
// connection without an answer; then answer.
let serves: "elsewhere" | "nothing" | "page" = "elsewhere";

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    if (serves === "elsewhere") {
      response.writeHead(302, { location: "https://example.com/elsewhere" });
      response.end();
      return;
    }
    if (serves === "nothing") {
      request.socket.destroy();
      return;
    }
    response.writeHead(request.url === "/favicon.ico" ? 404 : 200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>remote</title><p>remote</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  const remoteUrl = `http://127.0.0.1:${address.port}/`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: remoteUrl,
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

// The remote view (second) and the app's page in its place (third), once the window shows the
// expected one: read again after each load of either view, which is when it changes.
const viewsOnceShowing = (expected: "cover" | "page") =>
  app.evaluate(async ({ BaseWindow }, want) => {
    const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
    const remote = views[1] as Electron.WebContentsView | undefined;
    const cover = views[2] as Electron.WebContentsView | undefined;
    if (remote === undefined || cover === undefined) throw new Error("no remote or cover view");
    const read = () => ({
      remoteVisible: remote.getVisible(),
      coverVisible: cover.getVisible(),
      coverUrl: cover.webContents.getURL(),
    });
    let state = read();
    while (state.coverVisible !== (want === "cover")) {
      await new Promise<void>((resolve) => {
        const next = () => setImmediate(resolve);
        cover.webContents.once("did-finish-load", next);
        remote.webContents.once("did-navigate", next);
        remote.webContents.once("did-fail-load", next);
      });
      state = read();
    }
    return state;
  }, expected);

const coverPage = (): Page => {
  const page = app.windows().find((window) => window.url().includes("#waiting"));
  if (page === undefined) throw new Error("no cover page");
  return page;
};

describe("Lazurio App GEN4 when the window's page does not show", () => {
  it("says a first page refused a redirect continues in the browser", async () => {
    const covered = await viewsOnceShowing("cover");
    assert.isFalse(covered.remoteVisible);
    assert.include(covered.coverUrl, "problem=browser");
    const cover = coverPage();
    await cover.locator('main[data-problem="browser"]').waitFor();
    assert.include(await cover.locator("main").innerText(), "example.com");
    assert.deepStrictEqual((await cover.evaluate(() => window.lazurio.status())).page, {
      outcome: "refused",
      inBrowser: true,
    });
  });

  it("says why a load failed instead of a blank page, and Retry loads the page", async () => {
    serves = "nothing";
    const failed = app.evaluate(({ BaseWindow }) => {
      const remote = BaseWindow.getAllWindows()[0]?.contentView.children[1] as
        | Electron.WebContentsView
        | undefined;
      return new Promise<void>((resolve) => {
        remote?.webContents.once("did-fail-load", () => resolve());
      });
    });
    await coverPage().locator('[data-action="page-retry"]').click();
    await failed;
    const cover = coverPage();
    await cover.locator('main[data-problem="failed"]').waitFor();
    const covered = await viewsOnceShowing("cover");
    assert.isFalse(covered.remoteVisible);
    assert.include(covered.coverUrl, "problem=failed");
    assert.match(await cover.locator("main").innerText(), /-324/u);
    assert.deepStrictEqual((await cover.evaluate(() => window.lazurio.status())).page, {
      outcome: "failed",
      code: -324,
    });

    serves = "page";
    await cover.locator('[data-action="page-retry"]').click();
    const shown = await viewsOnceShowing("page");
    assert.deepStrictEqual(
      { remoteVisible: shown.remoteVisible, coverVisible: shown.coverVisible },
      { remoteVisible: true, coverVisible: false },
    );
    assert.deepStrictEqual((await cover.evaluate(() => window.lazurio.status())).page, {
      outcome: "shown",
      responseCode: 200,
    });
  });
});
