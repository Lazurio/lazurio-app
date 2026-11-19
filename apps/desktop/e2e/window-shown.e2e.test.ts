// End-to-end: the path of every day after the first, a start with --hidden at sign-in, then the
// window opened from its shortcut (a second start), closed with its X and opened again. Each time
// the window shows, its page and its status column count themselves visible and have painted
// pixels, not only a window that exists (#36: a blank window after the display was off).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { columnPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    response.writeHead(request.url === "/favicon.ico" ? 404 : 200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>remote</title><body style="background:#2a6"><p>remote</p></body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--hidden", "--show-status"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `http://127.0.0.1:${address.port}/`,
    },
  });
  const column = await columnPage(app);
  await column.locator('main[data-status="live"]').waitFor({ state: "attached" });
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// The main window, which a second start without arguments shows, as its shortcut does.
const openFromShortcut = () =>
  app.evaluate(({ app: electronApp, BaseWindow }) => {
    const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
    if (window === undefined) throw new Error("no main window");
    const shown = new Promise<void>((resolve) => {
      if (window.isVisible()) resolve();
      else window.once("show", () => resolve());
    });
    electronApp.emit("second-instance", {}, [process.execPath], process.cwd(), {});
    return shown;
  });

// The column (first view) and the page (second) once the window shows: whether each page counts
// itself visible, and what it painted. The page's middle has its background, #2a6, in a capture
// (a bitmap's channels are BGRA or RGBA); the column has painted more than one colour, its text.
const shownViews = () =>
  app.evaluate(async ({ BaseWindow }) => {
    const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
    if (window === undefined) throw new Error("no main window");
    const views = window.contentView.children.slice(0, 2) as Array<Electron.WebContentsView>;
    const visibilityOf = (view: Electron.WebContentsView) =>
      view.webContents.executeJavaScript(
        `new Promise((resolve) => document.visibilityState === "visible"
          ? resolve("visible")
          : document.addEventListener("visibilitychange", () => resolve(document.visibilityState), { once: true }))`,
      ) as Promise<string>;
    const pixels = async (view: Electron.WebContentsView) => {
      const image = await view.webContents.capturePage();
      const { width, height } = image.getSize();
      return { bitmap: image.toBitmap(), width, height };
    };
    const near = (a: number, b: number) => Math.abs(a - b) <= 8;
    const [column, page] = views;
    if (column === undefined || page === undefined) throw new Error("no column or page");
    const columnPixels = await pixels(column);
    const colours = new Set<number>();
    for (let index = 0; index + 3 < columnPixels.bitmap.length; index += 4 * 97) {
      colours.add(columnPixels.bitmap.readUInt32LE(index));
    }
    const pagePixels = await pixels(page);
    const middle =
      4 * (Math.floor(pagePixels.height / 2) * pagePixels.width + Math.floor(pagePixels.width / 2));
    const [first = 0, second = 0, third = 0] = pagePixels.bitmap.subarray(middle, middle + 3);
    const green =
      near(second, 0xaa) &&
      ((near(first, 0x22) && near(third, 0x66)) || (near(first, 0x66) && near(third, 0x22)));
    return {
      column: { visibility: await visibilityOf(column), painted: colours.size > 1 },
      page: { visibility: await visibilityOf(page), painted: green },
    };
  });

const SHOWN = {
  column: { visibility: "visible", painted: true },
  page: { visibility: "visible", painted: true },
};

describe("Lazurio App GEN4's window shown after a start with --hidden", () => {
  it("shows no window at first", async () => {
    const visible = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows().map((window) => window.isVisible()),
    );
    assert.deepStrictEqual(visible, [false]);
  });

  it("shows its page and column, visible and painted, once its shortcut opens it", async () => {
    await openFromShortcut();
    assert.deepStrictEqual(await shownViews(), SHOWN);
  });

  it("shows them again after its X hid the window", async () => {
    const hidden = await app.evaluate(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      if (window === undefined) throw new Error("no main window");
      const done = new Promise<boolean>((resolve) => {
        window.once("hide", () => resolve(window.isVisible()));
      });
      window.close();
      return done;
    });
    assert.isFalse(hidden);
    await openFromShortcut();
    assert.deepStrictEqual(await shownViews(), SHOWN);
  });
});
