import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import { STATUS_CHANGED_CHANNEL, type AppStatus, type UpdatesOffReason } from "../shared/bridge.ts";
import { localeOf } from "../ui/messages.ts";

import * as AuthClient from "./AuthClient.ts";
import { DeviceActivity } from "./DeviceActivity.ts";
import * as DeviceEnvironments from "./DeviceEnvironments.ts";
import * as DeviceIpc from "./DeviceIpc.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceSwitches from "./DeviceSwitches.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";
import * as Hardening from "./Hardening.ts";
import * as KeystoreCheck from "./KeystoreCheck.ts";
import * as Helpers from "./Helpers.ts";
import * as LocalScheme from "./LocalScheme.ts";
import * as MainWindow from "./MainWindow.ts";
import * as NodeKeys from "./NodeKeys.ts";
import * as RemoteUrl from "./RemoteUrl.ts";
import * as Tailnet from "./Tailnet.ts";
import * as TailnetDirectory from "./TailnetDirectory.ts";
import * as TailnetPolicy from "./TailnetPolicy.ts";
import * as Updates from "./Updates.ts";
import * as UpdatesIpc from "./UpdatesIpc.ts";

// Lazurio App GEN4 (decision 0248): the main process. It serves the app's own windows, guards
// every web contents, starts the helper processes and opens the main window.

LocalScheme.registerPrivilegesSync();
Electron.app.enableSandbox();

// The app's sign-in opens in the system's browser (AuthClient, RFC 8252).
const openInSystemBrowser = (address: string) =>
  Effect.tryPromise({
    try: () => Electron.shell.openExternal(address),
    catch: () => new AuthClient.SignInError({ reason: "browser" }),
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
    helperPids[name] = pid;
  };
  const openBrowser = (address: string) => Effect.sync(() => observer.openExternally(address));
  return {
    observer,
    remoteUrl,
    tailnetHelper,
    deviceHelper,
    authIssuer,
    openBrowser,
    helperStarted,
  };
});

// The tailnets a packaged app joins (TailnetDirectory, ADR 0008): on Windows an IT policy, when the
// computer's IT set one (TailnetPolicy, Lazurio App (Alpha) at a client), and the directory built into the
// app otherwise. Development may set them as a JSON array of Tailnet.TailnetConfig in
// LAZURIO_APP_DEV_TAILNETS and joins none otherwise.
const packagedDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const builtIn = path.join(process.resourcesPath, "tailnets", "directory.json");
  if ((yield* HostProcess.Platform) !== "win32") {
    return {
      source: "built-in",
      directory: yield* TailnetDirectory.fromFile(builtIn, NodeOS.hostname()),
    };
  }
  // The packaged tailnet helper reads the policy through the registry's API.
  const helper = path.join(process.resourcesPath, "helpers", "lazurio-tailnet.exe");
  const policy = yield* TailnetPolicy.readWindows(helper).pipe(
    Effect.tapError((error) => Effect.logWarning("cannot read the tailnet policy", error)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(policy)) {
    return {
      source: "built-in",
      directory: yield* TailnetDirectory.fromFile(builtIn, NodeOS.hostname()),
    };
  }
  // A policy that IT set but that does not decode joins nothing, rather than the built-in directory.
  const directory = yield* TailnetDirectory.fromText(policy.value, NodeOS.hostname()).pipe(
    Effect.tapError((error) => Effect.logError("the tailnet policy does not decode", error)),
    Effect.orElseSucceed((): TailnetDirectory.Directory => ({ tailnets: [], refused: [] })),
  );
  return { source: "policy", directory };
});

