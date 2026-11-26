// Trial only (lazurio-app#97): Bitwarden's own Chromium build in Electron 44 with
// electron-chrome-extensions, against a real Vaultwarden server with a real account (seed.ts). It
// points the extension at the server, signs in with the master password in the extension's popup,
// and checks that the extension fills the sign-in form of a page in a tab. Requests go only to
// loopback. Writes `<TRIAL_OUT>/result.json`, `steps.log` and screenshots.
// Environment: BITWARDEN_DIR, VAULT_SERVER, VAULT_EMAIL, VAULT_PASSWORD, ITEM_USER, ITEM_PASSWORD,
// PAGE_PORT, TRIAL_OUT; TRIAL_EXPLORE=1 only writes what the popup shows.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { app, BrowserWindow, session, type WebContents } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

const env = (name: string) => process.env[name] ?? "";
const out = env("TRIAL_OUT") || NodePath.join(process.cwd(), "out");
NodeFS.mkdirSync(out, { recursive: true });
app.setPath("userData", NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vault-trial-")));

const started = Date.now();
const step = (what: string) =>
  NodeFS.appendFileSync(NodePath.join(out, "steps.log"), `${Date.now() - started} ms ${what}\n`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms: number) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await wait(300);
    value = await read();
  }
  return value;
}

const SIGN_IN = `<!doctype html><html lang="en"><title>Sign in</title>
<form method="post" action="/signed-in">
<label>Username <input id="username" name="username" type="text" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form></html>`;

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

// What a page offers to click or fill, for exploring and for the log.
const CONTROLS = `(() => [...document.querySelectorAll("button, a, input, select, [role=button], [role=option], [role=menuitem]")]
  .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0)
  .slice(0, 80)
  .map((e) => [e.tagName.toLowerCase(), e.getAttribute("type") ?? "", e.getAttribute("formcontrolname") ?? e.getAttribute("name") ?? e.id ?? "", (e.getAttribute("aria-label") ?? e.innerText ?? e.value ?? "").trim().replace(/\\s+/g, " ").slice(0, 60)].join(" | ")))()`;

const text = (contents: WebContents) =>
  contents.executeJavaScript(`document.body?.innerText?.trim()?.replace(/\\s+/g, " ").slice(0, 900) ?? ""`) as Promise<string>;

