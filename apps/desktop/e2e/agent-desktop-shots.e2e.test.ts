// End-to-end: the Agent Desktop window shows each sample state of its panel, in Czech and English,
// light and dark (AgentDesktopFixtures, served to the end-to-end tests alone). With
// LAZURIO_APP_E2E_SCREENSHOTS set, the window's page is captured as <state>-<lang>-<theme>.png.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test writes the screenshots to disk.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its folder.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { localPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const STATES = [
  "empty",
  "empty-hint",
  "off",
  "signing-in",
  "connecting",
  "connected",
  "working",
  "stopping",
  "reconnecting",
  "error-paired",
  "error-unknown-environment",
  "error-not-yours",
  "error-device-not-approved",
  "worst",
] as const;

let userData: string;
let app: ElectronApplication;

beforeAll(async () => {
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, ".."), "--show-agent-desktop"],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: userData },
  });
  await localPage(app, "view=agent-desktop");
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
});

// Shows the state in the Agent Desktop window and gives what the page shows and its picture.
const show = (state: string, lang: string, theme: "light" | "dark") =>
  app.evaluate(
    async ({ webContents }, { query, dark }) => {
      const contents = webContents
        .getAllWebContents()
        .find((each) => each.getURL().includes("view=agent-desktop"));
      if (contents === undefined) throw new Error("no Agent Desktop window");
      // The theme as the page's media query sees it: Xvfb gives Chromium no system theme.
      if (!contents.debugger.isAttached()) contents.debugger.attach();
      await contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
      });
      await contents.loadURL(`lazurio-app://shell/index.html?${query}`);
      const shown = (await contents.executeJavaScript(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          state: document.querySelector("[data-device-state]")?.getAttribute("data-device-state") ?? null,
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          width: innerWidth,
        }))))`,
      )) as { state: string | null; dark: boolean; width: number };
      const image = await contents.capturePage();
      return { ...shown, png: image.toPNG().toString("base64") };
    },
    {
      query: new URLSearchParams({ view: "agent-desktop-fixtures", state, lang }).toString(),
      dark: theme === "dark",
    },
  );

describe("Agent Desktop's panel in its sample states", () => {
  it("shows every state in the window, in both languages and themes", async () => {
    const directory = process.env["LAZURIO_APP_E2E_SCREENSHOTS"];
    for (const lang of ["cs", "en"] as const) {
      for (const theme of ["light", "dark"] as const) {
        for (const state of STATES) {
          const shown = await show(state, lang, theme);
          assert.strictEqual(shown.state, "ready", `${state} ${lang} ${theme}`);
          assert.strictEqual(shown.dark, theme === "dark");
          if (directory !== undefined && directory !== "") {
            NodeFS.writeFileSync(
              NodePath.join(directory, `${state}-${lang}-${theme}.png`),
              Buffer.from(shown.png, "base64"),
            );
          }
        }
      }
    }
  });

  it("names an Environment, not its address, and keeps the address in the row's menu", async () => {
    const page = await localPage(app, "view=agent-desktop");
    await show("off", "en", "light");
    const row = page.locator("[data-device-switch]");
    assert.strictEqual(await row.locator(".ad__env-name strong").innerText(), "Bob");
    assert.notInclude(await row.locator(".ad__env-row").innerText(), "launchpad.");
    await row.locator('[data-action="device-more"]').click();
    assert.include(await row.locator(".ad__menu code").innerText(), "launchpad.lazurio-bob");
    assert.strictEqual(await row.locator('[role="switch"]').getAttribute("aria-checked"), "false");
  });

  // The window has no menu of its own (DevicePanel.removeMenu): Chromium's editing keys still copy.
  it("copies the technical details with Copy and with Ctrl+C", async () => {
    const page = await localPage(app, "view=agent-desktop");
    await show("error-paired", "en", "light");
    const problem = page.locator("[data-switch-problem]");
    await problem.locator(".ad__technical summary").click();
    await problem.locator('[data-action="device-copy"]').click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.include(copied, "agent_desktop_paired");
    assert.include(copied, "io.lazurio.agent-desktop");
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await problem.locator(".ad__copyable pre").selectText();
    await page.keyboard.press("Control+C");
    assert.include(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "agent_desktop_paired",
    );
  });
});
