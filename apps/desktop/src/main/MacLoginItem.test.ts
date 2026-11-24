import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ensure, installedBundle, LABEL, launchAgent } from "./MacLoginItem.ts";

const HOME = "/Users/bob";

describe("the start at the sign-in to the Mac", () => {
  it("starts only the app installed in an Applications folder", () => {
    assert.deepStrictEqual(
      installedBundle("/Applications/Lazurio App.app/Contents/MacOS/Lazurio App", HOME),
      Option.some("/Applications/Lazurio App.app"),
    );
    assert.deepStrictEqual(
      installedBundle(`${HOME}/Applications/Lazurio App.app/Contents/MacOS/Lazurio App`, HOME),
      Option.some(`${HOME}/Applications/Lazurio App.app`),
    );
    // A trial build unpacked elsewhere, a helper inside the bundle, development.
    for (const executable of [
      `${HOME}/Downloads/Lazurio App.app/Contents/MacOS/Lazurio App`,
      "/Applications/Lazurio App.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      "/usr/local/bin/electron",
    ]) {
      assert.deepStrictEqual(installedBundle(executable, HOME), Option.none(), executable);
    }
  });

  it("opens the app in the background and hidden, with its path escaped", () => {
    const plist = launchAgent("/Applications/A & B <x>.app");
    assert.include(plist, `<string>${LABEL}</string>`);
    assert.include(
      plist,
      "<string>/usr/bin/open</string>\n    <string>-g</string>\n    <string>-a</string>\n    <string>/Applications/A &amp; B &lt;x&gt;.app</string>\n    <string>--args</string>\n    <string>--hidden</string>",
    );
    assert.include(plist, "<key>RunAtLoad</key>\n  <true/>");
  });

  it.effect("writes the agent once, and again only when the app moved", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const file = (yield* Path.Path).join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
      assert.isTrue(yield* ensure(home, "/Applications/Lazurio App.app"));
      assert.isFalse(yield* ensure(home, "/Applications/Lazurio App.app"));
      assert.strictEqual(
        yield* fileSystem.readFileString(file),
        launchAgent("/Applications/Lazurio App.app"),
      );
      assert.isTrue(yield* ensure(home, `${home}/Applications/Lazurio App.app`));
      assert.isFalse(yield* fileSystem.exists(`${file}.new`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
