// @effect-diagnostics-next-line nodeBuiltinImport:off - End-to-end tests only: the start's gate is a file that appears.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import { agentBarHeight, workingAgent } from "../shared/agentBar.ts";
import { APP_NAME } from "../shared/appName.ts";
import {
  STATUS_CHANGED_CHANNEL,
  type AppStatus,
  type PageOutcome,
  type UpdatesOffReason,
} from "../shared/bridge.ts";
import { statusText } from "../shared/statusText.ts";
import { localeOf, messages } from "../ui/messages.ts";

import * as AuthClient from "./AuthClient.ts";
import * as BrowserOpen from "./BrowserOpen.ts";
import { DeviceActivity } from "./DeviceActivity.ts";
import * as DeviceEnvironments from "./DeviceEnvironments.ts";
import * as DeviceIpc from "./DeviceIpc.ts";
import * as DevicePanel from "./DevicePanel.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceSwitches from "./DeviceSwitches.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";
import * as Hardening from "./Hardening.ts";
import { withAppToken } from "./UserAgent.ts";
import * as KeystoreCheck from "./KeystoreCheck.ts";
import * as Helpers from "./Helpers.ts";
import * as AppMenu from "./AppMenu.ts";
import * as Lifecycle from "./Lifecycle.ts";
import * as LocalScheme from "./LocalScheme.ts";
import * as MacPermissions from "./MacPermissions.ts";
import * as MainWindow from "./MainWindow.ts";
import * as NodeKeys from "./NodeKeys.ts";
import * as RemoteUrl from "./RemoteUrl.ts";
import * as ShellNames from "./ShellNames.ts";
import * as Tailnet from "./Tailnet.ts";
import * as ReleaseFeed from "./ReleaseFeed.ts";
import * as SettingWatch from "./SettingWatch.ts";
import * as TailnetDirectory from "./TailnetDirectory.ts";
import * as TailnetPolicy from "./TailnetPolicy.ts";
import * as Tray from "./Tray.ts";
import * as Updates from "./Updates.ts";
import * as UpdatesIpc from "./UpdatesIpc.ts";
import * as WindowIpc from "./WindowIpc.ts";

// Lazurio App GEN4 (decision 0248): the main process. It serves the app's own windows, guards
// every web contents, starts the helper processes and opens the main window.

LocalScheme.registerPrivilegesSync();
Electron.app.enableSandbox();

// The app's sign-in opens in the system's browser (AuthClient, RFC 8252).
// The app's sign-in keeps waiting when the browser does not open; the person copies the address.
const openInSystemBrowser = BrowserOpen.openOrOffer(
  (address) => Electron.shell.openExternal(address),
  Hardening.browserFailed,
);

// The notice of the first hidden window, as the system shows it.
const systemNotice = (body: string) =>
  Effect.sync(() => {
    if (Electron.Notification.isSupported()) {
      new Electron.Notification({ title: APP_NAME, body }).show();
    }
  });

