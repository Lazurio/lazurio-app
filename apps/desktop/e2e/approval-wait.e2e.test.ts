// End-to-end: a page of a tailnet whose node cannot reach it yet, as before the Organization
// approves the Device, shows the app's waiting page instead of a blank one, and loads by itself
// once its tunnel works, even when its server answers slower than the app retries (task 648). The fake tailnet helper refuses every tunnel
// while the test's switch file exists; --ignore-certificate-errors lets the page's run-time
// certificate through (this launch only).
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test's switch is a file on disk.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the node's cue.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server is the page.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const PAGE = "https://launchpad.e2e.lazurio.io/";
// Longer than MainWindow's five seconds between attempts.
const SLOW_ANSWER_MS = 7000;

let pageServer: NodeHttps.Server;
let control: NodeHttp.Server;
let userData: string;
let refuse: string;
let app: ElectronApplication;

beforeAll(async () => {
  const { cert, key } = selfSigned(["launchpad.e2e.lazurio.io"]);
  pageServer = NodeHttps.createServer({ cert, key }, (request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404);
      response.end();
      return;
    }
    // Slower than the app's interval between attempts: an attempt must not cancel the one before.
    // @effect-diagnostics-next-line globalTimers:off - A plain HTTPS server answers late on purpose.
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Launchpad</title><p>launchpad</p>`);
    }, SLOW_ANSWER_MS);
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  const address = pageServer.address();
  if (address === null || typeof address === "string") throw new Error("no server address");

  // The node runs at once; only its tunnels fail.
  control = NodeHttp.createServer((_request, response) => response.end());
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlAddress = control.address();
  if (controlAddress === null || typeof controlAddress === "string") {
    throw new Error("no control address");
  }

  userData = temporaryUserData();
  refuse = NodePath.join(userData, "refuse-tunnels");
  NodeFS.writeFileSync(refuse, "");
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--ignore-certificate-errors"],
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
      LAZURIO_FAKE_RUNNING_URL: `http://127.0.0.1:${controlAddress.port}/running`,
      LAZURIO_FAKE_UPSTREAM: `127.0.0.1:${address.port}`,
      LAZURIO_FAKE_REFUSE_WHILE: refuse,
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
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  for (const server of [pageServer, control]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

// The remote view (second) and the waiting view (third) beside the local column, once the window
// shows the expected one: the state is read again after each failed or committed load of the
// remote view, which is when it changes.
const viewsOnceShowing = (expected: "waiting" | "page") =>
  app.evaluate(async ({ BaseWindow }, want) => {
    const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
    const remote = views[1] as Electron.WebContentsView | undefined;
    const waiting = views[2];
    if (remote === undefined || waiting === undefined) throw new Error("no remote or waiting view");
    const read = () => ({
      remoteVisible: remote.getVisible(),
      waitingVisible: waiting.getVisible(),
      remoteUrl: remote.webContents.getURL(),
    });
    const event = want === "waiting" ? "did-fail-load" : "did-navigate";
    let state = read();
    while (state.waitingVisible !== (want === "waiting")) {
      await new Promise<void>((resolve) => {
        remote.webContents.once(event as "did-navigate", () => setImmediate(resolve));
      });
      state = read();
    }
    return state;
  }, expected);

describe("Lazurio App GEN4 waiting for a tailnet's page", () => {
  it("shows its waiting page while the tunnel fails, and the page once it works", async () => {
    const waiting = await viewsOnceShowing("waiting");
    assert.deepStrictEqual(
      { remoteVisible: waiting.remoteVisible, waitingVisible: waiting.waitingVisible },
      { remoteVisible: false, waitingVisible: true },
    );
    const page = app.windows().find((window) => window.url().endsWith("#waiting"));
    if (page === undefined) throw new Error("no waiting page");
    assert.match(
      await page.locator("main.waiting h1").innerText(),
      /has not loaded yet|se zatím nenačetlo/u,
    );

    // The Organization approves the Device: the tunnel works, and the page loads by itself.
    NodeFS.rmSync(refuse);
    const shown = await viewsOnceShowing("page");
    assert.deepStrictEqual(shown, { remoteVisible: true, waitingVisible: false, remoteUrl: PAGE });
  });
});
