// End-to-end: a build with only the built-in list whose network runs (Lazurio Example on a Mac or a
// nightly). Neither the bar nor the status column says that the network is not set up or offers
// to sign in "again": both offer the sign-in that brings the person's own networks, and the column
// lists the running network. The fake tailnet helper (e2e/fake-tailnet-helper.ts) runs it.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the page and the helper's cue.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its fixture on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { columnPage, localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;

beforeAll(async () => {
  // The page, and the helper's cue to report the network running, at once.
  server = NodeHttp.createServer((request, response) => {
    if (request.url === "/running") return response.end();
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>page</title><p>page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  const origin = `http://127.0.0.1:${address.port}`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--show-status"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `${origin}/`,
      // Only the built-in list: the source a Mac or a nightly has before the account's sign-in.
      LAZURIO_APP_E2E_NETWORK_MISSING: "true",
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_TAILNET_HELPER: NodePath.resolve(
        import.meta.dirname,
        "fake-tailnet-helper.ts",
      ),
      LAZURIO_FAKE_RUNNING_URL: `${origin}/running`,
      LAZURIO_APP_DEV_TAILNETS: JSON.stringify([
        {
          tailnet: "example",
          controlUrl: "https://headscale.example.lazurio.invalid",
          hostname: "e2e-app",
          domains: ["example.lazurio.invalid"],
        },
      ]),
    },
  });
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("Lazurio App GEN4 with only the built-in network, running", () => {
  it("offers the sign-in for the person's own networks in the bar and the status column", async () => {
    const shell = await columnPage(app);
    await shell.locator('[data-tailnet="example"][data-state="running"]').waitFor({
      state: "attached",
    });
    const bar = await localPage(app, "view=agent-bar");
    const network = bar.locator('[data-agent-bar="network"][data-network-step="sign-in"]');
    await network.waitFor();
    assert.match(
      await network.innerText(),
      /so the app knows your Organizations' networks|ať aplikace zná sítě vašich Organizací/u,
    );
    assert.notMatch(await network.innerText(), /not set up|není nastavená|again|znovu/u);
    // The column: the same sentence and button, the running network, and no "not set up".
    const signIn = shell.locator("[data-networks-sign-in]");
    const words = await signIn.evaluate((element) => element.textContent ?? "");
    assert.match(
      words,
      /so the app knows your Organizations' networks|ať aplikace zná sítě vašich Organizací/u,
    );
    assert.match(words, /Sign in with Lazurio|Přihlásit se účtem Lazurio/u);
    assert.notMatch(words, /again|znovu/u);
    assert.strictEqual(await shell.locator("[data-network-missing]").count(), 0);
  });
});