// End-to-end tests only, and never in a packaged app: a remote page to load, and an observer
// that records instead of opening the system's browser.
const testHooks = Effect.gen(function* () {
  const enabled =
    !Electron.app.isPackaged &&
    (yield* Config.Boolean("LAZURIO_APP_E2E").pipe(Config.withDefault(false)));
  if (!enabled) {
    return {
      observer: Hardening.electronObserver,
      remoteUrl: Option.none<string>(),
      tailnetHelper: Option.none<Helpers.HelperBinary>(),
      deviceHelper: Option.none<Helpers.HelperBinary>(),
      authIssuer: Option.none<string>(),
      openBrowser: openInSystemBrowser,
      helperStarted: (_name: string, _pid: number) => {},
      fixtures: false,
      notice: systemNotice,
      secondInstance: () => {},
      trayMenu: (_menu: Electron.Menu) => {},
      trayIcon: (_image: Electron.NativeImage) => {},
      startGate: Effect.void,
      quitHeld: () => {},
      macPermissions: Option.none<MacPermissions.PermissionSystem>(),
    };
  }
  // A launch may keep its data apart from the development profile, before the app is ready.
  const userData = yield* Config.option(Config.String("LAZURIO_APP_E2E_USER_DATA"));
  if (Option.isSome(userData)) Electron.app.setPath("userData", userData.value);
  const remoteUrl = yield* Config.option(Config.String("LAZURIO_APP_E2E_REMOTE_URL"));
  // A tailnet helper of the tests (e2e/fake-tailnet-helper.ts), run by the given Node.
  const fakeHelper = yield* Config.option(Config.String("LAZURIO_APP_E2E_TAILNET_HELPER"));
  const fakeNode = yield* Config.option(Config.String("LAZURIO_APP_E2E_NODE"));
  const tailnetHelper =
    Option.isSome(fakeHelper) && Option.isSome(fakeNode)
      ? Option.some<Helpers.HelperBinary>({
          name: "lazurio-tailnet",
          path: fakeNode.value,
          args: [fakeHelper.value],
        })
      : Option.none<Helpers.HelperBinary>();
  // A Device helper of the tests (src/main/fake-device-helper.ts, contract v3), and a Lazurio Auth
  // of the tests on the loopback for the app's sign-in and hand-overs.
  const fakeDeviceHelper = yield* Config.option(Config.String("LAZURIO_APP_E2E_DEVICE_HELPER"));
  const deviceHelper =
    Option.isSome(fakeDeviceHelper) && Option.isSome(fakeNode)
      ? Option.some<Helpers.HelperBinary>({
          name: "lazurio-device",
          path: fakeNode.value,
          args: [fakeDeviceHelper.value, "v3"],
        })
      : Option.none<Helpers.HelperBinary>();
  const authIssuer = yield* Config.option(Config.String("LAZURIO_APP_E2E_AUTH_ISSUER"));
  const observer: Hardening.NavigationObserver = {
    openExternally: (url) => {
      process.stdout.write(`lazurio-app-e2e system-browser ${url}\n`);
    },
    refused: (url, frame) => {
      process.stdout.write(`lazurio-app-e2e refused ${frame} ${url}\n`);
    },
  };
  // A test ends a helper by the PID the app started, never by its name. It reads the PIDs from
  // the main process (Playwright's evaluate), because the app starts its helpers before a test
  // can listen to its output.
  const helperPids: Record<string, number> = {};
  Reflect.set(globalThis, "lazurioAppE2eHelperPids", helperPids);
  const helperStarted = (name: string, pid: number) => {
    process.stdout.write(`lazurio-app-e2e helper ${name} ${pid}\n`);
    helperPids[name] = pid;
  };
  const openBrowser = (address: string) => Effect.sync(() => observer.openExternally(address));
  // The notice, a second start and the tray's menu, where a test can see and use them.
  const notice = (body: string) =>
    Effect.sync(() => {
      process.stdout.write(`lazurio-app-e2e notice ${body}\n`);
    });
  const secondInstance = () => {
    process.stdout.write("lazurio-app-e2e second-instance\n");
  };
  const trayMenu = (menu: Electron.Menu) => {
    Reflect.set(globalThis, "lazurioAppE2eTrayMenu", menu);
  };
  const trayIcon = (image: Electron.NativeImage) => {
    Reflect.set(globalThis, "lazurioAppE2eTrayIcon", image);
  };
  // The start waits here, right before its own quit is ready, until the gate's file exists, so a
  // test can quit the app while it starts.
  const gate = yield* Config.option(Config.String("LAZURIO_APP_E2E_START_GATE"));
  const gateDirectory = (yield* Path.Path).dirname(Option.getOrElse(gate, () => ""));
  const startGate = Option.match(gate, {
    onNone: () => Effect.void,
    onSome: (file) =>
      Effect.callback<void>((resume) => {
        process.stdout.write("lazurio-app-e2e start-gated\n");
        // The watch starts before the check, so a file made in between is not missed.
        const watcher = NodeFS.watch(gateDirectory, () => {
          if (NodeFS.existsSync(file)) resume(Effect.void);
        });
        if (NodeFS.existsSync(file)) resume(Effect.void);
        return Effect.sync(() => watcher.close());
      }),
  });
  const quitHeld = () => {
    process.stdout.write("lazurio-app-e2e quit-held\n");
  };
  // A Mac's permissions for Agent Desktop, as "accessibility:denied,screen:granted": the app acts
  // as on a Mac for them alone. A test allows one by changing lazurioAppE2eMacPermissions; asking
  // macOS, opening a pane and the restart are written out instead.
  const simulated = yield* Config.option(Config.String("LAZURIO_APP_E2E_MAC_PERMISSIONS"));
  let macPermissions = Option.none<MacPermissions.PermissionSystem>();
  if (Option.isSome(simulated)) {
    const allowed = { accessibility: false, screen: false };
    for (const pair of simulated.value.split(",")) {
      const [kind, answer] = pair.split(":");
      if (kind !== "accessibility" && kind !== "screen") {
        return yield* Effect.die(`LAZURIO_APP_E2E_MAC_PERMISSIONS: no permission ${kind}`);
      }
      allowed[kind] = answer === "granted";
    }
    Reflect.set(globalThis, "lazurioAppE2eMacPermissions", allowed);
    macPermissions = Option.some<MacPermissions.PermissionSystem>({
      read: Effect.sync(() => ({ ...allowed })),
      enlist: (kind) =>
        Effect.sync(() => {
          process.stdout.write(`lazurio-app-e2e enlist ${kind}\n`);
        }),
      openPane: (address) => Effect.sync(() => observer.openExternally(address)),
      restart: Effect.sync(() => {
        process.stdout.write("lazurio-app-e2e restart\n");
      }),
    });
  }
  return {
    macPermissions,
    notice,
    secondInstance,
    trayMenu,
    trayIcon,
    startGate,
    quitHeld,
    observer,
    remoteUrl,
    tailnetHelper,
    deviceHelper,
    authIssuer,
    openBrowser,
    helperStarted,
    // Agent Desktop's sample states for its screenshots (AgentDesktopFixtures).
    fixtures: true,
  };
});

// The tailnets a packaged app joins (ADR 0008): on Windows and a Mac IT's policy or the person's
// setting, else the built-in directory where TailnetDirectory.builtInAllowed lets it (not a stable
// Windows build). Development may set them as JSON in LAZURIO_APP_DEV_TAILNETS and joins none otherwise.
const packagedDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const builtInFile = path.join(process.resourcesPath, "tailnets", "directory.json");
  // A stable Windows build joins no built-in network; a nightly and any build off Windows do.
  const platform = yield* HostProcess.Platform;
  const builtIn = TailnetDirectory.builtInAllowed(Electron.app.getVersion(), platform)
    ? TailnetDirectory.fromFile(builtInFile, NodeOS.hostname())
    : Effect.succeed(TailnetDirectory.NO_TAILNETS);
  // On a Mac, the managed preference and the person's defaults (TailnetPolicy.readMac).
  if (platform === "darwin") {
    return yield* TailnetPolicy.directoryOf(readMacSetting, builtIn, NodeOS.hostname());
  }
  if (platform !== "win32") {
    return { source: "built-in", text: Option.none<string>(), directory: yield* builtIn };
  }
  // The packaged tailnet helper reads the policy and the person's setting through the registry's
  // API; the setting counts only where the helper confirms there is no policy (TailnetPolicy).
  return yield* TailnetPolicy.directoryOf(readWindowsSetting, builtIn, NodeOS.hostname());
});

