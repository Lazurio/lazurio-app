// End-to-end: an Environment opened from a page the app loads directly, as the Overview, goes
// through the tailnet helper's proxy, which asks for its credentials first. After a new start of
// the app, the Environment's service worker takes the navigation, and its navigation preload has
// no one to answer the challenge: without the app's own first request (Tailnet.ts,
// primeProxyCredentials) the window commits the proxy's empty 407 and stays blank
// (Lazurio/lazurio-app#36, the trial of 2026-11-19). The fake tailnet helper's proxy asks as the
// real one does; --ignore-certificate-errors lets the Environment's run-time certificate through
// (this launch only).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the Overview.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server is the Environment.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const ENVIRONMENT = "https://launchpad.e2e.lazurio.io/";
const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.navigationPreload.enable().then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || new URL(event.request.url).pathname === "/elsewhere") return;
  event.respondWith(event.preloadResponse.then((preloaded) => preloaded ?? fetch(event.request)));
});
`;

let environment: NodeHttps.Server;
let overview: NodeHttp.Server;
let control: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let overviewUrl: string;
let launch: (challengeDelayMs?: number) => Promise<ElectronApplication>;
// Called once the fake proxy got a plain request with its credentials.
let answered: (() => void) | undefined;

const listen = async (server: NodeHttp.Server | NodeHttps.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return address.port;
};

beforeAll(async () => {
  const { cert, key } = selfSigned(["launchpad.e2e.lazurio.io"]);
  // The Environment's page registers a service worker with navigation preload, as Launchpad
  // does: from the next start of the app on, it takes the Environment's navigations.
  environment = NodeHttps.createServer({ cert, key }, (request, response) => {
    // Elsewhere for the refused redirect: an address outside Lazurio, which the app hands to the
    // system's browser.
    if (request.url === "/elsewhere") {
      response.writeHead(302, { location: "https://example.com/elsewhere" });
      response.end();
      return;
    }
    if (request.url === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(SERVICE_WORKER);
      return;
    }
    response.writeHead(request.url === "/favicon.ico" ? 404 : 200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Environment</title><p>environment</p><script>navigator.serviceWorker.register("/sw.js")</script>`,
    );
  });
  const environmentPort = await listen(environment);
  overview = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Overview</title><a href="${ENVIRONMENT}">Environment</a>`);
  });
  overviewUrl = `http://127.0.0.1:${await listen(overview)}/`;
  // The node runs at once.
  control = NodeHttp.createServer((request, response) => {
    if (request.url === "/answered") answered?.();
    response.end();
  });
  const controlPort = await listen(control);

  userData = temporaryUserData();
  launch = (challengeDelayMs = 3000) =>
    _electron.launch({
      args: [NodePath.resolve(import.meta.dirname, ".."), "--ignore-certificate-errors"],
      chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
      env: {
        ...process.env,
        LAZURIO_APP_E2E: "true",
        LAZURIO_APP_E2E_USER_DATA: userData,
        LAZURIO_APP_E2E_REMOTE_URL: overviewUrl,
        LAZURIO_APP_E2E_NODE: process.execPath,
        LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
          import.meta.dirname,
          "fake-tailnet-helper.ts",
        ),
        LAZURIO_FAKE_RUNNING_URL: `http://127.0.0.1:${controlPort}/running`,
        LAZURIO_FAKE_UPSTREAM: `127.0.0.1:${environmentPort}`,
        // Later than the window's first page: the app must not navigate before it has the answer.
        LAZURIO_FAKE_SLOW_PLAIN_CHALLENGE_MS: String(challengeDelayMs),
        LAZURIO_FAKE_ANSWERED_URL: `http://127.0.0.1:${controlPort}/answered`,
        LAZURIO_APP_DEV_TAILNETS: JSON.stringify([
          {
            tailnet: "e2e",
            controlUrl: "https://headscale.e2e.lazurio.invalid",
            hostname: "e2e-app",
            domains: ["e2e.lazurio.io"],
          },
        ]),
      },
    });
  app = await launch();
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  for (const server of [environment, overview, control]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

// Clicks the Overview's link in the remote view once the Overview shows, and answers with the
// first main-frame outcome of the navigation it starts.
const openEnvironmentFromOverview = (overviewAddress: string) =>
  app.evaluate(async ({ BaseWindow }, address) => {
    const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
    const remote = views[1] as Electron.WebContentsView | undefined;
    if (remote === undefined) throw new Error("no remote view");
    const contents = remote.webContents;
    while (contents.getURL() !== address || contents.isLoading()) {
      await new Promise<void>((resolve) => {
        contents.once("did-stop-loading", () => setImmediate(resolve));
      });
    }
    const outcome = new Promise<{ readonly url: string; readonly code: number }>((resolve) => {
      contents.on("did-navigate", (_event, url, responseCode) => {
        if (url !== address) resolve({ url, code: responseCode });
      });
      contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
        if (isMainFrame) resolve({ url, code });
      });
    });
    await contents.executeJavaScript(`document.querySelector("a").click()`, true);
    const result = await outcome;
    if (result.code !== 200) return { ...result, text: "" };
    await new Promise<void>((resolve) => {
      if (!contents.isLoading()) resolve();
      else contents.once("did-stop-loading", () => resolve());
    });
    const text = (await contents.executeJavaScript(`document.body?.innerText ?? ""`)) as string;
    return { ...result, text: text.trim() };
  }, overviewAddress);

