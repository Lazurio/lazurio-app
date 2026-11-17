// End-to-end: an Environment's sign-in over Lazurio Auth and GitHub with the app's real guard
// (ADR 0002, review of #6). A local HTTPS server plays all three; the launch's switches
// --host-resolver-rules (their names to it, every other name nowhere) and
// --ignore-certificate-errors (its self-signed certificate) are this test's, not the app's.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The server's request and response types.
import type * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server plays the sites.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const LAUNCHPAD = "https://launchpad.e2e.lazurio.io/";
const ENVIRONMENT = "https://env.e2e.lazurio.io";
const AUTH = "https://auth.lazurio.ai/realms/workspace";
const GITHUB = "https://github.com";
const GITHUB_LOGIN = `${GITHUB}/login`;
const HOSTS = ["launchpad.e2e.lazurio.io", "env.e2e.lazurio.io", "auth.lazurio.ai", "github.com"];

let server: NodeHttps.Server;
let userData: string;
let app: ElectronApplication;
const output: Array<string> = [];
// Every request the sites served, as "METHOD host/path".
const requests: Array<string> = [];
const answered = new Map<string, PromiseWithResolvers<void>>();
const hang = Promise.withResolvers<void>();
let githubSession = false;
let environmentSession = false;

// Resolves once a site has answered a request for the path.
const answeredFor = (path: string): Promise<void> => {
  const known = answered.get(path) ?? Promise.withResolvers<void>();
  answered.set(path, known);
  return known.promise;
};
const markAnswered = (path: string) => {
  const known = answered.get(path) ?? Promise.withResolvers<void>();
  answered.set(path, known);
  known.resolve();
};

const page = (response: NodeHttp.ServerResponse, title: string, body: string) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>${title}</title>${body}`);
};
const redirect = (response: NodeHttp.ServerResponse, status: number, location: string) => {
  response.writeHead(status, { location });
  response.end();
};

const serve = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  request.resume();
  const host = request.headers.host ?? "";
  const path = new URL(request.url ?? "/", `https://${host}`).pathname;
  if (path === "/favicon.ico") {
    response.writeHead(404);
    response.end();
    return;
  }
  requests.push(`${request.method} ${host}${path}`);
  response.on("finish", () => markAnswered(path));
  const route = `${host}${path}`;
  switch (route) {
    case "launchpad.e2e.lazurio.io/":
      if (environmentSession) page(response, "Launchpad", `<p id="launchpad">launchpad</p>`);
      else redirect(response, 302, `${ENVIRONMENT}/oauth2/start`);
      return;
    case "env.e2e.lazurio.io/oauth2/start":
      redirect(response, 302, `${AUTH}/protocol/openid-connect/auth?client_id=e2e&state=s`);
      return;
    case "env.e2e.lazurio.io/oauth2/callback":
      environmentSession = true;
      redirect(response, 302, LAUNCHPAD);
      return;
    case "auth.lazurio.ai/realms/workspace/protocol/openid-connect/auth":
      redirect(response, 303, `${AUTH}/broker/github/login?state=s`);
      return;
    case "auth.lazurio.ai/realms/workspace/broker/github/login":
      redirect(response, 303, `${GITHUB}/login/oauth/authorize?client_id=e2e&state=s`);
      return;
    case "auth.lazurio.ai/realms/workspace/broker/github/endpoint":
      redirect(response, 302, `${ENVIRONMENT}/oauth2/callback?code=c&state=s`);
      return;
    case "auth.lazurio.ai/fail":
      // No content: the navigation ends without a page.
      response.writeHead(204);
      response.end();
      return;
    case "auth.lazurio.ai/hang":
      void hang.promise.then(() => {
        response.writeHead(204);
        response.end();
      });
      markAnswered("/hang/requested");
      return;
    case "github.com/login/oauth/authorize":
      if (githubSession) redirect(response, 302, `${AUTH}/broker/github/endpoint?code=g&state=s`);
      else redirect(response, 302, "/login?return_to=%2Flogin%2Foauth%2Fauthorize");
      return;
    case "github.com/login":
      page(
        response,
        "Sign in to GitHub",
        `<form method="post" action="/session"><button>Sign in</button></form>`,
      );
      return;
    case "github.com/session":
      githubSession = true;
      redirect(response, 302, "/login/oauth/authorize?client_id=e2e&state=s");
      return;
    default:
      response.writeHead(404);
      response.end();
  }
};

