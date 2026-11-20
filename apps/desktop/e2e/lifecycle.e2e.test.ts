// End-to-end: the app's life outside its window, with both real helpers (Lifecycle.ts, Tray.ts).
// Closing the window hides it and the app and its helpers run on; the tray's menu opens it again
// and quits; a second start with the same data folder ends at once and shows the first one's
// window; a start with --hidden shows no window. The test waits for events, never for time.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The second start is a plain process of the same Electron.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test reads the app's data on disk.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app and its data on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";
import { columnPage } from "./local-page.ts";

const APP_DIRECTORY = NodePath.resolve(import.meta.dirname, "..");
const osSandbox = process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true";
// Windows and Linux keep the app in the notification area; a Mac keeps it in the Dock, with no
// tray and no notice (Lifecycle.keepsRunningInTray). A test reads it from HostProcess.Platform.
const withTray = (body: (hasTray: boolean) => Promise<void>) =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(() => body(platform !== "darwin")),
  );

interface Launched {
  readonly app: ElectronApplication;
  // The app's process, kept at launch: once the app has quit, Playwright on Windows no longer
  // answers `app.process()`.
  readonly child: ReturnType<ElectronApplication["process"]>;
  readonly shell: Page;
  readonly output: Array<string>;
}

const launch = async (userData: string, args: ReadonlyArray<string> = []): Promise<Launched> => {
  const output: Array<string> = [];
  const app = await _electron.launch({
    args: [APP_DIRECTORY, ...args],
    chromiumSandbox: osSandbox,
    env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: userData },
  });
  const child = app.process();
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const shell = await columnPage(app);
  // The column's page is ready once live (#71): on a Windows runner its view may not count as
  // visible yet, and a later step that needs it visible waits for that itself.
  await shell.locator('main[data-status="live"]').waitFor({ state: "attached" });
  await shell
    .locator('[data-helper="lazurio-tailnet"][data-state="ready"]')
    .waitFor({ state: "attached" });
  await shell
    .locator('[data-helper="lazurio-device"][data-state="ready"]')
    .waitFor({ state: "attached" });
  return { app, child, shell, output };
};

// Resolves once the app has written the line, including earlier output.
const outputLine = (launched: Launched, line: string): Promise<void> =>
  new Promise((resolve) => {
    const check = () => {
      if (!launched.output.join("").includes(line)) return;
      launched.child.stdout?.off("data", check);
      resolve();
    };
    launched.child.stdout?.on("data", check);
    check();
  });
const countOf = (launched: Launched, line: string): number =>
  launched.output.join("").split(line).length - 1;

// The main window's visibility, once it is as expected.
const windowVisible = (launched: Launched, visible: boolean): Promise<number> =>
  launched.app.evaluate(async ({ BaseWindow }, expected) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) throw new Error("no window");
    if (window.isVisible() !== expected) {
      await new Promise<void>((resolve) => {
        if (expected) window.once("show", () => resolve());
        else window.once("hide", () => resolve());
      });
    }
    return BaseWindow.getAllWindows().length;
  }, visible);

const closeWindow = (launched: Launched) =>
  launched.app.evaluate(({ BaseWindow }) => {
    BaseWindow.getAllWindows()[0]?.close();
  });

// Clicks the tray menu's item (0: Open, -1: Quit, the last), as the person does.
const clickTray = (launched: Launched, index: number) =>
  launched.app.evaluate((_electron, item) => {
    const menu = Reflect.get(globalThis, "lazurioAppE2eTrayMenu") as Electron.Menu | undefined;
    if (menu === undefined) throw new Error("no tray menu");
    menu.items.at(item)?.click();
  }, index);

// Opens the window again as the person does: the tray's Open, or a click on the Mac's Dock icon.
const openWindow = (launched: Launched, hasTray: boolean) =>
  hasTray
    ? clickTray(launched, 0)
    : launched.app.evaluate(({ app }) => {
        app.emit("activate");
      });

// Quits as the person does: the tray's Quit, or Cmd+Q on a Mac (app.quit).
const quitApp = (launched: Launched, hasTray: boolean) =>
  hasTray
    ? clickTray(launched, -1)
    : launched.app.evaluate(({ app }) => {
        app.quit();
      });

const helperPids = async (launched: Launched): Promise<ReadonlyArray<number>> => {
  const pids: unknown = await launched.app.evaluate(() =>
    Object.values(Reflect.get(globalThis, "lazurioAppE2eHelperPids") ?? {}),
  );
  if (!Array.isArray(pids) || pids.length !== 2) throw new Error("the app named no helper PIDs");
  return pids.filter((pid): pid is number => typeof pid === "number");
};

// Signal 0 checks that the process exists and ends nothing.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const exited = (launched: Launched): Promise<void> =>
  new Promise((resolve) => {
    const child = launched.child;
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });

