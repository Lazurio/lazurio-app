// End-to-end: Agent Desktop's switch in its window (docs/adr/0006, contract v3 in the app), which
// --show-agent-desktop opens at the start, as a coordinator does over SSH.
// The person adds the Environment the main window shows, turns its switch on, signs in in the
// "system's browser" (the test follows the address the app hands over), and the app gives the
// Device helper a hand-over from Lazurio Auth. A fake Lazurio Auth on the loopback, a fake Device
// helper (src/main/fake-device-helper.ts, "v3") and a local HTTPS server for the Environment's
// Lazurio play the rest; --host-resolver-rules and --ignore-certificate-errors are this test's, not
// the app's. Nothing reaches the network.
// @effect-diagnostics-next-line nodeBuiltinImport:off - Plain HTTP and HTTPS servers play Lazurio Auth and the Environment.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server plays the Environment's Lazurio.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its fixture on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { COLUMN_PAGE, localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const ENVIRONMENT_HOST = "launchpad.e2e.lazurio.io";
const ENVIRONMENT = `https://${ENVIRONMENT_HOST}`;

let launchpad: NodeHttps.Server;
let auth: NodeHttp.Server;
let issuer: string;
let userData: string;
let app: ElectronApplication;
let shell: Page;
// The main window's status column, hidden unless shown.
let column: Page;
let launchpadPort = 0;
const output: Array<string> = [];
// What the fake Lazurio Auth saw: each hand-over's origin, and each hand-over it gave.
const handOverOrigins: Array<string> = [];
const handOversGiven: Array<string> = [];
let signIns = 0;

const randomPart = (bytes: number): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const readBody = (request: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

// The nonce of each authorization, by its code, for the ID token the code buys.
const nonces = new Map<string, string>();
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
// An unsigned ID token: the app takes it straight from the token endpoint over TLS, so it checks
// its claims, not a signature (AuthClient).
const idToken = (nonce: string) => {
  return [
    segment({ alg: "none", typ: "JWT" }),
    segment({
      iss: issuer,
      aud: "lazurio-app",
      azp: "lazurio-app",
      sub: "e2e-person",
      nonce,
      // Fixed: issued in the past and valid far ahead, whatever the runner's clock says.
      iat: 1_600_000_000,
      exp: 4_102_444_800,
    }),
    "",
  ].join(".");
};

// An unsigned access token as Auth narrows it: a refresh with exactly scope=lazurio-device-entry
// answers that scope and its one audience (HumanAndMachine-ai/Auth docs/device-channel-entry.md).
const accessToken = (scope: string) =>
  [
    segment({ alg: "none", typ: "JWT" }),
    segment({
      iss: issuer,
      aud: scope === "lazurio-device-entry" ? "lazurio-device-entry" : "account",
      azp: "lazurio-app",
      sub: "e2e-person",
      scope,
      iat: 1_600_000_000,
      exp: 4_102_444_800,
    }),
    "",
  ].join(".");
// Check 2 of device-hand-over: exactly the scope lazurio-device-entry and its one audience.
const takesHandOver = (authorization: string | undefined) => {
  const token = (authorization ?? "").replace(/^Bearer /u, "");
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      readonly scope?: string;
      readonly aud?: string;
    };
    return claims.scope === "lazurio-device-entry" && claims.aud === "lazurio-device-entry";
  } catch {
    return false;
  }
};

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

// Lazurio Auth for the app's public client: discovery, the authorization's redirect, the token
// endpoint, revocation and the Device hand-over.
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
      const code = `code-${randomPart(8)}`;
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
      return json(response, 200, {
        ...(form.get("grant_type") === "authorization_code" && nonce !== undefined
          ? { id_token: idToken(nonce) }
          : {}),
        access_token: accessToken(form.get("scope") ?? "openid lazurio-device-entry"),
        token_type: "Bearer",
        expires_in: 300,
        refresh_token: `refresh-${randomPart(16)}`,
        scope: form.get("scope") ?? "openid lazurio-device-entry",
        grant: form.get("grant_type"),
      });
    }
    case "POST /protocol/openid-connect/revoke":
      response.writeHead(200);
      response.end();
      return;
    case "POST /lazurio-agent-entry/device-hand-over": {
      if (!takesHandOver(request.headers.authorization)) {
        return json(response, 401, { error: "unauthorized" });
      }
      const origin = (JSON.parse(body) as { readonly origin?: string }).origin ?? "";
      handOverOrigins.push(origin);
      if (origin !== ENVIRONMENT) return json(response, 404, {});
      const handOver = randomPart(32);
      handOversGiven.push(handOver);
      return json(response, 200, { handOver, expiresIn: 60 });
    }
    default:
      response.writeHead(404);
      response.end();
  }
};

