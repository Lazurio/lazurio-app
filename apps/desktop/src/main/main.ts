import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Electron from "electron";

import * as Hardening from "./Hardening.ts";
import * as Helpers from "./Helpers.ts";
import * as LocalScheme from "./LocalScheme.ts";
import * as MainWindow from "./MainWindow.ts";

// Lazurio App GEN4 (decision 0248): the main process. It serves the app's own windows, guards
// every web contents, starts the helper processes and opens the main window.

LocalScheme.registerPrivilegesSync();
Electron.app.enableSandbox();

// End-to-end tests only, and never in a packaged app: a remote page to load, and a system
// browser that records instead of opening.
const testHooks = Effect.gen(function* () {
  const enabled =
    !Electron.app.isPackaged &&
    (yield* Config.Boolean("LAZURIO_APP_E2E").pipe(Config.withDefault(false)));
  if (!enabled)
    return { systemBrowser: Hardening.electronSystemBrowser, remoteUrl: Option.none<string>() };
  const remoteUrl = yield* Config.option(Config.String("LAZURIO_APP_E2E_REMOTE_URL"));
  const systemBrowser: Hardening.SystemBrowser = {
    open: (url) => {
      process.stdout.write(`lazurio-app-e2e system-browser ${url}\n`);
    },
  };
  return { systemBrowser, remoteUrl };
});

const helperBinaries = Effect.gen(function* () {
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
    {
      name: "lazurio-tailnet",
      path: path.join(repository, "helpers", "tailnet", "bin", executable("lazurio-tailnet")),
    },
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

const program = Effect.gen(function* () {
  const hooks = yield* testHooks;
  yield* Effect.promise(() => Electron.app.whenReady());
  const path = yield* Path.Path;
  const appPath = Electron.app.getAppPath();

  yield* Hardening.guardAllWebContents(hooks.systemBrowser);
  yield* Hardening.hardenSession(Electron.session.defaultSession);
  yield* LocalScheme.serve(path.join(appPath, "dist-ui"));

  const helpers = yield* Helpers.startAll(yield* helperBinaries);
  yield* MainWindow.open({
    preloadPath: path.join(appPath, "dist-electron", "preload.cjs"),
    status: { appVersion: Electron.app.getVersion(), generation: "GEN4", helpers },
    remoteUrl: hooks.remoteUrl,
  });

  yield* Effect.callback<void>((resume) => {
    Electron.app.once("window-all-closed", () => resume(Effect.void));
  });
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => Electron.app.quit())),
  ),
);
