// End-to-end: the remote view's first page waits for the tailnet that serves it, then loads
// through the PAC script, the proxy's challenge and the node's tunnel, and once more when the
// first tunnel fails (Lazurio/lazurio-app#5). The fake tailnet helper tunnels to a local HTTPS
// server; --ignore-certificate-errors lets its run-time certificate through (this launch only).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the node's cue.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server is the page.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, expect, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";
import { columnPage } from "./local-page.ts";

const PAGE = "https://launchpad.e2e.lazurio.io/";
const CONTROL = "https://headscale.e2e.lazurio.invalid";
// The sign-in address the fake tailnet helper reports (fake-tailnet-helper.ts).
const SIGN_IN = `${CONTROL}/register/e2e`;

const running = Promise.withResolvers<void>();
let pageRequests = 0;
let pageServer: NodeHttps.Server;
let control: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let shell: Page;

const portOf = (server: NodeHttp.Server | NodeHttps.Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return address.port;
};

beforeAll(async () => {
  const { cert, key } = selfSigned(["launchpad.e2e.lazurio.io"]);
  pageServer = NodeHttps.createServer({ cert, key }, (request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404);
      response.end();
      return;
    }
    pageRequests += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Launchpad</title><p>launchpad</p>`);
  });
  control = NodeHttp.createServer((_request, response) => {
    void running.promise.then(() => response.end());
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));

  userData = temporaryUserData();
  app = await _electron.launch({
    args: [
      NodePath.resolve(import.meta.dirname, ".."),
      "--show-status",
      "--ignore-certificate-errors",
    ],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: PAGE,
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
        import.meta.dirname,
        "fake-tailnet-helper.ts",
      ),
      LAZURIO_FAKE_RUNNING_URL: `http://127.0.0.1:${portOf(control)}/running`,
      LAZURIO_FAKE_UPSTREAM: `127.0.0.1:${portOf(pageServer)}`,
      LAZURIO_FAKE_FAIL_FIRST_CONNECT: "true",
      LAZURIO_APP_DEV_TAILNETS: JSON.stringify([
        {
          tailnet: "e2e",
          controlUrl: CONTROL,
          hostname: "e2e-app",
          domains: ["e2e.lazurio.io"],
        },
      ]),
    },
  });
  shell = await columnPage(app);
});

afterAll(async () => {
  running.resolve();
  await app?.close();
  removeUserData(userData);
  for (const server of [pageServer, control]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

// Resolves once the main window's remote view exists.
const remoteViewExists = (): Promise<void> =>
  app.evaluate(async ({ app: electronApp, BaseWindow }) => {
    const exists = () =>
      BaseWindow.getAllWindows()
        .flatMap((window) => window.contentView.children.slice(1))
        .some((child) => "webContents" in child);
    if (exists()) return;
    await new Promise<void>((resolve) => electronApp.once("web-contents-created", () => resolve()));
  });

// Whether the remote view has loaded anything. Asked in a later call than remoteViewExists, so
// it runs after the task that created the view, in which the view would have started to load if
// it did not wait for its tailnet.
const remoteViewState = (): Promise<{ readonly url: string; readonly loading: boolean }> =>
  app.evaluate(({ BaseWindow }) => {
    const contents = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child)?.webContents;
    return { url: contents?.getURL() ?? "", loading: contents?.isLoading() ?? false };
  });

const readClipboard = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText());

const writeClipboard = (text: string): Promise<void> =>
  app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);

// The remote view's address once it shows the page with the title, not an error page at its
// address, and has stopped loading.
const remoteShows = (url: string, title: string): Promise<string> =>
  app.evaluate(
    async ({ BaseWindow }, expected) => {
      const view = BaseWindow.getAllWindows()
        .flatMap((window) => window.contentView.children.slice(1))
        .find((child): child is Electron.WebContentsView => "webContents" in child);
      if (view === undefined) throw new Error("no remote view");
      const contents = view.webContents;
      const shows = () =>
        contents.getURL() === expected.url &&
        contents.getTitle() === expected.title &&
        !contents.isLoading();
      if (!shows()) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!shows()) return;
            contents.off("did-stop-loading", check);
            resolve();
          };
          contents.on("did-stop-loading", check);
          check();
        });
      }
      return contents.getURL();
    },
    { url, title },
  );

describe("Lazurio App GEN4 first page", () => {
  it("waits for the tailnet that serves its first page", async () => {
    // The column's page is ready once live (#71): on a Windows runner its view may not count as
    // visible yet, and a later step that needs it visible waits for that itself.
    await shell.locator('main[data-status="live"]').waitFor({ state: "attached" });
    await shell.locator('[data-tailnet="e2e"][data-state="needs-login"]').waitFor();
    await remoteViewExists();
    assert.deepStrictEqual(await remoteViewState(), { url: "", loading: false });
    assert.strictEqual(pageRequests, 0);
  });

  it("copies the node's sign-in address on request, and Copy status leaves it out", async () => {
    await writeClipboard("before");
    await shell
      .locator(
        '[data-tailnet="e2e"][data-state="needs-login"] [data-action="tailnet-copy-sign-in"]',
      )
      .click();
    await expect.poll(readClipboard).toBe(SIGN_IN);
    await shell.locator('[data-action="status-copy"]').click();
    await shell.locator('[data-copy-state="copied"]').waitFor();
    const status = await readClipboard();
    assert.include(status, "e2e: needs-login");
    assert.notInclude(status, "/register/");
    assert.notInclude(status, CONTROL);
  });

  it("loads it through the node once the node runs, also after a failed first tunnel", async () => {
    running.resolve();
    await shell.locator('[data-tailnet="e2e"][data-state="running"]').waitFor();
    // A node that runs has no sign-in address to copy any more.
    assert.strictEqual(await shell.locator('[data-action="tailnet-copy-sign-in"]').count(), 0);
    assert.strictEqual(await remoteShows(PAGE, "Launchpad"), PAGE);
    assert.strictEqual(pageRequests, 1);
  });
});