// The policy or the person's setting, read by the packaged tailnet helper on Windows.
const readWindowsSetting = (source: TailnetPolicy.PolicySource) =>
  Effect.flatMap(Path.Path, (path) =>
    TailnetPolicy.readWindows(
      path.join(process.resourcesPath, "helpers", "lazurio-tailnet.exe"),
      source,
    ),
  );

// The policy or the person's setting on a Mac, read by the system's own programs.
const readMacSetting = (source: TailnetPolicy.PolicySource) =>
  TailnetPolicy.readMac(TailnetPolicy.macSystem, NodeOS.userInfo().username, source);

// The setting as SettingWatch reads it again on this system.
const settingNowOn = Effect.fn("settingNowOn")(function* (platform: string) {
  return platform === "darwin"
    ? yield* TailnetPolicy.settingNow(readMacSetting, NodeOS.hostname())
    : yield* TailnetPolicy.settingNow(readWindowsSetting, NodeOS.hostname());
});

// The tailnets to join, and whether the Organization's network is missing: a stable build with
// neither IT's policy nor the person's setting, which joins nothing and says so.
const tailnetsToJoin = Effect.gen(function* () {
  if (Electron.app.isPackaged) {
    const { source, text, directory } = yield* packagedDirectory;
    for (const refused of directory.refused) {
      yield* Effect.logWarning("tailnet refused", { source, ...refused });
    }
    yield* Effect.logInfo("tailnets", {
      source,
      tailnets: directory.tailnets.map((tailnet) => tailnet.tailnet),
    });
    const platform = yield* HostProcess.Platform;
    return {
      tailnets: directory.tailnets,
      networkMissing:
        source === "built-in" &&
        !TailnetDirectory.builtInAllowed(Electron.app.getVersion(), platform),
      // On Windows and a Mac the setting is read again while the app runs (SettingWatch, #81).
      setting:
        platform === "win32" || platform === "darwin"
          ? Option.some(text)
          : Option.none<Option.Option<string>>(),
    };
  }
  const setting = yield* Config.option(Config.String("LAZURIO_APP_DEV_TAILNETS"));
  return {
    tailnets: Option.isSome(setting) ? yield* Tailnet.decodeTailnets(setting.value) : [],
    // End-to-end tests only (testHooks): a stable build without the Organization's network.
    networkMissing: yield* Config.Boolean("LAZURIO_APP_E2E_NETWORK_MISSING").pipe(
      Config.withDefault(false),
    ),
    setting: Option.none<Option.Option<string>>(),
  };
});

// The page of the web Lazurio the main window shows (RemoteUrl). Development may set one, for trying
// a sign-in or a page by hand; a packaged app takes no setting.
const remoteUrlOf = Effect.fn("main.remoteUrlOf")(function* (testUrl: Option.Option<string>) {
  const choice = RemoteUrl.choose({
    packaged: Electron.app.isPackaged,
    test: testUrl,
    development: yield* Config.option(Config.String("LAZURIO_APP_DEV_REMOTE_URL")),
  });
  if (choice.developmentRefused) {
    yield* Effect.logWarning("LAZURIO_APP_DEV_REMOTE_URL is no address of Lazurio over HTTPS");
  }
  return choice.remoteUrl;
});

const helperBinaries = Effect.fn("main.helperBinaries")(function* (
  testTailnetHelper: Option.Option<Helpers.HelperBinary>,
  testDeviceHelper: Option.Option<Helpers.HelperBinary>,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const executable = (name: string) => (platform === "win32" ? `${name}.exe` : name);
  if (Electron.app.isPackaged) {
    const directory = path.join(process.resourcesPath, "helpers");
    return [
      { name: "lazurio-tailnet", path: path.join(directory, executable("lazurio-tailnet")) },
      { name: "lazurio-device", path: path.join(directory, executable("lazurio-device")) },
    ];
  }
  const repository = path.resolve(Electron.app.getAppPath(), "..", "..");
  return [
    Option.getOrElse(testTailnetHelper, () => ({
      name: "lazurio-tailnet",
      path: path.join(repository, "helpers", "tailnet", "bin", executable("lazurio-tailnet")),
    })),
    Option.getOrElse(testDeviceHelper, () => ({
      name: "lazurio-device",
      path: path.join(
        repository,
        "helpers",
        "device",
        "target",
        "debug",
        executable("lazurio-device"),
      ),
    })),
  ];
});

// The system's keystore for the tailnet nodes' state keys (NodeKeys, ADR 0003). A development
// build on Linux without a keyring seals with Chromium's fixed password, which NodeKeys accepts
// only from a development build; a packaged app never asks for it.
const keystoreOn = (platform: string, development: boolean): NodeKeys.Keystore => {
  if (development && platform === "linux") Electron.safeStorage.setUsePlainTextEncryption(true);
  return {
    available: () => Electron.safeStorage.isEncryptionAvailable(),
    backend: () =>
      platform === "linux" ? Electron.safeStorage.getSelectedStorageBackend() : undefined,
    seal: (text) => Electron.safeStorage.encryptString(text),
    open: (sealed) => Electron.safeStorage.decryptString(Buffer.from(sealed)),
  };
};

// One restart for the whole run: the network setting (SettingWatch) and Agent Desktop's Screen
// Recording both start the app again, and a second request while one runs does nothing.
let restartRequested = false;
const restartOnce = (args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    if (restartRequested) return;
    restartRequested = true;
    Electron.app.relaunch({ args: [...args] });
    Electron.app.quit();
  });
const argsWithoutHidden = () => process.argv.slice(1).filter((arg) => arg !== "--hidden");