const launch = async (fakeHelperSettings: Record<string, string> = {}) => {
  output.length = 0;
  const rules = [`MAP ${ENVIRONMENT_HOST} 127.0.0.1:${launchpadPort}`, "MAP * ~NOTFOUND"];
  app = await _electron.launch({
    args: [
      NodePath.resolve(import.meta.dirname, ".."),
      "--show-agent-desktop",
      `--host-resolver-rules=${rules.join(", ")}`,
      "--ignore-certificate-errors",
    ],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: `${ENVIRONMENT}/settings/tools`,
      LAZURIO_APP_E2E_NODE: process.execPath,
      LAZURIO_APP_E2E_DEVICE_HELPER: NodePath.resolve(
        import.meta.dirname,
        "..",
        "src",
        "main",
        "fake-device-helper.ts",
      ),
      LAZURIO_APP_E2E_AUTH_ISSUER: issuer,
      // The first start connects; the second ends at once and needs a new hand-over, whose start
      // is refused because the utility is paired.
      LAZURIO_FAKE_DEVICE_OUTCOMES: "connected,needs-hand-over,refused:agent_desktop_paired",
      ...fakeHelperSettings,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  await app.firstWindow();
  // Every switch lives in the Agent Desktop window, which --show-agent-desktop opens before the
  // column: the column is found by its address.
  shell = await localPage(app, "view=agent-desktop");
  column =
    app.windows().find((page) => page.url() === COLUMN_PAGE) ??
    (await app.waitForEvent("window", { predicate: (page) => page.url() === COLUMN_PAGE }));
};

beforeAll(async () => {
  const { cert, key } = selfSigned([ENVIRONMENT_HOST]);
  launchpad = NodeHttps.createServer({ cert, key }, (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Launchpad</title><p id="launchpad">launchpad</p>`);
  });
  await new Promise<void>((resolve) => launchpad.listen(0, "127.0.0.1", resolve));
  const launchpadAddress = launchpad.address();
  if (launchpadAddress === null || typeof launchpadAddress === "string") throw new Error("no port");
  launchpadPort = launchpadAddress.port;

  auth = NodeHttp.createServer((request, response) => {
    serveAuth(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
  const authAddress = auth.address();
  if (authAddress === null || typeof authAddress === "string") throw new Error("no port");
  issuer = `http://127.0.0.1:${authAddress.port}/realms/workspace`;

  userData = temporaryUserData();
  await launch();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  for (const server of [launchpad, auth]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

// Resolves with the address the app handed to the system's browser after the given mark.
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
const mark = () => output.join("").length;

const environmentRow = () => shell.locator(`[data-device-switch="${ENVIRONMENT}"]`);
const inPhase = (phase: string, state?: string) =>
  shell
    .locator(
      `[data-device-switch="${ENVIRONMENT}"][data-switch-phase="${phase}"]${
        state === undefined ? "" : `[data-state="${state}"]`
      }`,
    )
    .waitFor();
const section = () => shell.locator('section[data-device-state="ready"]');

// Runs a script in the remote view's page, from the main process, once it shows the Environment.
const inRemotePage = (script: string): Promise<unknown> =>
  app.evaluate(async ({ BaseWindow }, code) => {
    const view = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children.slice(1))
      .find((child): child is Electron.WebContentsView => "webContents" in child);
    if (view === undefined) throw new Error("no remote view");
    const contents = view.webContents;
    if (contents.isLoading() || contents.getURL() === "") {
      await new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve()));
    }
    return contents.executeJavaScript(code, true);
  }, script);

const screenshot = async (name: string) => {
  const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
  if (directory === undefined || directory === "") return;
  await shell
    .locator("section[data-device-state]")
    .screenshot({ path: NodePath.join(directory, name) });
};

describe("Agent Desktop's switch", () => {
  it("offers to add the Environment the main window shows, signed out and with no switch", async () => {
    await section().waitFor();
    await shell.locator('[data-device-account="signed-out"]').waitFor();
    await shell.locator(`[data-device-add="${ENVIRONMENT}"]`).waitFor();
    await shell.locator('[data-device-environments="none"]').waitFor();
    const calls = await shell.evaluate(() => Object.keys(window.lazurio.device).toSorted());
    assert.deepStrictEqual(calls, [
      "addEnvironment",
      "getState",
      "openWindow",
      "removeEnvironment",
      "setSwitch",
      "signOut",
      "stop",
      "subscribe",
    ]);
  });

  it("gives the Environment's page no way to the switches", async () => {
    const reached = await inRemotePage(
      `[location.origin, typeof window.lazurio, typeof globalThis.ipcRenderer, typeof globalThis.require, Object.getOwnPropertyNames(window).filter((name) => /lazurio|ipc|electron/iu.test(name))]`,
    );
    assert.deepStrictEqual(reached, [ENVIRONMENT, "undefined", "undefined", "undefined", []]);
  });

  it("adds the Environment with its switch off", async () => {
    await shell.locator('[data-action="device-add"]').click();
    await inPhase("off", "off");
    assert.strictEqual(await shell.locator("[data-device-add]").count(), 0);
    assert.strictEqual(await environmentRow().locator("[data-switch-problem]").count(), 0);
    // An Off switch says what turning it on does.
    assert.match(
      await environmentRow().locator("[data-switch-hint]").innerText(),
      /no agent from this Environment|agent z tohoto Prostředí/u,
    );
  });

  it("signs in in the browser when the switch goes on, then starts the channel with a hand-over", async () => {
    const from = mark();
    await environmentRow().locator('[data-action="device-switch"]').click();
    await inPhase("signing-in");
    // The system's browser: it follows Lazurio Auth's redirect back to the app's loopback.
    const address = await handedToBrowser(from);
    assert.isTrue(address.startsWith(`${issuer}/protocol/openid-connect/auth?`));
    // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app and Effect.
    const back = await fetch(address);
    assert.strictEqual(back.status, 200);
    await inPhase("channel", "connected");
    await shell.locator('[data-device-account="signed-in"]').waitFor();
    assert.strictEqual(signIns, 1);
    assert.deepStrictEqual(handOverOrigins, [ENVIRONMENT]);
    assert.isTrue(await environmentRow().locator('[data-action="device-switch"]').isChecked());
    // The hand-over reaches neither the window's state nor the app's output.
    const state = JSON.stringify(await shell.evaluate(() => window.lazurio.device.getState()));
    for (const handOver of handOversGiven) {
      assert.notInclude(state, handOver);
      assert.notInclude(output.join(""), handOver);
    }
    await screenshot("integration-section.png");
  });

  it("stops the channel when the switch goes off", async () => {
    await environmentRow().locator('[data-action="device-switch"]').click();
    await inPhase("off", "off");
    assert.isFalse(await environmentRow().locator('[data-action="device-switch"]').isChecked());
  });

  it("asks for a new hand-over after NeedsHandOver, and goes off with the reason after Refused", async () => {
    await environmentRow().locator('[data-action="device-switch"]').click();
    // The app also sends StopChannel, so the helper forgets the channel; the reason stays with the
    // switch.
    await environmentRow().locator("[data-switch-problem]").waitFor();
    await inPhase("off", "off");
    // No second sign-in: the session from before still holds.
    assert.strictEqual(signIns, 1);
    assert.deepStrictEqual(handOverOrigins, [ENVIRONMENT, ENVIRONMENT, ENVIRONMENT]);
    const problem = await environmentRow().locator("[data-switch-problem]").innerText();
    assert.match(problem, /uninstall it|utilitu odinstalujte/u);
    assert.match(problem, /io\.lazurio\.agent-desktop/u);
    await screenshot("integration-section-refused.png");
  });

  it("signs out of the app's Lazurio account", async () => {
    await shell.locator('[data-action="device-sign-out"]').click();
    await shell.locator('[data-device-account="signed-out"]').waitFor();
    await inPhase("off");
  });

  // Last: it restarts the app.
  it("keeps the added Environment across a restart, with its switch off", async () => {
    await app.close();
    await launch();
    await section().waitFor();
    await inPhase("off", "off");
    assert.strictEqual(await environmentRow().locator("[data-switch-problem]").count(), 0);
    assert.strictEqual(await shell.locator("[data-device-add]").count(), 0);
    await environmentRow().locator('[data-action="device-remove"]').click();
    await shell.locator('[data-device-environments="none"]').waitFor();
    await shell.locator(`[data-device-add="${ENVIRONMENT}"]`).waitFor();
  });

  // Hides or minimizes the window and waits until it shows again ("show" after a hide, "restore"
  // after a minimize). The listener is in place before the action: on Windows the app restores
  // the window from within the minimize. A window that never comes back fails by the timeout.
  const backInView = (how: "hide" | "minimize") =>
    app.evaluate(async ({ BaseWindow }, action) => {
      const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      if (window === undefined) return false;
      await new Promise<void>((resolve) => {
        if (action === "hide") {
          window.once("show", () => resolve());
          window.hide();
        } else {
          window.once("restore", () => resolve());
          window.minimize();
        }
      });
      return window.isVisible() && !window.isMinimized();
    }, how);

  // It restarts the app with an agent that works as soon as its channel opens: the bar with Stop
  // shows over the page while the work lasts, and a status column opened meanwhile stays
  // (docs/adr/0006: Stop is never hidden while an agent works).
  it("shows the bar with Stop and keeps the status column in view while an agent works", async () => {
    await app.close();
    await launch({ LAZURIO_FAKE_DEVICE_OUTCOMES: "working" });
    await shell.locator('[data-action="device-add"]').click();
    const from = mark();
    await environmentRow().locator('[data-action="device-switch"]').click();
    // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app and Effect.
    await fetch(await handedToBrowser(from));
    await inPhase("channel", "working");
    const bar = await localPage(app, "view=agent-bar");
    await bar.locator('[data-action="device-stop"]').waitFor();
    const columnShown = () =>
      app.evaluate(({ BaseWindow }) => {
        const local = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null)
          ?.contentView.children[0];
        return local?.getVisible() === true && (local?.getBounds().width ?? 0) > 0;
      });
    // The column opens by itself and stays (the safety net of #61), and the bar says that an agent
    // works, with Stop.
    assert.isTrue(await columnShown());
    // Opened while an agent works, it stays: neither Hide nor View → App status hides it.
    await column.evaluate(() => window.lazurio.setStatusPanel(true));
    await column.evaluate(() => window.lazurio.status());
    assert.isTrue(await columnShown());
    assert.isTrue(await column.locator('[data-action="status-hide"]').isDisabled());
    await column.evaluate(() => window.lazurio.setStatusPanel(false));
    assert.isTrue(await columnShown());
    await app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []);
      items?.find((item) => item.accelerator === "CmdOrCtrl+Shift+D")?.click();
    });
    await column.evaluate(() => window.lazurio.status());
    assert.isTrue(await columnShown());
    // Closing the window, as with its X, keeps it shown while the agent works.
    const shownAfterClose = await app.evaluate(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      window?.close();
      return window?.isVisible() === true;
    });
    assert.isTrue(shownAfterClose);
    assert.isTrue(await columnShown());
    // Hidden or minimized while the agent works, it shows again. Under Xvfb no window manager
    // minimizes a window, so Linux checks the hide only; Windows and macOS check both.
    assert.isTrue(await backInView("hide"));
    const linux = (await shell.evaluate(() => navigator.platform)).startsWith("Linux");
    if (!linux) assert.isTrue(await backInView("minimize"));
    // Once the work ends, the bar goes and Hide works again.
    await environmentRow().locator('[data-action="device-switch"]').click();
    await inPhase("off");
    await bar.locator('[data-agent-bar="none"]').waitFor();
    await column.locator('[data-action="status-hide"]:not([disabled])').click();
    await column.evaluate(() => window.lazurio.status());
    assert.isFalse(await columnShown());
    await environmentRow().locator('[data-action="device-remove"]').click();
    await shell.locator('[data-device-environments="none"]').waitFor();
    // The next test signs in again.
    await shell.locator('[data-action="device-sign-out"]').click();
    await shell.locator('[data-device-account="signed-out"]').waitFor();
  });

  // Last: it restarts the app with a Device helper that never answers StopChannel.
  it("ends the Device helper when it does not confirm a switch's stop, and says Off only then", async () => {
    await app.close();
    await launch({ LAZURIO_FAKE_DEVICE_STOP: "silent" });
    await shell.locator('[data-action="device-add"]').click();
    const from = mark();
    await environmentRow().locator('[data-action="device-switch"]').click();
    // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app and Effect.
    await fetch(await handedToBrowser(from));
    await inPhase("channel", "connected");
    const pid: unknown = await app.evaluate(() =>
      Reflect.get(Reflect.get(globalThis, "lazurioAppE2eHelperPids") ?? {}, "lazurio-device"),
    );
    if (typeof pid !== "number") return assert.fail("the app named no PID of its Device helper");

    await environmentRow().locator('[data-action="device-switch"]').click();
    await inPhase("stopping");
    // Until the helper's end is confirmed, the switch never says Off and takes no click.
    assert.isTrue(await environmentRow().locator('[data-action="device-switch"]').isDisabled());
    await environmentRow().locator("[data-switch-problem]").waitFor();
    await inPhase("off");
    assert.isFalse(isAlive(pid));
    const problem = await environmentRow().locator("[data-switch-problem]").innerText();
    assert.match(problem, /did not confirm|nepotvrdil/u);
    // The helper cannot be reached any more; it confirmed that every agent's work ended.
    await shell
      .locator('[data-device-state="lost"] [data-device-problem="lost-confirmed"]')
      .waitFor();
    assert.strictEqual(await shell.locator('[data-action="device-stop"]').count(), 0);
    await screenshot("stop-not-confirmed.png");
  });
});

// Signal 0 checks that the process exists and ends nothing.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
