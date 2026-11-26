// WebAuthn probe for Lazurio App's base (lazurio-app#97): what stock Electron offers a page for
// passkeys on this computer. It opens the public WebAuthn demo https://webauthn.io (a real relying
// party), asks what the platform reports, and tries one registration with a platform authenticator
// and one with a roaming one, each with a 20 s timeout. It never completes a credential on its own:
// nobody touches the sensor, so a call that shows a system dialog ends by timeout. The results go to
// a JSON file; on Windows a screenshot shows whether Windows Hello's dialog appeared.
// Usage: electron main.js --out=<file> [--mode=stock|touchid] [--shots=<dir>]
const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = arg("out", "webauthn-result.json");
const mode = arg("mode", "stock");
const shots = arg("shots", "");

const results = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
  mode,
  configureWebAuthn: typeof app.configureWebAuthn,
  events: [],
};
const save = () => fs.writeFileSync(out, JSON.stringify(results, null, 2));

if (mode === "touchid") {
  try {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: "XXXXXXXXXX.io.lazurio.probe.webauthn" } });
    results.configured = "ok";
  } catch (error) {
    results.configured = `error: ${error.message}`;
  }
}

const shoot = async (name) => {
  if (!shots || process.platform !== "win32") return;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1600, height: 1000 },
    });
    if (sources[0]) fs.writeFileSync(path.join(shots, `${name}.png`), sources[0].thumbnail.toPNG());
  } catch (error) {
    results.events.push({ shot: name, error: error.message });
  }
};

const create = (attachment) => `(async () => {
  const t0 = Date.now();
  try {
    const credential = await Promise.race([
      navigator.credentials.create({ publicKey: {
        rp: { name: "Lazurio probe" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "probe", displayName: "probe" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        timeout: 20000,
        authenticatorSelection: { authenticatorAttachment: ${JSON.stringify(attachment)}, userVerification: "preferred", residentKey: "preferred" },
      } }),
      new Promise((resolve) => setTimeout(() => resolve("still pending after 30 s"), 30000)),
    ]);
    return { ms: Date.now() - t0, result: typeof credential === "string" ? credential : "credential " + credential.type };
  } catch (error) {
    return { ms: Date.now() - t0, error: error.name + ": " + error.message };
  }
})()`;

app.whenReady().then(async () => {
  session.defaultSession.on("select-webauthn-account", (_event, _details, callback) => {
    results.events.push({ event: "select-webauthn-account" });
    callback();
  });
  const win = new BrowserWindow({ width: 1000, height: 760, show: true });
  try {
    // A static page of the same origin: the demo page itself starts a conditional request on load.
    await win.loadURL("https://webauthn.io/robots.txt");
    const js = (code) => win.webContents.executeJavaScript(code, true);
    results.secureContext = await js("window.isSecureContext");
    results.publicKeyCredential = await js("typeof PublicKeyCredential");
    results.uvpaa = await js("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()");
    results.conditionalMediation = await js(
      "PublicKeyCredential.isConditionalMediationAvailable ? PublicKeyCredential.isConditionalMediationAvailable() : 'n/a'",
    );
    results.clientCapabilities = await js(
      "PublicKeyCredential.getClientCapabilities ? PublicKeyCredential.getClientCapabilities() : 'n/a'",
    );
    save();
    for (const attachment of ["platform", "cross-platform"]) {
      // A fresh page for each attempt: a request that never ends would block the next one.
      await win.loadURL("https://webauthn.io/robots.txt");
      const pending = js(create(attachment));
      setTimeout(() => void shoot(`${attachment}-at-5s`), 5000);
      results[`create_${attachment}`] = await pending;
      save();
    }
  } catch (error) {
    results.fatal = String(error && error.stack ? error.stack : error);
  }
  save();
  app.quit();
});
