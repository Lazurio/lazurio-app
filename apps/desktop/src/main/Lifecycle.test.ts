import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { messages } from "../ui/messages.ts";
import {
  APP_USER_MODEL_ID,
  beforeQuitStep,
  secondStart,
  closeStep,
  keepsRunningInTray,
  loginItem,
  noticeOnce,
  startQuitStep,
  startsHidden,
  trayMenu,
} from "./Lifecycle.ts";

describe("Lifecycle", () => {
  it("hides the window when it closes, and closes it only while the app quits", () => {
    assert.strictEqual(closeStep(false), "hide");
    assert.strictEqual(closeStep(true), "close");
  });

  it("keeps running in the notification area on Windows and Linux, and in the Dock on a Mac", () => {
    assert.isTrue(keepsRunningInTray("win32"));
    assert.isTrue(keepsRunningInTray("linux"));
    assert.isFalse(keepsRunningInTray("darwin"));
  });

  it("sends every quit through the program's own end while it runs", () => {
    // Quit from the tray (app.quit), Cmd+Q or a session's end: the program installs a ready update
    // or joins an install, stops the helpers, and only then quits.
    assert.strictEqual(beforeQuitStep("quit"), "end-program");
    assert.strictEqual(beforeQuitStep("install"), "install");
    assert.strictEqual(beforeQuitStep("wait"), "wait");
  });

  it("holds a quit that comes while the app starts, until its own quit is ready", () => {
    // Before the proper before-quit is registered, and again once it is released while the app
    // ends: a quit then would end Electron without stopping the helpers.
    assert.strictEqual(startQuitStep(false), "hold");
    assert.strictEqual(startQuitStep(true), "pass");
  });

  it("starts hidden only when started with --hidden", () => {
    assert.isTrue(startsHidden(["Lazurio App.exe", "--hidden"]));
    assert.isFalse(startsHidden(["Lazurio App.exe"]));
    assert.isFalse(startsHidden(["electron", ".", "--hidden-thing"]));
  });

  it("quits on a second start with --quit, and shows the window on any other", () => {
    assert.strictEqual(secondStart(["Lazurio App.exe", "--quit"]), "quit");
    assert.strictEqual(secondStart(["Lazurio App.exe"]), "show");
    assert.strictEqual(secondStart(["Lazurio App.exe", "--hidden"]), "show");
  });

  it("starts at the sign-in to Windows only from a packaged app on Windows", () => {
    assert.deepStrictEqual(
      loginItem({ platform: "win32", packaged: true }),
      Option.some({ openAtLogin: true, args: ["--hidden"], name: "io.lazurio.app" }),
    );
    assert.isTrue(Option.isNone(loginItem({ platform: "win32", packaged: false })));
    assert.isTrue(Option.isNone(loginItem({ platform: "darwin", packaged: true })));
    assert.isTrue(Option.isNone(loginItem({ platform: "linux", packaged: true })));
  });

  it.effect(
    "names the AppUserModelID of the shortcut, and the uninstaller removes its Run value",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const desktop = path.resolve(import.meta.dirname, "..", "..");
        const builder = yield* fileSystem.readFileString(
          path.join(desktop, "electron-builder.yml"),
        );
        assert.include(builder.split("\n"), `appId: ${APP_USER_MODEL_ID}`);
        const installer = yield* fileSystem.readFileString(
          path.join(desktop, "build", "installer.nsh"),
        );
        assert.include(
          installer,
          `DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_USER_MODEL_ID}"`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("offers Open and Quit in the tray's menu, in either language", () => {
    const calls: Array<string> = [];
    const actions = {
      show: () => calls.push("show"),
      quit: () => calls.push("quit"),
    };
    const cs = trayMenu(messages.cs.tray, actions);
    assert.deepStrictEqual(
      cs.map((item) => item.label),
      ["Otevřít Lazurio App (Alpha)", "Ukončit Lazurio App (Alpha)"],
    );
    for (const item of cs) item.click();
    assert.deepStrictEqual(calls, ["show", "quit"]);
    assert.deepStrictEqual(
      trayMenu(messages.en.tray, actions).map((item) => item.label),
      ["Open Lazurio App (Alpha)", "Quit Lazurio App (Alpha)"],
    );
  });

  it.effect("shows the notice of the first hidden window once, also across starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const path = (yield* Path.Path).join(directory, "tray.json");
      let shown = 0;
      const show = Effect.sync(() => {
        shown += 1;
      });
      const first = yield* noticeOnce(path, show);
      yield* first;
      yield* first;
      assert.strictEqual(shown, 1);
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(path)), {
        hiddenNoticeShown: true,
      });
      // The app starts again.
      yield* yield* noticeOnce(path, show);
      assert.strictEqual(shown, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("has saved the notice before it says it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const path = (yield* Path.Path).join(directory, "tray.json");
      let savedWhenShown: unknown = null;
      const notice = yield* noticeOnce(
        path,
        fileSystem.readFileString(path).pipe(
          Effect.map((text) => JSON.parse(text)),
          Effect.orElseSucceed(() => "missing"),
          Effect.map((saved) => {
            savedWhenShown = saved;
          }),
        ),
      );
      yield* notice;
      assert.deepStrictEqual(savedWhenShown, { hiddenNoticeShown: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shows the notice once per run when it cannot be saved", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      // A directory where the file belongs: the save fails.
      const path = (yield* Path.Path).join(directory, "tray.json");
      yield* fileSystem.makeDirectory(path);
      let shown = 0;
      const notice = yield* noticeOnce(
        path,
        Effect.sync(() => {
          shown += 1;
        }),
      );
      yield* notice;
      yield* notice;
      assert.strictEqual(shown, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