// macOS's answers about Agent Desktop's permissions (MacPermissions.ts); only a Mac asks them.
const electronPermissions: MacPermissions.PermissionSystem = {
  // Reading prompts for nothing: isTrustedAccessibilityClient(false), and Screen Recording's status
  // as macOS keeps it for this process (CGPreflightScreenCaptureAccess), so a newly allowed one
  // reads as missing until the app starts again.
  read: Effect.sync(() => ({
    accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
    screen: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
  })),
  enlist: (kind) =>
    kind === "accessibility"
      ? // macOS's own prompt, which also lists the app under Accessibility.
        Effect.sync(() => {
          Electron.systemPreferences.isTrustedAccessibilityClient(true);
        })
      : // Only while Screen Recording is not allowed: getSources then asks macOS first
        // (CGRequestScreenCaptureAccess), which lists the app and prompts, and fails before any
        // capturer exists, so nothing is captured. No thumbnails were asked for either way, and the
        // answer is dropped.
        Effect.suspend(() =>
          Electron.systemPreferences.getMediaAccessStatus("screen") === "granted"
            ? Effect.void
            : Effect.promise(() =>
                Electron.desktopCapturer
                  .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
                  .then(
                    () => undefined,
                    () => undefined,
                  ),
              ).pipe(Effect.timeoutOption("5 seconds"), Effect.asVoid),
        ),
  openPane: (address) =>
    Effect.tryPromise({
      try: () => Electron.shell.openExternal(address),
      catch: () => new MacPermissions.MacPermissionsError({ problem: "not-opened" }),
    }),
  // The same end as Quit in the tray: the helpers stop and every switch is off after the start,
  // which opens the Agent Desktop window again.
  restart: Effect.suspend(() => {
    const args = argsWithoutHidden();
    return restartOnce(
      args.includes("--show-agent-desktop") ? args : [...args, "--show-agent-desktop"],
    );
  }),
};

// Why this system cannot update the app by itself (docs/adr/0005, point 7). Squirrel.Mac installs
// only an app signed with a Developer ID, which Lazurio App does not have yet. On Linux, which GEN4
// does not ship, only an AppImage updates itself; its runtime sets APPIMAGE, and electron-updater
// reads it the same way.
const selfUpdateUnsupported = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") return Option.some<UpdatesOffReason>("macos-unsigned");
  if (platform === "linux") {
    const appImage = yield* Config.option(Config.String("APPIMAGE"));
    return Option.isSome(appImage)
      ? Option.none<UpdatesOffReason>()
      : Option.some<UpdatesOffReason>("linux-not-appimage");
  }
  return Option.none<UpdatesOffReason>();
});

// The Device helper's data directory inside userData (docs/adr/0006, point 1): never next to its
// binary, which an update replaces.
const deviceDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = path.join(Electron.app.getPath("userData"), "device");
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  return directory;
});

