// End-to-end: a first start with only the built-in list (no IT policy, no setting of the person's,
// no list from their account yet). The bar over every page and the page in an Environment's place
// offer the sign-in with the Lazurio account. The test follows the address the app hands to the
// "system's browser" to a fake Lazurio Auth on the loopback, and the app reads the person's networks
// with a token of exactly the directory's scope. Auth answers 503 here, so the bar says the read
// failed and offers it again: a list that changes starts the app again, which a test cannot follow.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server plays Lazurio Auth.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

// Nothing serves it, so its name does not resolve: the page of a network the app does not have.
const ENVIRONMENT = "https://launchpad.e2e.lazurio.io/";
const DIRECTORY_SCOPE = "lazurio-network-directory";

let auth: NodeHttp.Server;
let issuer: string;
let userData: string;
let app: ElectronApplication;
const output: Array<string> = [];
// Each read of the directory: the scope and audiences of the token it carried.
const directoryReads: Array<{ readonly scope: string; readonly aud: unknown }> = [];
let signIns = 0;

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<
    string,
    unknown
  >;
const nonces = new Map<string, string>();

// Unsigned tokens, as the app takes them from the token endpoint (AuthClient checks their claims).
const idToken = (nonce: string) =>
  [
    segment({ alg: "none", typ: "JWT" }),
    segment({
      iss: issuer,
      aud: "lazurio-app",
      azp: "lazurio-app",
      sub: "e2e-person",
      nonce,
      iat: 1_600_000_000,
      exp: 4_102_444_800,
    }),
    "",
  ].join(".");
// A refresh with exactly one of the app's scopes gets that scope and its one audience.
const accessToken = (scope: string) =>
  [
    segment({ alg: "none", typ: "JWT" }),
    segment({
      iss: issuer,
      aud: scope.includes(" ") ? "account" : scope,
      azp: "lazurio-app",
      sub: "e2e-person",
      scope,
      iat: 1_600_000_000,
      exp: 4_102_444_800,
    }),
    "",
  ].join(".");

const readBody = (request: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const serveAuth = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  const url = new URL(request.url ?? "/", issuer);
  const path = url.pathname.replace(new URL(issuer).pathname, "");
  const body = await readBody(request);
  switch (`${request.method} ${path}`) {
    case "GET /.well-known/openid-configuration":
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`,
      });
    case "GET /protocol/openid-connect/auth": {
      signIns += 1;
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      const code = `code-${signIns}`;
      nonces.set(code, url.searchParams.get("nonce") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", issuer);
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    case "POST /protocol/openid-connect/token": {
      const form = new URLSearchParams(body);
      const nonce = nonces.get(form.get("code") ?? "");
      const scope = form.get("scope") ?? `openid lazurio-device-entry ${DIRECTORY_SCOPE}`;
      return json(response, 200, {
        ...(form.get("grant_type") === "authorization_code" && nonce !== undefined
          ? { id_token: idToken(nonce) }
          : {}),
        access_token: accessToken(scope),
        token_type: "Bearer",
        expires_in: 300,
        refresh_token: `refresh-${signIns}`,
        scope,
      });
    }
    case "POST /protocol/openid-connect/revoke":
      response.writeHead(200);
      response.end();
      return;
    case "GET /lazurio-network-directory/networks": {
      const claims = claimsOf((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
      directoryReads.push({ scope: String(claims["scope"]), aud: claims["aud"] });
      return json(response, 503, { error: "network_directory_unavailable" });
    }
    default:
      response.writeHead(404);
      response.end();
  }
};

beforeAll(async () => {
  auth = NodeHttp.createServer((request, response) => {
    serveAuth(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
  const address = auth.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  issuer = `http://127.0.0.1:${address.port}/realms/workspace`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: ENVIRONMENT,
      LAZURIO_APP_E2E_NETWORK_MISSING: "true",
      LAZURIO_APP_E2E_AUTH_ISSUER: issuer,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  auth?.closeAllConnections();
  await new Promise<void>((resolve) => auth?.close(() => resolve()));
});

