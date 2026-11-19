// End-to-end: with a remote page open, as a packaged app always has, the local window's tailnet
// status and update controls stay beside the page, not under it, and work (the review of
// Lazurio/lazurio-app#36). The remote view's bounds come from the main process; the controls'
// boxes from the local window, at the same scale. The page must also be visible to its renderer,
// paint, and show in the window's composed pixels.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { APP_NAME } from "../src/shared/appName.ts";
import { STATUS_CHANGED_CHANNEL, type AppStatus } from "../src/shared/bridge.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let shell: Page;

beforeAll(async () => {
  server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>remote</title><body style="margin:0;background:rgb(0,160,0)"><p>remote</p>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--show-status"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `http://127.0.0.1:${address.port}/`,
    },
  });
  shell = await app.firstWindow();
  await shell.locator('main[data-status="live"]').waitFor();
  // The helper programs are folded under the technical details; this test measures their rows.
  await shell.locator("[data-details] summary").click();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const remoteBounds = () =>
  app.evaluate(({ BaseWindow }) => {
    const window = BaseWindow.getAllWindows()[0];
    const local = window?.contentView.children[0];
    const view = window?.contentView.children[1];
    const { width = 0, height = 0 } = window?.contentView.getBounds() ?? {};
    return { local: local?.getBounds(), view: view?.getBounds(), width, height };
  });