// The data folder keeps its name whatever the product's name or the generation: an update, and
// GEN5 after it, opens the same sign-in, tailnet nodes and settings (docs/adr/0005, point 1).
const DATA_FOLDER = "Lazurio App";

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  Electron.app.setPath("userData", path.join(Electron.app.getPath("appData"), DATA_FOLDER));
  const hooks = yield* testHooks;
  // One app per data folder, before any helper starts: a second start only shows the first one's
  // window. The lock follows userData, so each end-to-end launch with its own has its own.
  if (!Electron.app.requestSingleInstanceLock()) {
    yield* Effect.logInfo("the app already runs; its window shows");
    return;
  }
  // `--quit` with no app running has nothing to quit, and starts none.
  if (Lifecycle.secondStart(process.argv) === "quit") {
    yield* Effect.logInfo("--quit, and the app does not run");
    return;
  }
  // From here a quit waits for the program's own (Lifecycle.startQuitStep): it is held until the
  // program's before-quit is registered and asked again then. Both listeners end with the scope, so
  // the last app.quit() of the program (main's ensuring) passes, and a start that fails quits too.
  let ownQuitReady = false;
  let quitWasHeld = false;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const holdQuit = (event: Electron.Event) => {
        if (Lifecycle.startQuitStep(ownQuitReady) === "pass") return;
        event.preventDefault();
        if (!quitWasHeld) hooks.quitHeld();
        quitWasHeld = true;
      };
      Electron.app.on("before-quit", holdQuit);
      return holdQuit;
    }),
    (holdQuit) => Effect.sync(() => Electron.app.off("before-quit", holdQuit)),
  );
  const platform = yield* HostProcess.Platform;
  // Windows: the same AppUserModelID as the Start menu shortcut, so the hidden-window toast shows.
  if (platform === "win32") Electron.app.setAppUserModelId(Lifecycle.APP_USER_MODEL_ID);
  // The window, once it exists, and whether it should show: a start at the sign-in to Windows is
  // hidden until the person opens the app.
  let mainWindow = Option.none<Electron.BaseWindow>();
  let showWanted = !Lifecycle.startsHidden(process.argv);
  const showWindow = () => {
    showWanted = true;
    if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) return;
    const window = mainWindow.value;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  // The app's status column beside the page: hidden by default (Matěj, 2026-11-18), shown from
  // the menu, the tray, --show-status or the waiting page. An agent at work shows in the bar over
  // the page (AgentBar), not by opening the column.
  let statusShown = Lifecycle.showsStatus(process.argv);
  let windowControls = Option.none<MainWindow.MainWindowControls>();
  // How the window's page last ended, for Copy status (MainWindow.pageOutcome).
  let page: PageOutcome = { outcome: "none" };
  let refreshMenu = () => {};
  // Set once Agent Desktop's controls exist; until then no agent can work.
  let agentWorksNow = () => false;
  // While an agent works, a window that was minimized or hidden (the system's Hide, a minimize)
  // shows again, so the work and its Stop stay in view for the whole hold (docs/adr/0006).
  const keepWindowInView = () => {
    if (quitting || !agentWorksNow() || Option.isNone(mainWindow)) return;
    if (mainWindow.value.isDestroyed()) return;
    const window = mainWindow.value;
    if (window.isMinimized() || !window.isVisible()) showWindow();
  };
  const setStatusShown = (requested: boolean) => {
    const shown = Lifecycle.statusShownAfter(requested, agentWorksNow());
    statusShown = shown;
    if (shown) showWindow();
    if (Option.isSome(windowControls)) windowControls.value.relayout();
    refreshMenu();
  };
  // The Agent Desktop window (DevicePanel.ts) once it can open; asked for before that, by
  // --show-agent-desktop or a second start, it opens as soon as the main window exists.
  let devicePanel = Option.none<DevicePanel.DevicePanel>();
  let agentDesktopWanted = Lifecycle.secondStart(process.argv) === "agent-desktop";
  const openAgentDesktop = () => {
    if (Option.isSome(devicePanel) && Option.isSome(mainWindow)) devicePanel.value.open();
    else agentDesktopWanted = true;
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const secondInstance = (_event: Electron.Event, argv: ReadonlyArray<string>) => {
        hooks.secondInstance();
        const step = Lifecycle.secondStart(argv);
        if (step === "quit") Electron.app.quit();
        else if (step === "show-status") setStatusShown(true);
        else if (step === "agent-desktop") openAgentDesktop();
        else showWindow();
      };
      Electron.app.on("second-instance", secondInstance);
      // A Mac's Dock shows the window again.
      Electron.app.on("activate", showWindow);
      return secondInstance;
    }),
    (secondInstance) =>
      Effect.sync(() => {
        Electron.app.off("second-instance", secondInstance);
        Electron.app.off("activate", showWindow);
      }),
  );
  yield* Effect.promise(() => Electron.app.whenReady());
  // A packaged app on Windows starts, hidden, when the person signs in (Lifecycle.loginItem).
  const loginItem = Lifecycle.loginItem({ platform, packaged: Electron.app.isPackaged });
  if (Option.isSome(loginItem)) {
    Electron.app.setLoginItemSettings({
      openAtLogin: loginItem.value.openAtLogin,
      args: [...loginItem.value.args],
      name: loginItem.value.name,
    });
  }
  const appPath = Electron.app.getAppPath();

  // Before any session or page exists, so every request carries it (UserAgent.ts).
  Electron.app.userAgentFallback = withAppToken(
    Electron.app.userAgentFallback,
    Electron.app.getVersion(),
  );
  yield* Hardening.guardAllWebContents(hooks.observer);
  yield* Hardening.hardenSession(Electron.session.defaultSession);
  yield* LocalScheme.serve(path.join(appPath, "dist-ui"), { fixtures: hooks.fixtures });

  // The helpers live in a scope of their own, which the updater closes before it installs: on
  // Windows a running helper keeps its .exe locked (docs/adr/0005, point 5).
  const helpersScope = yield* Scope.fork(yield* Effect.scope);
  const helpers = yield* Helpers.startAll(
    yield* helperBinaries(hooks.tailnetHelper, hooks.deviceHelper),
  ).pipe(Scope.provide(helpersScope));
  for (const helper of helpers) {
    if (Option.isSome(helper.connection)) {
      hooks.helperStarted(helper.status.name, helper.connection.value.pid);
    }
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const keystore = keystoreOn(yield* HostProcess.Platform, !Electron.app.isPackaged);
  yield* KeystoreCheck.run({
    keystore,
    userData: Electron.app.getPath("userData"),
    appVersion: Electron.app.getVersion(),
    allowWithoutKeystore: !Electron.app.isPackaged,
  });
  const stateRoot = path.join(Electron.app.getPath("userData"), "tailnets");
  const joining = yield* tailnetsToJoin;
  // Without the Organization's network the status column opens and says what is missing.
  if (joining.networkMissing) setStatusShown(true);
  const tailnetHelper = helpers.find((helper) => helper.status.name === "lazurio-tailnet");
  const tailnets: Tailnet.Tailnets =
    tailnetHelper !== undefined && Option.isSome(tailnetHelper.connection)
      ? yield* Tailnet.run({
          connection: tailnetHelper.connection.value,
          tailnets: joining.tailnets,
          session: Electron.session.fromPartition(MainWindow.REMOTE_PARTITION),
          observer: hooks.observer,
          stateRoot,
          stateKeyOf: (keyFile) =>
            NodeKeys.stateKey({
              keystore,
              path: keyFile,
              allowWithoutKeystore: !Electron.app.isPackaged,
            }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
        })
      : Tailnet.noTailnets;
  // Agent Desktop (docs/adr/0006): the Device helper of the helpers list, if this build has it.
  // Its service reads the helper outside the helpers' scope, so the helper's last message after
  // Shutdown reaches the updater; without the helper the computer is always idle.
  const deviceHelper = helpers.find((helper) => helper.status.name === DeviceService.DEVICE_HELPER);
  const device =
    deviceHelper !== undefined && Option.isSome(deviceHelper.connection)
      ? Option.some(
          yield* DeviceService.run({
            connection: deviceHelper.connection.value,
            dataDirectory: yield* deviceDirectory,
            computerName: NodeOS.hostname(),
            tailnets,
          }),
        )
      : Option.none<DeviceService.DeviceService>();
  // macOS's permissions for its engine: on a Mac a switch goes on only with both (MacPermissions).
  const permissions = MacPermissions.make(
    Option.match(hooks.macPermissions, {
      onNone: () => ({ platform, system: electronPermissions }),
      onSome: (system) => ({ platform: "darwin", system }),
    }),
  );
  // Its switches (contract v3): the Environments the person added, the app's own sign-in with
  // Lazurio Auth and a hand-over for each channel. Every switch is off after each start.
  const switches = Option.isSome(device)
    ? Option.some(
        yield* DeviceSwitches.run({
          device: device.value,
          auth: yield* Effect.service(AuthClient.AuthClient).pipe(
            Effect.provide(
              AuthClient.layer({
                ...Option.match(hooks.authIssuer, {
                  onNone: () => ({}),
                  onSome: (issuer) => ({ issuer }),
                }),
                keystore,
                sessionPath: path.join(Electron.app.getPath("userData"), "auth", "session.sealed"),
                allowWithoutKeystore: !Electron.app.isPackaged,
                openBrowser: hooks.openBrowser,
                locale: localeOf(Electron.app.getLocale()),
              }).pipe(Layer.provide(FetchHttpClient.layer)),
            ),
          ),
          environments: yield* DeviceEnvironments.open(
            path.join(Electron.app.getPath("userData"), "agent-desktop-environments.json"),
          ),
          // The Environment's names from its Lazurio, read as the main window's page reads them:
          // with that window's session, so its cookie and its tailnet's proxy, and nothing more.
          readNames: (origin) =>
            ShellNames.read(origin, (url, init) =>
              Electron.session.fromPartition(MainWindow.REMOTE_PARTITION).fetch(url, init),
            ),
          permissions,
        }),
      )
    : Option.none<DeviceSwitches.DeviceSwitches>();
  const noSwitch = Effect.fail(new DeviceSwitches.DeviceSwitchError({ problem: "not-listed" }));
  const openWindow = Effect.sync(openAgentDesktop);
  const permissionControls = {
    openPermissionSettings: permissions.openSettings,
    restartApp: permissions.restartApp,
  };
  const deviceControls: DeviceIpc.DeviceControls = Option.match(switches, {
    onSome: (service) => ({ ...service, openWindow, ...permissionControls }),
    onNone: () => ({
      current: () => DeviceService.withoutHelper(deviceHelper === undefined ? "absent" : "failed"),
      subscribe: () => () => {},
      stop: Effect.void,
      setSwitch: () => noSwitch,
      addEnvironment: () => noSwitch,
      removeEnvironment: () => noSwitch,
      signOut: Effect.void,
      openWindow,
      ...permissionControls,
    }),
  });
  const panelServices = yield* Effect.context<never>();
  devicePanel = Option.some(
    yield* DevicePanel.make({
      preloadPath: path.join(appPath, "dist-electron", "preload.cjs"),
      title: "Agent Desktop",
      parent: () => mainWindow,
      focused: () => Effect.runForkWith(panelServices)(permissions.refresh),
    }),
  );
  // While the window shows the permissions, they are read again every 2 seconds, so the block goes
  // once both are allowed; the switch stays off until the person turns it on.
  yield* Effect.suspend(() =>
    Option.isSome(devicePanel) && devicePanel.value.visible() ? permissions.refresh : Effect.void,
  ).pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);
  // The updater's view of the computer: the configured helper's, or the default (always idle).
  const idleByDefault = yield* DeviceActivity;
  const deviceActivity = Option.getOrElse(
    Option.flatMap(device, (service) => service.activity),
    () => idleByDefault,
  );
  // Set once the person quits or closes the last window: a failed install then lets the app end
  // instead of starting it again.
  let quitting = false;
  // The update feed's GitHub repository, from the packaged app's own app-update.yml; none in
  // development or with a trial build's local feed, whose failures then stay failures.
  const feedRepository = Electron.app.isPackaged
    ? yield* fileSystem.readFileString(path.join(process.resourcesPath, "app-update.yml")).pipe(
        Effect.map(ReleaseFeed.repositoryOfUpdateConfig),
        Effect.orElseSucceed(() => Option.none()),
      )
    : Option.none();
  // GitHub's answer without following a redirect (ReleaseFeed.Answer); Electron's net.fetch with
  // redirect "manual" fails instead of answering, so this asks with net.request.
  const githubGet = (url: string) =>
    Effect.callback<ReleaseFeed.Answer, ReleaseFeed.ReleaseFeedError>((resume, signal) => {
      const request = Electron.net.request({ url, redirect: "manual" });
      const fail = (cause: unknown) =>
        resume(Effect.fail(new ReleaseFeed.ReleaseFeedError({ cause })));
      request.on("redirect", (status, _method, location) => {
        resume(Effect.succeed({ status, location, text: "" }));
        request.abort();
      });
      request.on("response", (response) => {
        const decoder = new TextDecoder();
        let text = "";
        response.on("data", (chunk) => {
          text += decoder.decode(chunk, { stream: true });
        });
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode,
              location: undefined,
              text: text + decoder.decode(),
            }),
          ),
        );
        response.on("error", fail);
      });
      request.on("error", fail);
      signal.addEventListener("abort", () => request.abort());
      request.end();
    }).pipe(Effect.timeout("30 seconds"));
  const updates = yield* Updates.make({
    appVersion: Electron.app.getVersion(),
    packaged: Electron.app.isPackaged,
    unsupported: yield* selfUpdateUnsupported,
    settingsPath: path.join(Electron.app.getPath("userData"), "updates.json"),
    stopHelpers: Scope.close(helpersScope, Exit.void),
    // The tailnet nodes hang on their helper's connection, so a failed install brings everything
    // back by starting the app again, unless the person is quitting it.
    restartHelpers: Effect.sync(() => {
      if (!quitting) Electron.app.relaunch();
      Electron.app.exit(0);
    }),
    channelHasRelease: (channel) =>
      Option.isSome(feedRepository)
        ? ReleaseFeed.channelHasRelease(feedRepository.value, channel, githubGet)
        : Effect.succeedNone,
  }).pipe(
    Effect.provide(ElectronUpdater.layer),
    Effect.provideService(DeviceActivity, deviceActivity),
  );
  const status = (): AppStatus => ({
    appVersion: Electron.app.getVersion(),
    generation: "GEN4",
    helpers: helpers.map((helper) => helper.status),
    tailnets: tailnets.current(),
    networkMissing: joining.networkMissing,
    updates: updates.current(),
    page,
  });
  // Every change of status goes to every local window, from before the first window exists. A
  // window reads the status after subscribing to these messages, so no change falls between.
  const broadcastStatus = () => {
    for (const contents of Hardening.localViews()) {
      contents.send(STATUS_CHANGED_CHANNEL, status());
    }
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => tailnets.subscribe(broadcastStatus)),
    (stop) => Effect.sync(stop),
  );
  yield* updates.changes.pipe(
    Stream.runForEach(() => Effect.sync(broadcastStatus)),
    Effect.forkScoped,
  );
  // Only the app's local windows may pick the channel or install (UpdatesIpc.ts).
  yield* UpdatesIpc.serve(updates);
  // Only the app's local windows see Agent Desktop's state and may press Stop (DeviceIpc.ts).
  yield* DeviceIpc.serve(deviceControls);
  // The app ends only when it quits: Quit in the tray, Cmd+Q on a Mac, a session that ends, or
  // opening the window failing. Closing the window hides it (Lifecycle.closeStep), so the app and
  // Agent Desktop run on.
  const quitRequested = yield* Deferred.make<void>();
  const endProgram = () => {
    Deferred.doneUnsafe(quitRequested, Effect.void);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // Only a window that is truly gone gets here; the app then has nothing to show.
      Electron.app.on("window-all-closed", endProgram);
    }),
    () => Effect.sync(() => Electron.app.off("window-all-closed", endProgram)),
  );
  yield* hooks.startGate;
  // Every quit while the program runs goes through its end (Lifecycle.beforeQuitStep): a
  // downloaded update installs first, a quit while that install waits for the computer joins it
  // (Updates.quitDecision), and the helpers stop before the app quits. The install quits the app
  // once its installer started.
  const services = yield* Effect.context<never>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const beforeQuit = (event: Electron.Event) => {
        quitting = true;
        event.preventDefault();
        const step = Lifecycle.beforeQuitStep(
          Updates.quitDecision(
            updates.current().state.phase,
            Effect.runSyncWith(services)(deviceActivity.reachable),
          ),
        );
        if (step === "end-program") {
          endProgram();
          return;
        }
        // An install that does not start (the channel changed meanwhile) lets the quit through.
        if (step === "install") {
          Effect.runForkWith(services)(
            updates.installOnQuit.pipe(
              Effect.flatMap((installed) =>
                installed ? Effect.void : Effect.sync(() => Electron.app.quit()),
              ),
            ),
          );
        }
      };
      Electron.app.on("before-quit", beforeQuit);
      ownQuitReady = true;
      return beforeQuit;
    }),
    // A quit while the app ends is held again: the helpers are stopping.
    (beforeQuit) =>
      Effect.sync(() => {
        ownQuitReady = false;
        Electron.app.off("before-quit", beforeQuit);
      }),
  );
  // A quit held while the app started goes its own way now.
  if (quitWasHeld) Electron.app.quit();
  // The icon in the notification area keeps the app reachable while its window is hidden; a Mac
  // keeps it in the Dock instead.
  const text = messages[localeOf(Electron.app.getLocale())];
  if (Lifecycle.keepsRunningInTray(platform)) {
    yield* Tray.serve({
      text: text.tray,
      show: showWindow,
      showStatus: () => setStatusShown(true),
      agentDesktop: openAgentDesktop,
      stopAgent: () => Effect.runForkWith(services)(Effect.ignore(deviceControls.stop)),
      quit: () => Electron.app.quit(),
      agentWorking: () => workingAgent(deviceControls.current()) !== null,
      changes: deviceControls.subscribe,
      menuBuilt: hooks.trayMenu,
      // Packaged under resources/icons (electron-builder.yml), in development from build/.
      iconPath: Electron.app.isPackaged
        ? path.join(process.resourcesPath, "icons", "icon.png")
        : path.join(appPath, "build", "icon.png"),
      iconBuilt: hooks.trayIcon,
    });
  }
  // The window's menu in the app's language instead of Electron's English default (AppMenu.ts).
  refreshMenu = () => {
    Electron.Menu.setApplicationMenu(
      Electron.Menu.buildFromTemplate(
        AppMenu.menuTemplate({
          text: text.menu,
          appName: APP_NAME,
          platform,
          statusShown,
          ...(Option.isSome(windowControls)
            ? windowControls.value.history()
            : { canGoBack: false, canGoForward: false }),
          actions: {
            toggleStatus: () => setStatusShown(!statusShown),
            openAgentDesktop,
            reloadPage: () => {
              if (Option.isSome(windowControls)) windowControls.value.reloadPage();
            },
            goBack: () => {
              if (Option.isSome(windowControls)) windowControls.value.goBack();
            },
            goForward: () => {
              if (Option.isSome(windowControls)) windowControls.value.goForward();
            },
            about: () => {
              void Electron.dialog.showMessageBox({
                type: "info",
                title: text.menu.about,
                message: APP_NAME,
                detail: text.menu.aboutDetail.replace("{version}", Electron.app.getVersion()),
              });
            },
          },
        }) as unknown as Array<Electron.MenuItemConstructorOptions>,
      ),
    );
    // On Windows and Linux that set the menu on the Agent Desktop window too, which has none.
    if (Option.isSome(devicePanel)) devicePanel.value.removeMenu();
  };
  refreshMenu();
  yield* WindowIpc.serve({
    setStatusShown,
    statusText: Effect.map(DateTime.now, (now) =>
      statusText({
        appName: APP_NAME,
        platform,
        status: status(),
        device: deviceControls.current(),
        at: DateTime.formatIso(now),
      }),
    ),
    signInAddress: tailnets.signInAddress,
    retryPage: Effect.promise(() =>
      Option.isSome(windowControls) ? windowControls.value.retryPage() : Promise.resolve(),
    ),
    firstPage: Effect.promise(() =>
      Option.isSome(windowControls) ? windowControls.value.firstPage() : Promise.resolve(),
    ),
  });
  // While an agent holds the computer, or the helper was lost and nothing confirmed that its work
  // ended, the status column with Stop or its warning shows by itself and stays in view
  // (docs/adr/0006), until Agent Desktop has a bar of its own.
  agentWorksNow = () => deviceControls.current().agent !== null;
  // The network setting written while the app runs starts it again, so the person restarts
  // nothing (SettingWatch, #81); the new start shows the window, even after one with --hidden.
  if (Option.isSome(joining.setting)) {
    yield* SettingWatch.watch({
      atStart: joining.setting.value,
      read: settingNowOn(yield* HostProcess.Platform),
      agentWorks: () => agentWorksNow(),
      startAgain: Effect.suspend(() =>
        restartRequested
          ? Effect.void
          : hooks.notice(text.networkFound).pipe(Effect.andThen(restartOnce(argsWithoutHidden()))),
      ),
    });
  }
  let agentWorked = false;
  const showWhileAgentWorks = () => {
    const works = agentWorksNow();
    if (works && !agentWorked) setStatusShown(true);
    else if (works) keepWindowInView();
    agentWorked = works;
  };
  // Agent Desktop's bar over the page while an agent holds the computer (src/ui/AgentBar.tsx): a
  // local view with the bridge, laid out again whenever Agent Desktop's state changes. It is made
  // when the main window first takes it, after its status column, and loads once the column's page
  // has loaded (showOnLoad), so the column stays the window's first page; it closes with the scope.
  let agentBarView = Option.none<Electron.WebContentsView>();
  const agentBar = (): Electron.WebContentsView => {
    if (Option.isSome(agentBarView)) return agentBarView.value;
    const view = new Electron.WebContentsView(
      MainWindow.localViewOptions(path.join(appPath, "dist-electron", "preload.cjs")),
    );
    Hardening.registerView(view.webContents, "Local");
    agentBarView = Option.some(view);
    return view;
  };
  const loadAgentBar = () => {
    const view = agentBar();
    if (view.webContents.getURL() === "") {
      void view.webContents.loadURL(`${LocalScheme.LOCAL_ENTRY}?view=agent-bar`);
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (Option.isSome(agentBarView) && !agentBarView.value.webContents.isDestroyed()) {
        agentBarView.value.webContents.close();
      }
    }),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      deviceControls.subscribe(() => {
        showWhileAgentWorks();
        if (Option.isSome(windowControls)) windowControls.value.relayout();
      }),
    ),
    (stop) => Effect.sync(stop),
  );
  // The helper may have been lost, or an agent may work, before this subscription.
  showWhileAgentWorks();
  // And every second, as the system does not report every way a window hides (a Mac reports no
  // programmatic hide), so a window minimized or hidden during the work shows again.
  yield* Effect.sync(keepWindowInView).pipe(
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );
  const hiddenNotice = yield* Lifecycle.noticeOnce(
    path.join(Electron.app.getPath("userData"), "tray.json"),
    hooks.notice(text.tray.hiddenNotice),
  );
  yield* Effect.raceFirst(
    MainWindow.open({
      preloadPath: path.join(appPath, "dist-electron", "preload.cjs"),
      status,
      remoteUrl: yield* remoteUrlOf(hooks.remoteUrl),
      whenReachable: tailnets.whenReachable,
      historyChanged: () => refreshMenu(),
      pageShown: (url) => {
        if (Option.isSome(switches)) switches.value.pageShown(url);
      },
      pageOutcome: (outcome) => {
        page = outcome;
        broadcastStatus();
      },
      networkMissing: () => joining.networkMissing,
      servedByTailnet: (address) => {
        const url = URL.parse(address);
        return url !== null && Option.isSome(tailnets.proxyFor(url.hostname));
      },
      created: (window) => {
        mainWindow = Option.some(window);
        window.on("minimize", keepWindowInView);
        window.on("hide", keepWindowInView);
        if (agentDesktopWanted) {
          agentDesktopWanted = false;
          openAgentDesktop();
        }
      },
      // Agent Desktop's bar while an agent holds the computer (src/ui/AgentBar.tsx).
      topBar: {
        get view() {
          return agentBar();
        },
        height: () => agentBarHeight(deviceControls.current()),
      },
      // Called once the column's page has loaded: the bar's page follows it.
      showOnLoad: () => {
        loadAgentBar();
        return showWanted;
      },
      closeStep: () => Lifecycle.closeStep(quitting, agentWorksNow()),
      hidden: () => {
        showWanted = false;
        if (Lifecycle.keepsRunningInTray(platform)) Effect.runForkWith(services)(hiddenNotice);
      },
      sessionEnds: () => Electron.app.quit(),
      statusShown: () => statusShown,
      controls: (controls) => {
        windowControls = Option.some(controls);
      },
    }).pipe(Effect.andThen(Effect.never)),
    Deferred.await(quitRequested),
  );
  // A downloaded update installs when the app ends, or the install a quit started finishes first.
  quitting = true;
  yield* updates.installOnQuit;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => Electron.app.quit())),
  ),
);
