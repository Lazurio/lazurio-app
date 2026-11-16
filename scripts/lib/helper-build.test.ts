import { assert, describe, it } from "@effect/vitest";

import { appVersionArgument, helperBuild } from "./helper-build.ts";

describe("helperBuild", () => {
  it("gives a release build the app's version in both helpers", () => {
    const build = helperBuild({
      release: true,
      appVersion: "0.1.0-nightly.20261116.7",
      tailnetOutput: "bin/lazurio-tailnet",
    });
    assert.deepStrictEqual(build, {
      go: [
        "-C",
        "helpers/tailnet",
        "build",
        "-trimpath",
        "-ldflags",
        "-X main.version=0.1.0-nightly.20261116.7",
        "-o",
        "bin/lazurio-tailnet",
        ".",
      ],
      cargo: ["build", "--locked", "--release"],
      cargoEnv: { LAZURIO_APP_VERSION: "0.1.0-nightly.20261116.7" },
    });
  });

  it("keeps a development build on the helpers' own development versions", () => {
    const build = helperBuild({ release: false, appVersion: "0.1.0", tailnetOutput: "bin/x" });
    assert.deepStrictEqual(build, {
      go: ["-C", "helpers/tailnet", "build", "-trimpath", "-o", "bin/x", "."],
      cargo: ["build", "--locked"],
      // A development build never inherits the release's version from the shell.
      cargoEnv: { LAZURIO_APP_VERSION: undefined },
    });
  });

  it("refuses a release version that could carry another flag", () => {
    for (const appVersion of ["", "0.1", "0.1.0 -X main.other=1", "v0.1.0"]) {
      const build = helperBuild({ release: true, appVersion, tailnetOutput: "bin/x" });
      assert.deepStrictEqual(build, { invalidVersion: appVersion });
    }
  });
});

describe("appVersionArgument", () => {
  it("reads --app-version and nothing else", () => {
    assert.strictEqual(appVersionArgument(["--release", "--app-version", "0.2.0"]), "0.2.0");
    assert.isUndefined(appVersionArgument(["--release"]));
  });
});
