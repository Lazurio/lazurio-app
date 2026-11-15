import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Electron from "electron";

import { STATUS_CHANGED_CHANNEL, type AppStatus } from "../shared/bridge.ts";

import * as Hardening from "./Hardening.ts";
import * as Helpers from "./Helpers.ts";
import * as LocalScheme from "./LocalScheme.ts";
import * as MainWindow from "./MainWindow.ts";
import * as NodeKeys from "./NodeKeys.ts";
import * as Tailnet from "./Tailnet.ts";

// Lazurio App GEN4 (decision 0248): the main process. It serves the app's own windows, guards
// every web contents, starts the helper processes and opens the main window.

LocalScheme.registerPrivilegesSync();
Electron.app.enableSandbox();

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
  const observer: Hardening.NavigationObserver = {
    openExternally: (url) => {
      process.stdout.write(`lazurio-app-e2e system-browser ${url}\n`);
    },
    refused: (url, frame) => {
      process.stdout.write(`lazurio-app-e2e refused ${frame} ${url}\n`);
    },
  };
  return { observer, remoteUrl, tailnetHelper };
});

// Development only, and never in a packaged app: the tailnets to join, as a JSON array of
// Tailnet.TailnetConfig. A released app gets them from the person's Lazurio account.
const developmentTailnets = Effect.gen(function* () {
  if (Electron.app.isPackaged) return [];
  const setting = yield* Config.option(Config.String("LAZURIO_APP_DEV_TAILNETS"));
  return Option.isSome(setting) ? yield* Tailnet.decodeTailnets(setting.value) : [];
});

const helperBinaries = Effect.fn("main.helperBinaries")(function* (
  testTailnetHelper: Option.Option<Helpers.HelperBinary>,
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
    {
      name: "lazurio-device",
      path: path.join(
        repository,
        "helpers",
        "device",
        "target",
        "debug",
        executable("lazurio-device"),
      ),
    },
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

const program = Effect.gen(function* () {
  const hooks = yield* testHooks;
  yield* Effect.promise(() => Electron.app.whenReady());
  const path = yield* Path.Path;
  const appPath = Electron.app.getAppPath();

  yield* Hardening.guardAllWebContents(hooks.observer);
  yield* Hardening.hardenSession(Electron.session.defaultSession);
  yield* LocalScheme.serve(path.join(appPath, "dist-ui"));

  const helpers = yield* Helpers.startAll(yield* helperBinaries(hooks.tailnetHelper));
  const fileSystem = yield* FileSystem.FileSystem;
  const keystore = keystoreOn(yield* HostProcess.Platform, !Electron.app.isPackaged);
  const stateRoot = path.join(Electron.app.getPath("userData"), "tailnets");
  const tailnetHelper = helpers.find((helper) => helper.status.name === "lazurio-tailnet");
  const tailnets: Tailnet.Tailnets =
    tailnetHelper !== undefined && Option.isSome(tailnetHelper.connection)
      ? yield* Tailnet.run({
          connection: tailnetHelper.connection.value,
          tailnets: yield* developmentTailnets,
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
  const status = (): AppStatus => ({
    appVersion: Electron.app.getVersion(),
    generation: "GEN4",
    helpers: helpers.map((helper) => helper.status),
    tailnets: tailnets.current(),
  });
  // Every change of status goes to every local window, from before the first window exists. A
  // window reads the status after subscribing to these messages, so no change falls between.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      tailnets.subscribe(() => {
        for (const contents of Hardening.localViews()) {
          contents.send(STATUS_CHANGED_CHANNEL, status());
        }
      }),
    ),
    (stop) => Effect.sync(stop),
  );
  // The app ends when its windows are closed, also while the main window is still opening (its
  // remote page may wait for a tailnet's sign-in), and when opening it fails.
  const allWindowsClosed = Effect.callback<void>((resume) => {
    const listener = () => resume(Effect.void);
    Electron.app.once("window-all-closed", listener);
    return Effect.sync(() => {
      Electron.app.off("window-all-closed", listener);
    });
  });
  yield* Effect.raceFirst(
    MainWindow.open({
      preloadPath: path.join(appPath, "dist-electron", "preload.cjs"),
      status,
      remoteUrl: hooks.remoteUrl,
      whenReachable: tailnets.whenReachable,
    }).pipe(Effect.andThen(Effect.never)),
    allWindowsClosed,
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => Electron.app.quit())),
  ),
);