describe("Lazurio App's life outside its window", () => {
  let userData: string;
  let first: Launched;

  beforeAll(async () => {
    userData = temporaryUserData();
    first = await launch(userData);
  });

  afterAll(async () => {
    const child = first?.child;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await first.app.close();
    }
    removeUserData(userData);
  });

  it.effect("hides its window when it closes, and runs on with both helpers", () =>
    withTray(async (hasTray) => {
      await windowVisible(first, true);
      await closeWindow(first);
      assert.strictEqual(await windowVisible(first, false), 1);
      for (const pid of await helperPids(first)) assert.isTrue(isAlive(pid));
      assert.isNull(first.child.exitCode);
      if (!hasTray) {
        // A Mac keeps the app in the Dock and says nothing.
        assert.strictEqual(countOf(first, "lazurio-app-e2e notice "), 0);
        return;
      }
      // The first hidden window says once where the app went, and remembers it in userData.
      await outputLine(first, "lazurio-app-e2e notice ");
      assert.match(first.output.join(""), /notification area|oznamovací oblasti/u);
      assert.deepStrictEqual(
        JSON.parse(NodeFS.readFileSync(NodePath.join(userData, "tray.json"), "utf8")),
        { hiddenNoticeShown: true },
      );
    }),
  );

  // Lazurio's own icon at the tray's sizes, not the executable's: Windows gives an .exe's generic
  // icon to app.getFileIcon (#80). Whether Windows shows it, only a screenshot proves.
  it.effect("shows Lazurio's own icon in the notification area", () =>
    withTray(async (hasTray) => {
      if (!hasTray) return;
      const icon = await first.app.evaluate(() => {
        const image = Reflect.get(globalThis, "lazurioAppE2eTrayIcon") as
          | Electron.NativeImage
          | undefined;
        if (image === undefined) return undefined;
        return { empty: image.isEmpty(), scales: image.getScaleFactors(), size: image.getSize() };
      });
      assert.deepStrictEqual(icon, {
        empty: false,
        scales: [1, 1.5, 2],
        size: { width: 16, height: 16 },
      });
    }),
  );

  it.effect(
    "opens the window again from the tray (the Dock on a Mac), and says nothing the second time it hides",
    () =>
      withTray(async (hasTray) => {
        await openWindow(first, hasTray);
        await windowVisible(first, true);
        await closeWindow(first);
        await windowVisible(first, false);
        assert.strictEqual(countOf(first, "lazurio-app-e2e notice "), hasTray ? 1 : 0);
      }),
  );

  it("ends a second start with the same data folder at once and shows the first one's window", async () => {
    const electron: unknown = await first.app.evaluate(() => process.execPath);
    if (typeof electron !== "string") return assert.fail("no Electron to start");
    const second = NodeChildProcess.spawn(
      electron,
      [APP_DIRECTORY, ...(osSandbox ? [] : ["--no-sandbox"])],
      {
        env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: userData },
        stdio: "ignore",
      },
    );
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    assert.strictEqual(code, 0);
    await outputLine(first, "lazurio-app-e2e second-instance");
    await windowVisible(first, true);
  });

  it("starts nothing on --quit with another data folder, where no app runs", async () => {
    const electron: unknown = await first.app.evaluate(() => process.execPath);
    if (typeof electron !== "string") return assert.fail("no Electron to start");
    const elsewhere = temporaryUserData();
    try {
      const lone = NodeChildProcess.spawn(
        electron,
        [APP_DIRECTORY, "--quit", ...(osSandbox ? [] : ["--no-sandbox"])],
        {
          env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: elsewhere },
          stdio: "ignore",
        },
      );
      assert.strictEqual(
        await new Promise<number | null>((resolve) => lone.once("exit", resolve)),
        0,
      );
      // The app of this suite runs on.
      assert.isNull(first.child.exitCode);
    } finally {
      removeUserData(elsewhere);
    }
  });

  // Last: it ends the app.
  it.effect("quits from the tray (Cmd+Q on a Mac), and its helpers end with it", () =>
    withTray(async (hasTray) => {
      const pids = await helperPids(first);
      const ended = exited(first);
      await quitApp(first, hasTray);
      await ended;
      for (const pid of pids) assert.isFalse(isAlive(pid));
    }),
  );
});

describe("Lazurio App asked to quit by a second start with --quit", () => {
  let userData: string;
  let running: Launched;

  beforeAll(async () => {
    userData = temporaryUserData();
    running = await launch(userData);
  });

  afterAll(async () => {
    if (running?.child.exitCode === null && running.child.signalCode === null) {
      await running.app.close();
    }
    removeUserData(userData);
  });

  it("quits as with the tray's Quit, and its helpers end with it", async () => {
    const pids = await helperPids(running);
    const ended = exited(running);
    const electron: unknown = await running.app.evaluate(() => process.execPath);
    if (typeof electron !== "string") return assert.fail("no Electron to start");
    const second = NodeChildProcess.spawn(
      electron,
      [APP_DIRECTORY, "--quit", ...(osSandbox ? [] : ["--no-sandbox"])],
      {
        env: { ...process.env, LAZURIO_APP_E2E: "true", LAZURIO_APP_E2E_USER_DATA: userData },
        stdio: "ignore",
      },
    );
    assert.strictEqual(
      await new Promise<number | null>((resolve) => second.once("exit", resolve)),
      0,
    );
    await ended;
    for (const pid of pids) assert.isFalse(isAlive(pid));
  });
});

describe("Lazurio App started with --hidden", () => {
  let userData: string;
  let hidden: Launched;

  beforeAll(async () => {
    userData = temporaryUserData();
    hidden = await launch(userData, ["--hidden"]);
  });

  afterAll(async () => {
    await hidden?.app.close();
    removeUserData(userData);
  });

  it.effect(
    "shows no window until the tray (the Dock on a Mac) opens it, with every switch off",
    () =>
      withTray(async (hasTray) => {
        const visible = await hidden.app.evaluate(({ BaseWindow }) =>
          BaseWindow.getAllWindows().map((window) => window.isVisible()),
        );
        assert.deepStrictEqual(visible, [false]);
        const device = await hidden.shell.evaluate(() => window.lazurio.device.getState());
        assert.isTrue(device.switches.every((entry) => entry.switch.phase === "off"));
        await openWindow(hidden, hasTray);
        await windowVisible(hidden, true);
      }),
  );
});
