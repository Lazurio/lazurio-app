// End-to-end: the built app with both helpers, and a hostile remote page (decision 0248: pages hold
// no power). Run with `pnpm --filter @lazurio/app-desktop test:e2e` after `pnpm build:helpers` and
// `pnpm --filter @lazurio/app-desktop build`; on Linux under a display (xvfb-run).
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server is the hostile page's host.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the built app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import {
  DEVICE_STATE_CHANGED_CHANNEL,
  STATUS_CHANGED_CHANNEL,
  type AppStatus,
  type DeviceStatus,
} from "../src/shared/bridge.ts";

import { localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const HOSTILE_PAGE = `<!doctype html><title>hostile</title><p id="hostile">hostile</p>`;

let server: NodeHttp.Server;
let remoteUrl: string;
let userData: string;
let app: ElectronApplication;
let shell: Page;
// The Agent Desktop window's page, once a test opened it.
let agentDesktop: Page;
const output: Array<string> = [];

beforeAll(async () => {
  server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(HOSTILE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  remoteUrl = `http://127.0.0.1:${address.port}/`;

  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--show-status"],
    // Playwright adds --no-sandbox on Linux unless told otherwise. CI configures the SUID sandbox
    // and sets LAZURIO_APP_E2E_OS_SANDBOX, so the operating system's sandbox is on there too.
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: remoteUrl,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  shell = await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// Resolves once the app has written the line to its standard output, including earlier output.
const outputLine = (line: string): Promise<void> =>
  new Promise((resolve) => {
    const check = () => {
      if (!output.join("").includes(line)) return;
      app.process().stdout?.off("data", check);
      resolve();
    };
    app.process().stdout?.on("data", check);
    check();
  });

// Runs a script in the remote page, from the main process, so the page cannot see the test. The
// remote view loads after the local window, so this waits for the page's own load event.
const inRemotePage = (script: string): Promise<unknown> =>
  app.evaluate(
    async ({ app: electronApp, webContents }, { url, code }) => {
      const loaded = (contents: Electron.WebContents) =>
        contents.getURL() === url && !contents.isLoading();
      const remote =
        webContents.getAllWebContents().find(loaded) ??
        (await new Promise<Electron.WebContents>((resolve) => {
          const watch = (contents: Electron.WebContents) =>
            contents.on("did-finish-load", () => {
              if (contents.getURL() !== url) return;
              electronApp.off("web-contents-created", onCreated);
              resolve(contents);
            });
          const onCreated = (_event: Electron.Event, contents: Electron.WebContents) =>
            watch(contents);
          electronApp.on("web-contents-created", onCreated);
          for (const contents of webContents.getAllWebContents()) watch(contents);
          // The page may have finished between the first look and the listeners.
          const ready = webContents.getAllWebContents().find(loaded);
          if (ready !== undefined) resolve(ready);
        }));
      return remote.executeJavaScript(code, true);
    },
    { url: remoteUrl, code: script },
  );

describe("Lazurio App GEN4", () => {
  it("shows its local window with both helpers past their handshake", async () => {
    assert.match(shell.url(), /^lazurio-app:\/\/shell\//u);
    await shell
      .locator('[data-helper="lazurio-tailnet"][data-state="ready"]')
      .waitFor({ state: "attached" });
    await shell
      .locator('[data-helper="lazurio-device"][data-state="ready"]')
      .waitFor({ state: "attached" });
  });

  it("gives its local window the bridge and nothing of Node", async () => {
    const globals = await shell.evaluate(() => [
      typeof window.lazurio,
      typeof Reflect.get(globalThis, "require"),
      typeof Reflect.get(globalThis, "process"),
    ]);
    assert.deepStrictEqual(globals, ["object", "undefined", "undefined"]);
  });

  it("gives a remote page no bridge, no Node and no Electron", async () => {
    const globals = await inRemotePage(
      `[typeof window.lazurio, typeof globalThis.require, typeof globalThis.process, typeof globalThis.electron]`,
    );
    assert.deepStrictEqual(globals, ["undefined", "undefined", "undefined", "undefined"]);
  });

  it("gives a remote page none of Agent Desktop, by any name", async () => {
    const reached = await inRemotePage(
      `[typeof window.lazurio?.device, typeof globalThis.ipcRenderer, Object.getOwnPropertyNames(window).filter((name) => /lazurio|ipc|electron/iu.test(name))]`,
    );
    assert.deepStrictEqual(reached, ["undefined", "undefined", []]);
  });

  it("shows Agent Desktop in its own window with only the calls the window needs", async () => {
    await shell.locator('[data-action="device-open-window"]').click();
    agentDesktop = await localPage(app, "view=agent-desktop");
    await agentDesktop.locator('[data-device-state="ready"]').waitFor();
    await agentDesktop.locator('[data-device-environments="none"]').waitFor();
    // The remote page is no Environment's Lazurio, so there is nothing to add.
    await agentDesktop.locator('[data-device-add="none"]').waitFor();
    assert.strictEqual(await agentDesktop.locator('[data-action="device-stop"]').count(), 0);
    const bridge = await agentDesktop.evaluate(async () => ({
      calls: Object.keys(window.lazurio.device).toSorted(),
      state: await window.lazurio.device.getState(),
    }));
    assert.deepStrictEqual(bridge, {
      calls: [
        "addEnvironment",
        "getState",
        "openWindow",
        "removeEnvironment",
        "setSwitch",
        "signOut",
        "stop",
        "subscribe",
      ],
      state: {
        state: "ready",
        environments: [],
        agent: null,
        account: "signed-out",
        switches: [],
        addable: null,
      },
    });
  });

  it("offers Stop while an agent works, and Stop reaches the Device helper", async () => {
    const working: DeviceStatus = {
      state: "ready",
      environments: [
        {
          environmentId: "e2e",
          label: "E2E",
          channel: { state: "working", tool: "click", application: "Outlook" },
        },
      ],
      agent: { environmentId: "e2e", label: "E2E" },
      account: "signed-out",
      switches: [],
      addable: null,
    };
    await app.evaluate(
      ({ webContents }, { channel, status }) => {
        for (const contents of webContents.getAllWebContents())
          if (contents.getURL().startsWith("lazurio-app:")) contents.send(channel, status);
      },
      { channel: DEVICE_STATE_CHANGED_CHANNEL, status: working },
    );
    await agentDesktop.locator('[data-device-agent="e2e"]').waitFor();
    // The helper answers Stop with who holds the computer, and the window follows its answer.
    await agentDesktop.locator('[data-action="device-stop"]').click();
    await agentDesktop.locator('[data-action="device-stop"]').waitFor({ state: "detached" });
    assert.strictEqual(
      await agentDesktop.locator('[data-device-problem="stop-failed"]').count(),
      0,
    );
  });

  // After the tests of Agent Desktop's other states: it ends the Device helper.
  it("says in its local window that the agent's state is unknown once the Device helper is gone", async () => {
    const pid: unknown = await app.evaluate(() =>
      Reflect.get(Reflect.get(globalThis, "lazurioAppE2eHelperPids") ?? {}, "lazurio-device"),
    );
    if (typeof pid !== "number") return assert.fail("the app named no PID of its Device helper");
    // The column is hidden before the helper is lost without confirming that its engines ended.
    await shell.evaluate(() => window.lazurio.setStatusPanel(false));
    process.kill(pid, "SIGKILL");
    const problem = agentDesktop.locator('[data-device-state="lost"] [data-device-problem="lost"]');
    await problem.waitFor();
    // The unconfirmed state opens the column, keeps it and the window in view, and Hide is off.
    const inView = () =>
      app.evaluate(({ BaseWindow }) => {
        const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
        const local = window?.contentView.children[0];
        return window?.isVisible() === true && local?.getVisible() === true;
      });
    assert.isTrue(await inView());
    assert.isTrue(await shell.locator('[data-action="status-hide"]').isDisabled());
    await shell.evaluate(() => window.lazurio.setStatusPanel(false));
    // Hidden, the window shows again; one that never does fails the test by its timeout.
    const shownAgain = await app.evaluate(async ({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows().find((each) => each.getParentWindow() === null);
      if (window === undefined) return false;
      await new Promise<void>((resolve) => {
        window.once("show", () => resolve());
        window.hide();
      });
      return window.isVisible();
    });
    assert.isTrue(shownAgain);
    assert.isTrue(await inView());
    assert.match(await problem.innerText(), /not known whether|nevíme, jestli/iu);
    assert.strictEqual(await agentDesktop.locator('[data-action="device-stop"]').count(), 0);
    // The updates' section knows that an install would wait for the helper.
    await shell.locator('[data-updates-device="unreachable"]').waitFor();
    const state = await shell.evaluate(() => window.lazurio.device.getState());
    assert.deepStrictEqual(state, {
      state: "lost",
      environments: [],
      agent: "unknown",
      account: "signed-out",
      switches: [],
      addable: null,
    });
    // Stop answers at once instead of waiting for a helper that cannot be reached.
    const stopped = await shell.evaluate(() =>
      window.lazurio.device.stop().then(
        () => "answered",
        () => "refused",
      ),
    );
    assert.strictEqual(stopped, "refused");
  });

  it("lets a remote page open no window and get no permission", async () => {
    const opened = await inRemotePage(`window.open("https://example.com/") === null`);
    assert.isTrue(opened);
    const permission = await inRemotePage(`Notification.requestPermission()`);
    assert.strictEqual(permission, "denied");
  });

  it("keeps foreign pages out of a remote page's frames, also loaded directly", async () => {
    const refused = outputLine("lazurio-app-e2e refused sub https://example.com/framed");
    await inRemotePage(
      `(() => { const frame = document.createElement("iframe"); frame.src = "https://example.com/framed"; document.body.append(frame); return true; })()`,
    );
    await refused;
    const frames = await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
          ?.mainFrame.framesInSubtree.map((frame) => frame.url) ?? [],
      remoteUrl,
    );
    assert.isFalse(frames.some((frame) => frame.startsWith("https://example.com")));
    assert.isFalse(output.join("").includes("system-browser https://example.com/framed"));
  });

  it("keeps a remote page where it is and hands the web to the system's browser", async () => {
    const handedOver = outputLine("lazurio-app-e2e system-browser https://example.com/elsewhere");
    await inRemotePage(`location.href = "https://example.com/elsewhere"; true`);
    await handedOver;
    await inRemotePage(`location.href = "file:///etc/passwd"; true`);
    const url = await inRemotePage(`location.href`);
    assert.strictEqual(url, remoteUrl);
  });

  // Last: it replaces what the window shows.
  it("shows every later change of status in its local window", async () => {
    const changed: AppStatus = {
      appVersion: "0.0.0",
      generation: "GEN4",
      helpers: [],
      tailnets: [{ tailnet: "e2e", state: "running", addresses: ["100.64.0.1"] }],
      networkMissing: false,
      updates: { channel: "latest", state: { phase: "off", reason: "unpackaged" } },
    };
    await app.evaluate(
      ({ webContents }, { channel, status }) => {
        for (const contents of webContents.getAllWebContents())
          if (contents.getURL().startsWith("lazurio-app:")) contents.send(channel, status);
      },
      { channel: STATUS_CHANGED_CHANNEL, status: changed },
    );
    await shell.locator('[data-tailnet="e2e"][data-state="running"]').waitFor();
    // The node's address is under the technical details, not in the network's row.
    assert.strictEqual(
      await shell
        .locator('[data-tailnet="e2e"]')
        .innerText()
        .then((row) => row.includes("100.64")),
      false,
    );
    await shell.locator('[data-tailnet-addresses="e2e"]').waitFor({ state: "attached" });

    // A stable build without the Organization's network says so instead of joining another one.
    await app.evaluate(
      ({ webContents }, { channel, status }) => {
        for (const contents of webContents.getAllWebContents())
          if (contents.getURL().startsWith("lazurio-app:")) contents.send(channel, status);
      },
      {
        channel: STATUS_CHANGED_CHANNEL,
        status: { ...changed, tailnets: [], networkMissing: true },
      },
    );
    const missing = shell.locator("[data-network-missing]");
    await missing.waitFor();
    assert.match(await missing.innerText(), /not set up yet|zatím není nastavená/u);
  });
});
