// End-to-end: with a remote page open, as a packaged app always has, the local window's tailnet
// status and update controls stay beside the page, not under it, and work (the review of
// Lazurio/lazurio-app#36). The remote view's bounds come from the main process; the controls'
// boxes from the local window, at the same scale. The page must also be shown and paint: on
// Windows it loaded but stayed blank, hidden to its renderer, until something forced a repaint
// (the trial of the proof of concept on 2026-11-17).
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
    args: [NodePath.resolve(import.meta.dirname, "..")],
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
      'section[aria-label="Tailnety"], section[aria-label="Tailnets"]',
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

  it("shows the page and paints it without a forced repaint", async () => {
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

  // What the system composes into the window, not what the page drew for itself: on Windows the
  // page painted and still the window showed the local page's background in its place (the trial of
  // 2026-11-17). The remote page is green, the local window dark.
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
});