beforeAll(async () => {
  const { cert, key } = selfSigned(HOSTS);
  server = NodeHttps.createServer({ cert, key }, serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  const rules = [
    ...HOSTS.map((host) => `MAP ${host} 127.0.0.1:${address.port}`),
    "MAP * ~NOTFOUND",
  ];

  userData = temporaryUserData();
  app = await _electron.launch({
    args: [
      NodePath.resolve(import.meta.dirname, ".."),
      `--host-resolver-rules=${rules.join(", ")}`,
      "--ignore-certificate-errors",
    ],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: LAUNCHPAD,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
});

afterAll(async () => {
  hang.resolve();
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// Resolves once the app has written the line to its standard output after the given mark.
const outputLine = (line: string, from: number): Promise<void> =>
  new Promise((resolve) => {
    const check = () => {
      if (!output.join("").slice(from).includes(line)) return;
      app.process().stdout?.off("data", check);
      resolve();
    };
    app.process().stdout?.on("data", check);
    check();
  });
const mark = () => output.join("").length;

// The main window's remote view, once it shows the address (origin and path) and stopped loading.
const remoteShows = (url: string): Promise<{ readonly url: string; readonly history: number }> =>
  app.evaluate(async ({ BaseWindow }, expected) => {
    const view = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child);
    if (view === undefined) throw new Error("no remote view");
    const contents = view.webContents;
    const at = (address: string) => {
      const url = URL.parse(address);
      return url === null ? "" : `${url.origin}${url.pathname}`;
    };
    const shows = () => at(contents.getURL()) === expected && !contents.isLoading();
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
    return { url: contents.getURL(), history: contents.navigationHistory.length() };
  }, url);

// Runs a script in the remote view's page, from the main process.
const inRemotePage = (script: string): Promise<unknown> =>
  app.evaluate(async ({ BaseWindow }, code) => {
    const view = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child);
    if (view === undefined) throw new Error("no remote view");
    return view.webContents.executeJavaScript(code, true);
  }, script);

// Waits until the remote view has stopped loading, for a navigation that shows no page.
const remoteSettles = (): Promise<void> =>
  app.evaluate(async ({ BaseWindow }) => {
    const view = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child);
    if (view === undefined) throw new Error("no remote view");
    const contents = view.webContents;
    if (!contents.isLoading()) return;
    await new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve()));
  });

// Cancels the remote view's navigation under way, as a stop or another navigation does. A page's
// window.stop() does not cancel a navigation the browser already runs, and Electron's
// executeJavaScript waits while the main frame loads.
const stopRemote = (): Promise<void> =>
  app.evaluate(async ({ BaseWindow }) => {
    const view = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child);
    if (view === undefined) throw new Error("no remote view");
    const contents = view.webContents;
    const stopped = contents.isLoading()
      ? new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve()))
      : Promise.resolve();
    contents.stop();
    await stopped;
  });

describe("Lazurio App GEN4 sign-in", () => {
  it("signs in from the Environment over Lazurio Auth and GitHub, and back", async () => {
    await answeredFor("/login");
    await remoteShows(GITHUB_LOGIN);
    await inRemotePage(`document.querySelector("form").submit(); true`);
    const shown = await remoteShows(LAUNCHPAD);
    assert.deepStrictEqual(requests, [
      "GET launchpad.e2e.lazurio.io/",
      "GET env.e2e.lazurio.io/oauth2/start",
      "GET auth.lazurio.ai/realms/workspace/protocol/openid-connect/auth",
      "GET auth.lazurio.ai/realms/workspace/broker/github/login",
      "GET github.com/login/oauth/authorize",
      "GET github.com/login",
      "POST github.com/session",
      "GET github.com/login/oauth/authorize",
      "GET auth.lazurio.ai/realms/workspace/broker/github/endpoint",
      "GET env.e2e.lazurio.io/oauth2/callback",
      "GET launchpad.e2e.lazurio.io/",
    ]);
    assert.notInclude(output.join(""), "refused");
    // The finished sign-in left no page of GitHub in the view's history.
    assert.strictEqual(shown.history, 1);
  });

  it("shows GitHub's sign-in no longer once the sign-in ended", async () => {
    const refused = outputLine(`lazurio-app-e2e refused main ${GITHUB_LOGIN}`, mark());
    await inRemotePage(`location.href = "${GITHUB_LOGIN}"; true`);
    await refused;
    assert.strictEqual((await remoteShows(LAUNCHPAD)).url, LAUNCHPAD);
  });

  it("starts no sign-in with a navigation to Lazurio Auth that shows no page", async () => {
    await inRemotePage(`location.href = "https://auth.lazurio.ai/fail"; true`);
    await answeredFor("/fail");
    await remoteSettles();
    const refused = outputLine(`lazurio-app-e2e refused main ${GITHUB_LOGIN}`, mark());
    await inRemotePage(`location.href = "${GITHUB_LOGIN}"; true`);
    await refused;
    assert.strictEqual((await remoteShows(LAUNCHPAD)).url, LAUNCHPAD);
  });

  it("starts no sign-in with a navigation to Lazurio Auth that was cancelled", async () => {
    await inRemotePage(`location.href = "https://auth.lazurio.ai/hang"; true`);
    await answeredFor("/hang/requested");
    await stopRemote();
    const refused = outputLine(`lazurio-app-e2e refused main ${GITHUB_LOGIN}`, mark());
    await inRemotePage(`location.href = "${GITHUB_LOGIN}"; true`);
    await refused;
    assert.strictEqual((await remoteShows(LAUNCHPAD)).url, LAUNCHPAD);
    assert.strictEqual(requests.filter((request) => request === "GET github.com/login").length, 1);
  });
});