// Resolves with the address the app handed to the system's browser after the mark.
const handedToBrowser = (from: number): Promise<string> =>
  new Promise((resolve) => {
    const check = () => {
      const match = /lazurio-app-e2e system-browser (\S+)/u.exec(output.join("").slice(from));
      if (match?.[1] === undefined) return;
      app.process().stdout?.off("data", check);
      resolve(match[1]);
    };
    app.process().stdout?.on("data", check);
    check();
  });

// A screenshot of a local page, when the run asks for them.
const shot = async (page: import("playwright-core").Page, name: string) => {
  const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
  if (directory !== undefined && directory !== "") {
    await page.screenshot({ path: NodePath.join(directory, name) });
  }
};

// The bar at narrow and normal widths of the window: nothing wraps out of its 36 px, and the
// sentence keeps room to be read.
const fitsAtWidths = async (bar: import("playwright-core").Page, name: string) => {
  for (const width of [390, 600, 1280]) {
    await app.evaluate(({ BaseWindow }, wanted) => {
      const main = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      main?.setSize(wanted, 800);
    }, width);
    await bar.waitForFunction((wanted) => Math.abs(innerWidth - wanted) < 40, width);
    const fit = await bar.evaluate(() => ({
      height: document.querySelector(".agent-bar")?.scrollHeight ?? 0,
      text: document.querySelector(".agent-bar__text")?.clientWidth ?? 0,
    }));
    assert.isAtMost(fit.height, 36, `${name} at ${width} px`);
    assert.isAtLeast(fit.text, 120, `${name} at ${width} px`);
    await shot(bar, `${name}-${width}.png`);
  }
};

describe("Lazurio App GEN4 at a first start without the Organization's network", () => {
  it("offers the account's sign-in in the bar and in the Environment's place", async () => {
    const bar = await localPage(app, "view=agent-bar");
    const network = bar.locator('[data-agent-bar="network"][data-network-step="sign-in"]');
    await network.waitFor();
    assert.match(await network.innerText(), /not set up yet|zatím není nastavená/u);
    assert.strictEqual(await network.locator('[data-action="networks-sign-in"]').count(), 1);
    await fitsAtWidths(bar, "network-bar-sign-in");
    const page = await localPage(app, "problem=network");
    await page.locator('main[data-problem="network"]').waitFor();
    assert.match(
      await page.locator("main").innerText(),
      /Sign in with Lazurio|Přihlásit se účtem Lazurio/u,
    );
    assert.strictEqual(await page.locator('[data-action="networks-sign-in"]').count(), 1);
    await shot(page, "network-page-sign-in.png");
  });

  it("signs in through the browser and reads the networks with exactly the directory's scope", async () => {
    const bar = await localPage(app, "view=agent-bar");
    const from = output.join("").length;
    await bar.locator('[data-action="networks-sign-in"]').click();
    const address = await handedToBrowser(from);
    // While the sign-in waits, the bar says so, and its address can be copied for another browser.
    await bar.locator('[data-action="networks-copy-sign-in"]').waitFor();
    await fitsAtWidths(bar, "network-bar-signing-in");
    await bar.locator('[data-action="networks-copy-sign-in"]').click();
    await bar
      .locator('[data-action="networks-copy-sign-in"]', { hasText: /Copied|Zkopírováno/u })
      .waitFor();
    assert.strictEqual(await app.evaluate(({ clipboard }) => clipboard.readText()), address);
    // The person signs in in the system's browser, which comes back to the app's loopback.
    // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app and Effect.
    await fetch(address);
    // Auth's directory is out of reach: the bar says so and offers the read again.
    const notRead = bar.locator('[data-agent-bar="network"][data-network-step="not-read"]');
    await notRead.waitFor();
    assert.match(await notRead.innerText(), /could not be read|nepodařilo načíst/u);
    await shot(bar, "network-bar-not-read.png");
    // The attempt ended: nothing to copy any more.
    assert.strictEqual(await bar.locator('[data-action="networks-copy-sign-in"]').count(), 0);
    assert.strictEqual(signIns, 1);
    assert.deepStrictEqual(directoryReads, [{ scope: DIRECTORY_SCOPE, aud: DIRECTORY_SCOPE }]);
  });
});