async function trial() {
  const vault = session.fromPartition("persist:vault-trial");
  const refused: string[] = [];
  vault.webRequest.onBeforeRequest((details, callback) => {
    const allowed = local(details.url);
    if (!allowed && refused.length < 50) refused.push(new URL(details.url).origin);
    callback({ cancel: !allowed });
  });
  // The trial's Vaultwarden has a self-signed certificate on loopback; nothing else is trusted so.
  vault.setCertificateVerifyProc((request, callback) =>
    callback(["127.0.0.1", "localhost"].includes(request.hostname) ? 0 : -3),
  );
  // Windows the extension opens (its passkey popout uses chrome.windows.create).
  const extensionWindows: BrowserWindow[] = [];
  const extensions = new ElectronChromeExtensions({
    session: vault,
    createWindow: async (details) => {
      const window = new BrowserWindow({
        width: 420,
        height: 640,
        webPreferences: { session: vault, sandbox: true, contextIsolation: true },
      });
      extensionWindows.push(window);
      step(`extension window ${String(details.url ?? "").slice(0, 120)}`);
      const url = Array.isArray(details.url) ? details.url[0] : details.url;
      if (url) await window.loadURL(url.startsWith("chrome-extension:") || url.includes("://") ? url : `chrome-extension://${extensionId}/${url}`);
      return window;
    },
    createTab: async (details) => {
      const window = new BrowserWindow({ width: 1000, height: 760, webPreferences: { session: vault, sandbox: true, contextIsolation: true } });
      step(`extension tab ${String(details.url ?? "").slice(0, 120)}`);
      if (details.url) await window.loadURL(details.url);
      return [window.webContents, window];
    },
  });
  let extensionId = "";
  const extension = await vault.extensions.loadExtension(env("BITWARDEN_DIR"));
  extensionId = extension.id;
  step(`extension ${extension.id} ${extension.version}`);

  const server = NodeHttp.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/" ? SIGN_IN : "<p>signed in</p>");
  });
  await new Promise<void>((resolve) => server.listen(Number(env("PAGE_PORT")), "127.0.0.1", resolve));
  // A relying party for passkeys: WebAuthn wants a domain, so https://localhost with the trial's
  // loopback certificate.
  const PASSKEY_PAGE = `<!doctype html><html lang="en"><title>Passkey</title><p id="state">ready</p>
<script>
window.register = () => navigator.credentials.create({ publicKey: {
  rp: { id: "localhost", name: "Lazurio trial" },
  user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "trial-user", displayName: "Trial user" },
  challenge: crypto.getRandomValues(new Uint8Array(32)),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  timeout: 60000,
} }).then((c) => (window.created = { id: c.id, type: c.type, attachment: c.authenticatorAttachment ?? null }), (e) => (window.created = { error: e.name + ": " + e.message }));
window.signIn = () => navigator.credentials.get({ publicKey: {
  rpId: "localhost", challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "preferred", timeout: 60000,
} }).then((c) => (window.got = { id: c.id, type: c.type }), (e) => (window.got = { error: e.name + ": " + e.message }));
</script></html>`;
  const https = await import("node:https");
  const secure = https.createServer(
    {
      cert: NodeFS.readFileSync(NodePath.join(env("SSL_DIR") || "/work/ssl", "cert.pem")),
      key: NodeFS.readFileSync(NodePath.join(env("SSL_DIR") || "/work/ssl", "key.pem")),
    },
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PASSKEY_PAGE);
    },
  );
  await new Promise<void>((resolve) => secure.listen(Number(env("PASSKEY_PORT") || "18091"), "127.0.0.1", resolve));
  const page = new BrowserWindow({
    width: 1000,
    height: 760,
    webPreferences: { session: vault, sandbox: true, contextIsolation: true },
  });
  extensions.addTab(page.webContents, page);
  extensions.selectTab(page.webContents);
  await page.loadURL(`http://127.0.0.1:${env("PAGE_PORT")}/`);
  step("sign-in page loaded");

  const popup = new BrowserWindow({
    width: 420,
    height: 640,
    webPreferences: { session: vault, sandbox: true, contextIsolation: true },
  });
  await popup.loadURL(`chrome-extension://${extension.id}/popup/index.html`);
  await until(() => text(popup.webContents), (value) => value.length > 0, 30_000);
  await wait(2_000);
  const shot = async (name: string, contents: WebContents) =>
    NodeFS.writeFileSync(NodePath.join(out, `${name}.png`), (await contents.capturePage()).toPNG());
  // Clicks the visible control whose text or label is exactly `label`, or fills a field.
  const act = async (contents: WebContents, action: Record<string, string>) => {
    if (action["click"] !== undefined) {
      return contents.executeJavaScript(`(() => {
        const label = ${JSON.stringify(action["click"])};
        const all = [...document.querySelectorAll("button, a, [role=button], [role=option], [role=menuitem], li, span")];
        const hit = all.find((e) => (e.getClientRects().length > 0) && ((e.getAttribute("aria-label") ?? "").trim() === label || (e.innerText ?? "").trim() === label));
        if (!hit) return "no " + label;
        hit.click();
        return "clicked " + label;
      })()`);
    }
    if (action["fill"] !== undefined) {
      return contents.executeJavaScript(`(() => {
        const field = document.querySelector(${JSON.stringify(action["fill"])});
        if (!field) return "no field " + ${JSON.stringify(action["fill"])};
        field.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(field, ${JSON.stringify(action["value"] ?? "")});
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return "filled " + ${JSON.stringify(action["fill"])};
      })()`);
    }
    if (action["wait"] !== undefined) {
      await wait(Number(action["wait"]));
      return "waited";
    }
    return "unknown";
  };
  if (env("TRIAL_EXPLORE") === "1") {
    const trace: unknown[] = [];
    for (const action of JSON.parse(env("TRIAL_STEPS") || "[]") as Record<string, string>[]) {
      // Bitwarden closes its popup after it filled a page, as in Chrome.
      if (popup.isDestroyed()) {
        trace.push({ action, done: "popup closed" });
        continue;
      }
      const done = await act(popup.webContents, action);
      await wait(1_500);
      const now = popup.isDestroyed() ? "(popup closed)" : (await text(popup.webContents)).slice(0, 300);
      trace.push({ action, done, text: now });
    }
    NodeFS.writeFileSync(NodePath.join(out, "trace.json"), JSON.stringify(trace, null, 2));
    if (env("TRIAL_PASSKEY") === "1") {
      await page.loadURL(`https://localhost:${env("PASSKEY_PORT") || "18091"}/`);
      await wait(2_000);
      void page.webContents.executeJavaScript("window.register()", true);
      await until(() => extensionWindows.length, (n) => n > 0, 15_000);
      await wait(4_000);
      const popout = extensionWindows[0];
      const passkey: Record<string, unknown> = { windows: extensionWindows.length };
      if (popout && !popout.isDestroyed()) {
        passkey["popoutText"] = await text(popout.webContents);
        passkey["popoutControls"] = await popout.webContents.executeJavaScript(CONTROLS);
        await shot("passkey-popout", popout.webContents);
        for (const action of JSON.parse(env("PASSKEY_STEPS") || "[]") as Record<string, string>[]) {
          if (popout.isDestroyed()) break;
          passkey[`step ${JSON.stringify(action)}`] = await act(popout.webContents, action);
          await wait(2_000);
        }
      }
      await wait(3_000);
      passkey["created"] = await page.webContents.executeJavaScript("window.created ?? 'pending'");
      // Sign in with the passkey just saved: Bitwarden asks in a popout which one to use.
      const before = extensionWindows.length;
      void page.webContents.executeJavaScript("window.signIn()", true);
      await until(() => extensionWindows.length, (n) => n > before, 15_000);
      await wait(4_000);
      const chooser = extensionWindows[before];
      if (chooser && !chooser.isDestroyed()) {
        passkey["chooserText"] = await text(chooser.webContents);
        passkey["chooserControls"] = await chooser.webContents.executeJavaScript(CONTROLS);
        for (const action of JSON.parse(env("PASSKEY_GET_STEPS") || "[]") as Record<string, string>[]) {
          if (chooser.isDestroyed()) break;
          passkey[`get ${JSON.stringify(action)}`] = await act(chooser.webContents, action);
          await wait(2_000);
        }
      }
      await wait(3_000);
      passkey["got"] = await page.webContents.executeJavaScript("window.got ?? 'pending'");
      NodeFS.writeFileSync(NodePath.join(out, "passkey.json"), JSON.stringify(passkey, null, 2));
    }
    NodeFS.writeFileSync(
      NodePath.join(out, "page.json"),
      JSON.stringify(
        await page.webContents.executeJavaScript(`({
          username: document.getElementById("username")?.value ?? null,
          password: document.getElementById("password")?.value ?? null,
          extensionFrames: [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 60)),
          bitwardenElements: [...document.querySelectorAll("*")].filter((e) => e.tagName.includes("-")).map((e) => e.tagName.toLowerCase()).slice(0, 10),
        })`),
        null,
        2,
      ),
    );
    await shot("page", page.webContents);
    NodeFS.writeFileSync(
      NodePath.join(out, "explore.json"),
      JSON.stringify(
        popup.isDestroyed()
          ? { popup: "closed" }
          : {
              text: await text(popup.webContents),
              controls: await popup.webContents.executeJavaScript(CONTROLS),
              url: popup.webContents.getURL(),
            },
        null,
        2,
      ),
    );
    if (!popup.isDestroyed()) await shot("explore", popup.webContents);
    return { explore: true, refused };
  }
  return { refused };
}

app.whenReady().then(async () => {
  let result: unknown;
  try {
    result = await trial();
  } catch (error) {
    result = { fatal: String(error instanceof Error ? (error.stack ?? error.message) : error) };
  }
  NodeFS.writeFileSync(NodePath.join(out, "result.json"), JSON.stringify(result, null, 2));
  app.quit();
});
