// End-to-end: the bar that says an agent works, and the Agent Desktop window (DevicePanel.ts), with
// a fake Device helper whose agent takes the computer once the test says so. In English and Czech,
// for the screenshots too. The test waits for events, never for time.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test tells the fake helper through a file.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the main window's page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its fixture on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { columnPage, localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const ENVIRONMENT = "https://launchpad.bob.e2e.lazurio.io";

// The bar's place in the main window, as the main process laid it out.
const barBounds = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow, WebContentsView }) => {
    const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
    const bar = main?.contentView.children.find(
      (child): child is Electron.WebContentsView =>
        child instanceof WebContentsView && child.webContents.getURL().includes("view=agent-bar"),
    );
    return bar === undefined ? null : bar.getBounds().height;
  });

// The main window as the screen shows it: the hidden status column, the bar and the page. Xvfb has
// no window manager, so the screen is captured and cut to the window.
const windowShot = async (app: ElectronApplication, name: string) => {
  const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
  if (directory === undefined || directory === "") return;
  const png = await app.evaluate(async ({ BaseWindow, desktopCapturer, screen }) => {
    const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
    if (main === undefined) return null;
    const bounds = main.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const [source] = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    if (source === undefined) return null;
    return source.thumbnail
      .crop({
        x: bounds.x - display.bounds.x,
        y: bounds.y - display.bounds.y,
        width: Math.min(bounds.width, display.size.width),
        height: Math.min(bounds.height, display.size.height),
      })
      .toPNG()
      .toString("base64");
  });
  if (png !== null)
    NodeFS.writeFileSync(NodePath.join(directory, name), Buffer.from(png, "base64"));
};

const screenshot = async (page: Page, name: string) => {
  const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
  if (directory === undefined || directory === "") return;
  await page.screenshot({ path: NodePath.join(directory, name) });
};

describe.each([
  { lang: "en-US", tag: "en", stop: /Stop/u, label: /An agent from the Environment Bob/u },
  { lang: "cs", tag: "cs", stop: /Zastavit/u, label: /Agent z Prostředí Bob/u },
])("Agent Desktop's bar and window ($tag)", ({ lang, tag, stop, label }) => {
  let userData: string;
  let server: NodeHttp.Server;
  let app: ElectronApplication;
  let shell: Page;
  const stderr: Array<string> = [];

  beforeAll(async () => {
    // The main window's page, so the status column hides and the bar lies over the page.
    server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><title>page</title><body style="margin:0;background:#e8eef7"><p style="font:16px system-ui;padding:24px">Lazurio</p>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    userData = temporaryUserData();
    app = await _electron.launch({
      args: [NodePath.resolve(import.meta.dirname, ".."), `--lang=${lang}`],
      chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
      env: {
        ...process.env,
        LAZURIO_APP_E2E: "true",
        LAZURIO_APP_E2E_USER_DATA: userData,
        LAZURIO_APP_E2E_REMOTE_URL: `http://127.0.0.1:${address.port}/`,
        LAZURIO_APP_E2E_NODE: process.execPath,
        LAZURIO_APP_E2E_DEVICE_HELPER: NodePath.resolve(
          import.meta.dirname,
          "..",
          "src",
          "main",
          "fake-device-helper.ts",
        ),
        LAZURIO_FAKE_DEVICE_AGENT_FILE: NodePath.join(userData, "agent"),
      },
    });
    app.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    shell = await columnPage(app);
    // The status column is hidden by default (#61), and on Windows a hidden view's elements are
    // not visible: its page is waited for as live, not as visible.
    await shell.locator('main[data-status="live"]').waitFor({ state: "attached" });
  });

  afterAll(async () => {
    await app?.close();
    removeUserData(userData);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("takes no room and opens no window while no agent works", async () => {
    const bar = await localPage(app, "view=agent-bar");
    await bar.locator('[data-agent-bar="none"]').waitFor();
    assert.strictEqual(await barBounds(app), 0);
    const windows = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    assert.strictEqual(windows, 1);
  });

  it("shows who works over the page, and its Agent Desktop opens one window", async () => {
    const bar = await localPage(app, "view=agent-bar");
    // The fake helper's agent takes the computer: written whole, then moved into place.
    const file = NodePath.join(userData, "agent");
    NodeFS.writeFileSync(`${file}.new`, `${ENVIRONMENT}|Bob`);
    NodeFS.renameSync(`${file}.new`, file);
    await bar.locator(`[data-agent-bar="${ENVIRONMENT}"]`).waitFor();
    assert.match(await bar.locator(".agent-bar__text").innerText(), label);
    assert.strictEqual(await barBounds(app), 36);
    // The status column does not open for the agent's work (Matěj, 2026-11-23): only the bar says it.
    const columnShown = () =>
      app.evaluate(({ BaseWindow }) => {
        const local = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null)
          ?.contentView.children[0];
        return local?.getVisible() === true && (local?.getBounds().width ?? 0) > 0;
      });
    assert.isFalse(await columnShown());
    // Opened by the person, in a window narrower than the column: the bar still spans the whole
    // width over the column, so its message, Stop and Agent Desktop stay usable.
    await bar.evaluate(() => window.lazurio.setStatusPanel(true));
    assert.isTrue(await columnShown());
    const narrow = await app.evaluate(({ BaseWindow, WebContentsView }) => {
      const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      if (main === undefined) return null;
      main.setContentSize(320, 480);
      main.contentView.emit("bounds-changed");
      const content = main.contentView.getBounds();
      const views = main.contentView.children;
      const bar = views.find(
        (child): child is Electron.WebContentsView =>
          child instanceof WebContentsView && child.webContents.getURL().includes("view=agent-bar"),
      );
      return {
        content: content.width,
        bar: bar?.getBounds() ?? null,
        columnTop: views[0]?.getBounds().y ?? null,
      };
    });
    assert.isNotNull(narrow);
    assert.deepStrictEqual(narrow?.bar, { x: 0, y: 0, width: narrow?.content, height: 36 });
    assert.strictEqual(narrow?.columnTop, 36);
    assert.isTrue(await bar.locator('[data-action="device-stop"]').isVisible());
    await app.evaluate(({ BaseWindow }) => {
      const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      main?.setContentSize(1280, 800);
      main?.contentView.emit("bounds-changed");
    });
    await bar.evaluate(() => window.lazurio.setStatusPanel(false));
    assert.isFalse(await columnShown());
    await windowShot(app, `adwin61-main-${tag}.png`);
    await screenshot(bar, `adwin61-bar-${tag}.png`);
    await bar.locator('[data-action="device-open-window"]').click();
    const panel = await localPage(app, "view=agent-desktop");
    await panel.locator('section[data-device-state="ready"]').waitFor();
    await panel.locator(`[data-device-agent="${ENVIRONMENT}"]`).waitFor();
    await bar.locator('[data-action="device-open-window"]').click();
    const titles = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows().map((each) => each.getTitle()),
    );
    assert.lengthOf(titles, 2);
    assert.include(titles, "Agent Desktop");
    await screenshot(panel, `adwin61-window-${tag}.png`);
  });

  it("stops the agent from the bar, and the bar goes", async () => {
    const bar = await localPage(app, "view=agent-bar");
    assert.match(await bar.locator('[data-action="device-stop"]').innerText(), stop);
    await bar.locator('[data-action="device-stop"]').click();
    await bar.locator('[data-agent-bar="none"]').waitFor();
    assert.include(stderr.join(""), "lazurio-fake-device stop-agent");
    assert.strictEqual(await barBounds(app), 0);
  });
});