describe("Lazurio App GEN4 with a remote page", () => {
  it("keeps the tailnets' status and the update controls beside the page and usable", async () => {
    const { local, view, width, height } = await remoteBounds();
    if (view === undefined) throw new Error("no remote view");
    if (local === undefined) throw new Error("no local view");
    // Side by side: the local view ends where the remote one starts, and nothing lies under it.
    assert.deepStrictEqual(local, { x: 0, y: 0, width: view.x, height });
    assert.isAbove(view.width, 0);
    assert.strictEqual(view.x + view.width, width);
    assert.strictEqual(view.height, height);
    for (const selector of [
      'section[aria-label="Síť Organizace"], section[aria-label="Organization networks"]',
      "section[data-updates-phase]",
      'input[name="update-channel"][value="nightly"]',
    ]) {
      const box = await shell.locator(selector).first().boundingBox();
      if (box === null) throw new Error(`${selector} is not shown`);
      assert.isAtMost(box.x + box.width, view.x, `${selector} lies beside the remote view`);
    }
    await shell.locator('input[name="update-channel"][value="nightly"]').click();
    await shell.locator('section[data-updates-channel="nightly"]').waitFor();
  });

  it("shows the page to its renderer and paints it", async () => {
    const shown = await app.evaluate(async ({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows()[0];
      const view = window?.contentView.children
        .slice(1)
        .find((child): child is Electron.WebContentsView => "webContents" in child);
      if (view === undefined) return { found: false };
      const contents = view.webContents;
      // A page hidden to its renderer reports "hidden" and runs no animation frame.
      const page = (await contents.executeJavaScript(
        `new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ visibility: document.visibilityState, frame: false }), 3000);
          requestAnimationFrame(() => { clearTimeout(timer); resolve({ visibility: document.visibilityState, frame: true }); });
        })`,
      )) as { visibility: string; frame: boolean };
      return {
        found: true,
        windowVisible: window?.isVisible() ?? false,
        viewVisible: view.getVisible(),
        ...page,
      };
    });
    assert.deepStrictEqual(shown, {
      found: true,
      windowVisible: true,
      viewVisible: true,
      visibility: "visible",
      frame: true,
    });
  });

  // What the system composes into the window, not only what the page drew for itself. The remote
  // page is green, the local window dark.
  it("shows the remote page in the window's own pixels", async (context) => {
    const sample = await app.evaluate(
      async ({ BaseWindow, desktopCapturer, screen, systemPreferences }) => {
        // macOS captures nothing without the Screen Recording permission, which no runner grants;
        // Windows always reports it granted, and Linux has no such permission.
        const access = systemPreferences.getMediaAccessStatus?.("screen") ?? "granted";
        if (access !== "granted") return { found: "no permission", access };
        const window = BaseWindow.getAllWindows()[0];
        if (window === undefined) return { found: "no window" };
        const bounds = window.getBounds();
        // The remote page's middle, in screen coordinates.
        const content = window.getContentBounds();
        const point = { x: content.x + content.width * 0.75, y: content.y + content.height * 0.5 };
        const windowSources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: bounds.width, height: bounds.height },
        });
        const own = windowSources.find((source) => source.id === window.getMediaSourceId());
        // Without a window manager (Xvfb) no window is listed, so the whole screen is captured.
        const display = screen.getDisplayMatching(bounds);
        const screenSources =
          own === undefined
            ? await desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: { width: display.size.width, height: display.size.height },
              })
            : [];
        const shot =
          own ??
          screenSources.find((source) => source.display_id === String(display.id)) ??
          screenSources[0];
        if (shot === undefined) return { found: "no capture" };
        const origin = own === undefined ? display.bounds : bounds;
        const size = shot.thumbnail.getSize();
        const scale = size.width / (own === undefined ? display.bounds.width : bounds.width);
        const x = Math.floor((point.x - origin.x) * scale);
        const y = Math.floor((point.y - origin.y) * scale);
        const bitmap = shot.thumbnail.toBitmap();
        // The bitmap is BGRA, row by row.
        const index = (y * size.width + x) * 4;
        return {
          found: own === undefined ? "screen" : "window",
          remote: [bitmap[index + 2] ?? 0, bitmap[index + 1] ?? 0, bitmap[index] ?? 0],
        };
      },
    );
    if (sample.found === "no permission") {
      context.skip(`no Screen Recording permission (${sample.access}) for a capture on macOS`);
    }
    if (sample.remote === undefined) throw new Error(`nothing captured: ${sample.found}`);
    const [red = 0, green = 0, blue = 0] = sample.remote;
    assert.isTrue(
      green > 120 && red < 80 && blue < 80,
      `the window shows rgb(${red}, ${green}, ${blue}) where the remote page is (${sample.found})`,
    );
  });

  // The column's names stay on one line however long a nightly's version and a node's addresses
  // are: those go on lines of their own (task 649, the first nightly on 2026-11-17).
  it("keeps the app's name and every row's name on one line with a nightly's long version", async () => {
    const version = "0.1.0-nightly.20261117.8";
    const long: AppStatus = {
      appVersion: version,
      generation: "GEN4",
      helpers: [
        { name: "lazurio-tailnet", state: "ready", version },
        { name: "lazurio-device", state: "ready", version },
      ],
      tailnets: [
        {
          tailnet: "lazurioexampleorganization",
          state: "running",
          addresses: ["100.64.0.12", "fd7a:115c:a1e0:ab12:4843:cd96:6240:c"],
        },
      ],
      networkMissing: false,
      updates: { channel: "nightly", state: { phase: "off", reason: "unpackaged" } },
      page: { outcome: "none" },
    };
    await app.evaluate(
      ({ webContents }, { channel, status }) => {
        for (const contents of webContents.getAllWebContents())
          if (contents.getURL().startsWith("lazurio-app:")) contents.send(channel, status);
      },
      { channel: STATUS_CHANGED_CHANNEL, status: long },
    );
    await shell
      .locator('[data-tailnet="lazurioexampleorganization"][data-state="running"]')
      .waitFor();
    const lines = await shell.evaluate(() => {
      // An element's text on one line has one line box, whatever its width.
      const lineCount = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      };
      const names = [...document.querySelectorAll(".shell__helpers li > span:first-child")];
      const title = document.querySelector(".shell__header h1");
      return {
        title: title === null ? 0 : lineCount(title),
        titleText: title?.textContent ?? "",
        names: names.map((name) => [name.textContent ?? "", lineCount(name)] as const),
        colors: (() => {
          // A ready helper's state takes the colour for "ok", its version stays muted.
          const probe = document.createElement("span");
          probe.style.color = "var(--ok)";
          document.body.append(probe);
          const ok = getComputedStyle(probe).color;
          probe.remove();
          const row = document.querySelector('[data-helper="lazurio-tailnet"]');
          const colorOf = (selector: string) => {
            const element = row?.querySelector(selector);
            return element === null || element === undefined ? "" : getComputedStyle(element).color;
          };
          return {
            stateIsOk: colorOf(".shell__state") === ok,
            versionIsOk: colorOf(".shell__detail") === ok,
          };
        })(),
      };
    });
    assert.deepStrictEqual(lines, {
      title: 1,
      titleText: APP_NAME,
      // The network's row, its addresses under the technical details, then the helper programs.
      names: [
        ["lazurioexampleorganization", 1],
        ["lazurioexampleorganization", 1],
        ["lazurio-tailnet", 1],
        ["lazurio-device", 1],
      ],
      colors: { stateIsOk: true, versionIsOk: false },
    });
  });
});
