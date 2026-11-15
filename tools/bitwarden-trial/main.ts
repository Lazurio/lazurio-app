// The Bitwarden trial (issue #8, README.md): Bitwarden's Chromium build in Electron 44 with
// electron-chrome-extensions under the system's sandbox. It writes whether the service worker
// runs, the popup shows, the content scripts reach a sign-in form and what that page sees of
// the machinery to `<TRIAL_OUT>/result.json`. No request leaves loopback.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { app, BrowserWindow, session } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

const extensionDirectory = process.env["BITWARDEN_DIR"] ?? "";
const out = process.env["TRIAL_OUT"] ?? NodePath.join(process.cwd(), "out");
NodeFS.mkdirSync(out, { recursive: true });
// A profile of the trial's own: extensions load only into a persistent session.
app.setPath("userData", NodePath.join(out, "profile"));

const SIGN_IN_PAGE = `<!doctype html><html lang="en"><title>Sign in</title>
<form method="post" action="/signed-in">
<label>Email <input id="username" name="username" type="email" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form></html>`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms: number) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await wait(250);
    value = await read();
  }
  return value;
}

const local = (address: string) => {
  try {
    const url = new URL(address);
    if (["chrome-extension:", "devtools:", "data:", "blob:", "about:"].includes(url.protocol))
      return true;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
};

type PageView = {
  chrome: string;
  chromeRuntime: string;
  electron: string;
  ipcRenderer: string;
  require: string;
  process: string;
  frames: string[];
  shadowHosts: string[];
  marks: string[];
};

async function trial() {
  const trialSession = session.fromPartition("persist:bitwarden-trial");
  const refused: string[] = [];
  trialSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = local(details.url);
    if (!allowed && refused.length < 50) refused.push(new URL(details.url).origin);
    callback({ cancel: !allowed });
  });
  const workerConsole: string[] = [];
  trialSession.serviceWorkers.on("console-message", (_event, details) => {
    if (workerConsole.length < 200)
      workerConsole.push(`${String(details.level ?? "")} ${String(details.message).slice(0, 300)}`);
  });

  const extensions = new ElectronChromeExtensions({ session: trialSession });
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(extensionDirectory, "manifest.json"), "utf8"),
  ) as {
    action?: { default_popup?: string };
  };
  const extension = await trialSession.extensions.loadExtension(extensionDirectory);

  // 1. The service worker.
  const running = await until(
    () =>
      Object.values(trialSession.serviceWorkers.getAllRunning()).filter((worker) =>
        worker.scope.startsWith(`chrome-extension://${extension.id}/`),
      ),
    (workers) => workers.length > 0,
    30_000,
  );
  await wait(3_000);
  const webNavigationError = workerConsole.some((line) => line.includes("onCommitted"));

  // 3 and 4. A sign-in form on a page, as a remote view of the app has it.
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SIGN_IN_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const page = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { session: trialSession, sandbox: true, contextIsolation: true },
  });
  extensions.addTab(page.webContents, page);
  await page.loadURL(`http://127.0.0.1:${port}/`);
  await wait(3_000);
  await page.webContents.executeJavaScript(`document.getElementById("username").focus()`);
  await wait(3_000);
  const pageView = (await page.webContents.executeJavaScript(`(() => {
    const marks = [];
    for (const element of document.querySelectorAll("*")) {
      const text = [element.tagName, element.id, element.className, ...[...element.attributes].map((a) => a.name)].join(" ");
      if (/bit|bitwarden/i.test(text)) marks.push(text.slice(0, 120));
    }
    return {
      chrome: typeof globalThis.chrome,
      chromeRuntime: typeof globalThis.chrome?.runtime?.sendMessage,
      electron: typeof globalThis.electron,
      ipcRenderer: typeof globalThis.ipcRenderer,
      require: typeof globalThis.require,
      process: typeof globalThis.process,
      frames: [...document.querySelectorAll("iframe")].map((frame) => frame.src.slice(0, 120)),
      shadowHosts: [...document.querySelectorAll("*")].filter((element) => element.shadowRoot).map((element) => element.tagName),
      marks: marks.slice(0, 40),
    };
  })()`)) as PageView;
  NodeFS.writeFileSync(
    NodePath.join(out, "page.png"),
    (await page.webContents.capturePage()).toPNG(),
  );

  // 2. The popup, as an extension page.
  const popupPath = manifest.action?.default_popup ?? "popup/index.html";
  const popup = new BrowserWindow({
    width: 420,
    height: 640,
    webPreferences: { session: trialSession, sandbox: true, contextIsolation: true },
  });
  await popup.loadURL(`chrome-extension://${extension.id}/${popupPath}`);
  const popupText = await until(
    () =>
      popup.webContents.executeJavaScript(
        `document.body?.innerText?.trim()?.slice(0, 600) ?? ""`,
      ) as Promise<string>,
    (text) => text.length > 0,
    30_000,
  );
  const popupApis = (await popup.webContents.executeJavaScript(
    `Object.keys(globalThis.chrome ?? {}).sort()`,
  )) as string[];
  NodeFS.writeFileSync(
    NodePath.join(out, "popup.png"),
    (await popup.webContents.capturePage()).toPNG(),
  );
  server.close();

  const verdict = {
    serviceWorkerRuns: running.length > 0 && !webNavigationError,
    popupShows: popupText.length > 0,
    contentScriptsReachThePage:
      pageView.marks.length > 0 ||
      pageView.frames.some((src) => src.startsWith("chrome-extension://")) ||
      pageView.shadowHosts.length > 0,
    pageGetsNoMachinery:
      pageView.electron === "undefined" &&
      pageView.ipcRenderer === "undefined" &&
      pageView.require === "undefined" &&
      pageView.process === "undefined",
  };
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    extension: { id: extension.id, name: extension.name, version: extension.version },
    serviceWorker: {
      running: running.length > 0,
      webNavigationError,
      console: workerConsole.slice(0, 60),
    },
    page: pageView,
    popup: { path: popupPath, text: popupText, chromeApis: popupApis },
    refusedOrigins: [...new Set(refused)],
    verdict,
  };
}

app.enableSandbox();
void app.whenReady().then(async () => {
  let code = 1;
  try {
    const result = await trial();
    NodeFS.writeFileSync(NodePath.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result.verdict));
    const { verdict } = result;
    code = verdict.serviceWorkerRuns && verdict.popupShows && verdict.pageGetsNoMachinery ? 0 : 1;
  } catch (error) {
    NodeFS.writeFileSync(NodePath.join(out, "error.txt"), String((error as Error).stack ?? error));
    console.error(error);
  }
  app.exit(code);
});