// Waits until the Environment's service worker controls its page.
const serviceWorkerControls = () =>
  app.evaluate(async ({ BaseWindow }) => {
    const remote = BaseWindow.getAllWindows()[0]?.contentView.children[1] as
      | Electron.WebContentsView
      | undefined;
    if (remote === undefined) throw new Error("no remote view");
    return remote.webContents.executeJavaScript(
      `navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller !== null || new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true))))`,
    ) as Promise<boolean>;
  });

describe("Lazurio App GEN4 opening an Environment from the Overview", () => {
  it("answers the proxy's challenge and shows the Environment", async () => {
    assert.deepStrictEqual(await openEnvironmentFromOverview(overviewUrl), {
      url: ENVIRONMENT,
      code: 200,
      text: "environment",
    });
    assert.isTrue(await serviceWorkerControls());
  });

  it("shows it after a new start, when the Environment's service worker takes the navigation", async () => {
    await app.close();
    app = await launch();
    await app.firstWindow();
    assert.deepStrictEqual(await openEnvironmentFromOverview(overviewUrl), {
      url: ENVIRONMENT,
      code: 200,
      text: "environment",
    });
  });

  it("leaves the Environment as it shows when its page is refused a redirect", async () => {
    const after = await app.evaluate(async ({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
      const remote = views[1] as Electron.WebContentsView | undefined;
      const cover = views[2] as Electron.WebContentsView | undefined;
      if (remote === undefined || cover === undefined) throw new Error("no remote or cover view");
      const refused = new Promise<void>((resolve) => {
        remote.webContents.once("will-redirect", () => setImmediate(resolve));
      });
      void remote.webContents.executeJavaScript(`location.href = "/elsewhere"`);
      await refused;
      return {
        remoteVisible: remote.getVisible(),
        coverVisible: cover.getVisible(),
        url: remote.webContents.getURL(),
      };
    });
    assert.deepStrictEqual(after, { remoteVisible: true, coverVisible: false, url: ENVIRONMENT });
    const shell = app.windows().find((window) => !window.url().includes("#waiting"));
    if (shell === undefined) throw new Error("no local page");
    assert.deepStrictEqual((await shell.evaluate(() => window.lazurio.status())).page, {
      outcome: "refused",
      inBrowser: true,
    });
  });

  // Later than the start waits for it (Tailnet.ts, PRIME_WITHIN): the window opens first.
  it("says why when the proxy answered too late, and Try again shows the Environment once it has", async () => {
    await app.close();
    const credentialsIn = new Promise<void>((resolve) => {
      answered = resolve;
    });
    app = await launch(7000);
    await app.firstWindow();
    assert.deepStrictEqual(await openEnvironmentFromOverview(overviewUrl), {
      url: ENVIRONMENT,
      code: 407,
      text: "",
    });
    // The app's page shows once it has loaded.
    await app.evaluate(async ({ BaseWindow }) => {
      const coverView = BaseWindow.getAllWindows()[0]?.contentView.children[2] as
        | Electron.WebContentsView
        | undefined;
      if (coverView === undefined) throw new Error("no cover view");
      while (!coverView.getVisible() || !coverView.webContents.getURL().includes("problem=proxy")) {
        await new Promise<void>((resolve) => {
          coverView.webContents.once("did-finish-load", () => setImmediate(resolve));
        });
      }
    });
    const cover = app.windows().find((window) => window.url().includes("problem=proxy"));
    if (cover === undefined) throw new Error("no cover page");
    await cover.locator('main[data-problem="proxy"]').waitFor();

    await credentialsIn;
    const shown = app.evaluate(async ({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
      const remote = views[1] as Electron.WebContentsView | undefined;
      const coverView = views[2] as Electron.WebContentsView | undefined;
      if (remote === undefined || coverView === undefined) throw new Error("no views");
      const code = await new Promise<number>((resolve) => {
        remote.webContents.once("did-navigate", (_event, _url, responseCode) =>
          setImmediate(() => resolve(responseCode)),
        );
      });
      return { code, remoteVisible: remote.getVisible(), coverVisible: coverView.getVisible() };
    });
    await cover.locator('[data-action="page-retry"]').click();
    assert.deepStrictEqual(await shown, { code: 200, remoteVisible: true, coverVisible: false });
  });
});
