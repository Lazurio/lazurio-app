// The Bitwarden trial (issue #8, README.md): Bitwarden's Chromium build in Electron 44 with
// electron-chrome-extensions under the system's sandbox. It writes whether the service worker runs,
// the popup shows, the content scripts and autofill reach every frame of a sign-in page and what
// that page sees of the machinery to `<TRIAL_OUT>/result.json`. No request leaves loopback.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { app, BrowserWindow, session, type WebContents } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

const extensionDirectory = process.env["BITWARDEN_DIR"] ?? "";
const out = process.env["TRIAL_OUT"] ?? NodePath.join(process.cwd(), "out");
NodeFS.mkdirSync(out, { recursive: true });
// A fresh profile outside the artifact: extensions load only into a persistent session.
app.setPath("userData", NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bitwarden-trial-")));

const SIGN_IN_FORM = `<form method="post" action="/signed-in">
<label>Email <input id="username" name="username" type="email" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>`;
// A sign-in form on the page and one more in a frame of it, as an embedded sign-in has it.
const PAGES: Record<string, string> = {
  "/": `<!doctype html><html lang="en"><title>Sign in</title>${SIGN_IN_FORM}
<iframe src="/frame" title="Embedded sign-in" width="420" height="220"></iframe></html>`,
  "/frame": `<!doctype html><html lang="en"><title>Embedded sign-in</title>${SIGN_IN_FORM}</html>`,
};

// Read in each of Bitwarden's worlds: `bootstrap-autofill*.js` keeps its autofill there.
const AUTOFILL_PROBE = `({
  autofill: typeof globalThis.bitwardenAutofillInit,
  runtimeId: globalThis.chrome?.runtime?.id ?? null,
  forms: document.forms.length,
})`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const started = Date.now();
const step = (what: string) =>
  NodeFS.appendFileSync(NodePath.join(out, "steps.log"), `${Date.now() - started} ms ${what}\n`);

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
  chromeKeys: string[];
  chromeRuntime: string;
  electron: string;
  ipcRenderer: string;
  require: string;
  process: string;
};

type World = { origin: string; name: string; frameId: string };
type ContextCreated = {
  context: { id: number; origin: string; name: string; auxData?: { frameId?: string } };
};
type Frame = "page" | "frame";
type AutofillProbe = { autofill: string; runtimeId: string | null; forms: number };
type BitwardenWorld = AutofillProbe & { frame: Frame; name: string };
type Cdp = WebContents["debugger"];

// The page's JavaScript worlds as DevTools lists them; a content script runs in its extension's world.
function watchWorlds(cdp: Cdp) {
  const worlds = new Map<number, World>();
  cdp.on("message", (_event, method: string, params: unknown) => {
    if (method === "Runtime.executionContextCreated") {
      const { context } = params as ContextCreated;
      worlds.set(context.id, {
        origin: context.origin,
        name: context.name,
        frameId: context.auxData?.frameId ?? "",
      });
    } else if (method === "Runtime.executionContextDestroyed") {
      worlds.delete((params as { executionContextId: number }).executionContextId);
    } else if (method === "Runtime.executionContextsCleared") {
      worlds.clear();
    }
  });
  return worlds;
}

async function pageFrameId(cdp: Cdp) {
  const { frameTree } = (await cdp.sendCommand("Page.getFrameTree")) as {
    frameTree: { frame: { id: string }; childFrames?: unknown[] };
  };
  return { id: frameTree.frame.id, frames: 1 + (frameTree.childFrames?.length ?? 0) };
}

async function bitwardenWorlds(
  cdp: Cdp,
  worlds: Map<number, World>,
  extension: { id: string; name: string },
) {
  const page = await pageFrameId(cdp);
  const read = await Promise.all(
    [...worlds.entries()]
      .filter(
        ([, world]) =>
          world.origin.startsWith(`chrome-extension://${extension.id}`) ||
          world.name === extension.name,
      )
      .map(async ([contextId, world]): Promise<BitwardenWorld | undefined> => {
        try {
          const { result } = (await cdp.sendCommand("Runtime.evaluate", {
            contextId,
            returnByValue: true,
            expression: AUTOFILL_PROBE,
          })) as { result: { value: AutofillProbe } };
          const frame: Frame = world.frameId === page.id ? "page" : "frame";
          const { autofill, runtimeId, forms } = result.value;
          return { frame, name: world.name, autofill, runtimeId, forms };
        } catch {
          return undefined;
        }
      }),
  );
  return read.filter((world) => world !== undefined);
}

const autofillInEveryFrame = (worlds: BitwardenWorld[]) =>
  (["page", "frame"] as const).every((frame) =>
    worlds.some((world) => world.frame === frame && world.autofill === "object"),
  );

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
  step(`extension ${extension.id} loaded`);

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

  // 3 and 4. A sign-in page with a frame, as a remote view of the app has it.
  const server = NodeHttp.createServer((request, response) => {
    const body = PAGES[request.url ?? "/"];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body ?? "");
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
  step("page loaded");
  await page.webContents.executeJavaScript(`document.getElementById("username").focus()`);
  // DevTools after the load: it still lists every world, and the navigation cannot close it.
  const cdp = page.webContents.debugger;
  cdp.attach("1.3");
  const worlds = watchWorlds(cdp);
  await cdp.sendCommand("Runtime.enable");
  step(`devtools: ${worlds.size} worlds`);
  const bitwarden = await until(
    () => bitwardenWorlds(cdp, worlds, extension),
    autofillInEveryFrame,
    20_000,
  );
  step(`bitwarden worlds: ${JSON.stringify(bitwarden)}`);
  const frames = await pageFrameId(cdp);
  const everyWorld = [...worlds.values()].map((world) => ({
    origin: world.origin,
    name: world.name,
    frame: world.frameId === frames.id ? "page" : "frame",
  }));
  const pageView = (await page.webContents.executeJavaScript(`(() => ({
    chromeKeys: Object.keys(globalThis.chrome ?? {}).sort(),
    chromeRuntime: typeof globalThis.chrome?.runtime?.sendMessage,
    electron: typeof globalThis.electron,
    ipcRenderer: typeof globalThis.ipcRenderer,
    require: typeof globalThis.require,
    process: typeof globalThis.process,
  }))()`)) as PageView;
  NodeFS.writeFileSync(
    NodePath.join(out, "page.png"),
    (await page.webContents.capturePage()).toPNG(),
  );
  cdp.detach();

  // 2. The popup, as an extension page.
  const popupPath = manifest.action?.default_popup ?? "popup/index.html";
  const popup = new BrowserWindow({
    width: 420,
    height: 640,
    webPreferences: { session: trialSession, sandbox: true, contextIsolation: true },
  });
  await popup.loadURL(`chrome-extension://${extension.id}/${popupPath}`);
  step("popup loaded");
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
    contentScriptsRun: bitwarden.some((world) => world.frame === "page"),
    autofillInEveryFrame: autofillInEveryFrame(bitwarden),
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
      console: workerConsole.slice(0, 80),
    },
    page: { ...pageView, frames: frames.frames, bitwarden, worlds: everyWorld },
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
    code = Object.values(result.verdict).every(Boolean) ? 0 : 1;
  } catch (error) {
    NodeFS.writeFileSync(NodePath.join(out, "error.txt"), String((error as Error).stack ?? error));
    console.error(error);
  }
  step(`exit ${code}`);
  app.exit(code);
});
