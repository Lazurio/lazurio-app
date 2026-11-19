// End-to-end: Back to the Overview from the waiting page of an Environment its node cannot reach
// (review of #70). The waiting page loads the Environment again every five seconds; once the
// person leaves for the Overview, that stops, so an Overview slower than five seconds still shows.
// The fake tailnet helper refuses every tunnel while the test's switch file exists;
// --ignore-certificate-errors lets the Environment's run-time certificate through (this launch only).
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test's switch is a file on disk.
import * as NodeFS from "node:fs";
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
// Longer than MainWindow's five seconds between attempts.
const SLOW_OVERVIEW_MS = 7000;

let environment: NodeHttps.Server;
let overview: NodeHttp.Server;
let control: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let overviewUrl: string;
// The Overview answers late once the person goes back to it.
let overviewSlow = false;

const listen = async (server: NodeHttp.Server | NodeHttps.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return address.port;
};

beforeAll(async () => {
  const { cert, key } = selfSigned(["launchpad.e2e.lazurio.io"]);
  environment = NodeHttps.createServer({ cert, key }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Environment</title><p>environment</p>`);
  });
  const environmentPort = await listen(environment);
  overview = NodeHttp.createServer((_request, response) => {
    const answer = () => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><title>Overview</title><a href="${ENVIRONMENT}">Environment</a>`,
      );
    };
    // @effect-diagnostics-next-line globalTimers:off - A plain HTTP server answers late on purpose.
    if (overviewSlow) setTimeout(answer, SLOW_OVERVIEW_MS);
    else answer();
  });
  overviewUrl = `http://127.0.0.1:${await listen(overview)}/`;
  // The node runs at once; only its tunnels fail.
  control = NodeHttp.createServer((_request, response) => response.end());
  const controlPort = await listen(control);

  userData = temporaryUserData();
  const refuse = NodePath.join(userData, "refuse-tunnels");
  NodeFS.writeFileSync(refuse, "");
  app = await _electron.launch({
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
  for (const server of [environment, overview, control]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

describe("Lazurio App GEN4 leaving a waiting Environment", () => {
  it("goes back to a slow Overview, and the waiting Environment does not cut it off", async () => {
    // From the Overview to the Environment, whose tunnel fails: the waiting page shows.
    await app.evaluate(async ({ BaseWindow }, address) => {
      const views = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
      const remote = views[1] as Electron.WebContentsView | undefined;
      const cover = views[2] as Electron.WebContentsView | undefined;
      if (remote === undefined || cover === undefined) throw new Error("no remote or cover view");
      while (remote.webContents.getURL() !== address || remote.webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          remote.webContents.once("did-stop-loading", () => setImmediate(resolve));
        });
      }
      void remote.webContents.executeJavaScript(`document.querySelector("a").click()`, true);
      while (!cover.getVisible() || !cover.webContents.getURL().includes("problem=waiting")) {
        await new Promise<void>((resolve) => {
          cover.webContents.once("did-finish-load", () => setImmediate(resolve));
        });
      }
    }, overviewUrl);
    const cover = app.windows().find((window) => window.url().includes("problem=waiting"));
    if (cover === undefined) throw new Error("no waiting page");
    await cover.locator('main[data-problem="waiting"]').waitFor();

    // Back to the Overview, which answers later than the next attempt would start.
    overviewSlow = true;
    const outcome = app.evaluate(({ BaseWindow }) => {
      const remote = BaseWindow.getAllWindows()[0]?.contentView.children[1] as
        | Electron.WebContentsView
        | undefined;
      if (remote === undefined) throw new Error("no remote view");
      return new Promise<{ readonly shown: string } | { readonly failed: string }>((resolve) => {
        remote.webContents.once("did-navigate", (_event, url) => resolve({ shown: url }));
        remote.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
          if (isMainFrame && code !== -3) resolve({ failed: url });
        });
      });
    });
    await cover.locator('[data-action="page-first"]').click();
    assert.deepStrictEqual(await outcome, { shown: overviewUrl });
    const views = await app.evaluate(({ BaseWindow }) => {
      const children = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
      return { remote: children[1]?.getVisible(), cover: children[2]?.getVisible() };
    });
    assert.deepStrictEqual(views, { remote: true, cover: false });
  });
});