const tailnetsToJoin = Effect.gen(function* () {
  if (Electron.app.isPackaged) {
    const { source, directory } = yield* packagedDirectory;
    for (const refused of directory.refused) {
      yield* Effect.logWarning("tailnet refused", { source, ...refused });
    }
    yield* Effect.logInfo("tailnets", {
      source,
      tailnets: directory.tailnets.map((tailnet) => tailnet.tailnet),
    });
    return directory.tailnets;
  }
  const setting = yield* Config.option(Config.String("LAZURIO_APP_DEV_TAILNETS"));
  return Option.isSome(setting) ? yield* Tailnet.decodeTailnets(setting.value) : [];
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
  yield* Effect.promise(() => Electron.app.whenReady());
  const appPath = Electron.app.getAppPath();

  yield* Hardening.guardAllWebContents(hooks.observer);
  yield* Hardening.hardenSession(Electron.session.defaultSession);
  yield* LocalScheme.serve(path.join(appPath, "dist-ui"));

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
  const tailnetHelper = helpers.find((helper) => helper.status.name === "lazurio-tailnet");
  const tailnets: Tailnet.Tailnets =
    tailnetHelper !== undefined && Option.isSome(tailnetHelper.connection)
      ? yield* Tailnet.run({
          connection: tailnetHelper.connection.value,
          tailnets: yield* tailnetsToJoin,
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
        }),
      )
    : Option.none<DeviceSwitches.DeviceSwitches>();
  const noSwitch = Effect.fail(new DeviceSwitches.DeviceSwitchError({ problem: "not-listed" }));
  const deviceControls: DeviceIpc.DeviceControls = Option.match(switches, {
    onSome: (service) => service,
    onNone: () => ({
      current: () => DeviceService.withoutHelper(deviceHelper === undefined ? "absent" : "failed"),
      subscribe: () => () => {},
      stop: Effect.void,
      setSwitch: () => noSwitch,
      addEnvironment: () => noSwitch,
      removeEnvironment: () => noSwitch,
      signOut: Effect.void,
    }),
  });
  // The updater's view of the computer: the configured helper's, or the default (always idle).
  const idleByDefault = yield* DeviceActivity;
  const deviceActivity = Option.getOrElse(
    Option.flatMap(device, (service) => service.activity),
    () => idleByDefault,
  );
  // Set once the person quits or closes the last window: a failed install then lets the app end
  // instead of starting it again.
  let quitting = false;
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
  }).pipe(
    Effect.provide(ElectronUpdater.layer),
    Effect.provideService(DeviceActivity, deviceActivity),
  );
  const status = (): AppStatus => ({
    appVersion: Electron.app.getVersion(),
    generation: "GEN4",
    helpers: helpers.map((helper) => helper.status),
    tailnets: tailnets.current(),
    updates: updates.current(),
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
  // The app ends when its windows are closed, also while the main window is still opening (its
  // remote page may wait for a tailnet's sign-in), and when opening it fails.
  const allWindowsClosed = Effect.callback<void>((resume) => {
    const listener = () => resume(Effect.void);
    Electron.app.once("window-all-closed", listener);
    return Effect.sync(() => {
      Electron.app.off("window-all-closed", listener);
    });
  });
  // Quitting the app another way than closing its windows (Cmd+Q on a Mac, SIGTERM from a session
  // that logs out, or the update test on Linux) installs a downloaded update first, and a quit while
  // that install waits for the computer joins it (Updates.quitDecision). The install quits the app
  // once its installer started.
  const services = yield* Effect.context<never>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const beforeQuit = (event: Electron.Event) => {
        quitting = true;
        const decision = Updates.quitDecision(
          updates.current().state.phase,
          Effect.runSyncWith(services)(deviceActivity.reachable),
        );
        if (decision === "quit") return;
        event.preventDefault();
        // An install that does not start (the channel changed meanwhile) lets the quit through.
        if (decision === "install") {
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
      return beforeQuit;
    }),
    (beforeQuit) =>
      Effect.sync(() => {
        Electron.app.off("before-quit", beforeQuit);
      }),
  );
  yield* Effect.raceFirst(
    MainWindow.open({
      preloadPath: path.join(appPath, "dist-electron", "preload.cjs"),
      status,
      remoteUrl: yield* remoteUrlOf(hooks.remoteUrl),
      whenReachable: tailnets.whenReachable,
      pageShown: (url) => {
        if (Option.isSome(switches)) switches.value.pageShown(url);
      },
    }).pipe(Effect.andThen(Effect.never)),
    allWindowsClosed,
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
