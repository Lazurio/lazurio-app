import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as RemoteUrl from "./RemoteUrl.ts";

describe("the main window's page of the web Lazurio", () => {
  const development = "https://dashboard.lazurio.ai/sign-in";
  const test = "http://127.0.0.1:4173/";
  const unpackaged = {
    packaged: false,
    test: Option.none<string>(),
    development: Option.none<string>(),
  };
  const shows = (address: string) => ({
    remoteUrl: Option.some(address),
    developmentRefused: false,
  });
  const noPage = { remoteUrl: Option.none<string>(), developmentRefused: false };
  const refused = { remoteUrl: Option.none<string>(), developmentRefused: true };

  it("is none without a setting", () => {
    assert.deepStrictEqual(RemoteUrl.choose(unpackaged), noPage);
  });

  it("is a development page of Lazurio over HTTPS", () => {
    for (const address of [
      development,
      "https://auth.lazurio.ai/realms/lazurio/account",
      "https://launchpad.someone.lazurio.io/apps",
    ]) {
      const choice = RemoteUrl.choose({ ...unpackaged, development: Option.some(address) });
      assert.deepStrictEqual(choice, shows(address), address);
    }
  });

  it("is none for a development page anywhere else, which the app reports", () => {
    for (const address of [
      "http://dashboard.lazurio.ai/sign-in",
      "https://lazurio.ai/",
      "https://dashboard.lazurio.ai.example.com/",
      "https://github.com/login",
      "https://someone@dashboard.lazurio.ai/",
      "lazurio-app://shell/index.html",
      "file:///etc/passwd",
      "no address",
      "",
    ]) {
      const choice = RemoteUrl.choose({ ...unpackaged, development: Option.some(address) });
      assert.deepStrictEqual(choice, refused, address);
    }
  });

  it("takes neither setting in a packaged app", () => {
    for (const settings of [
      { test: Option.none<string>(), development: Option.some(development) },
      { test: Option.some(test), development: Option.some(development) },
      { test: Option.some(test), development: Option.none<string>() },
    ]) {
      assert.deepStrictEqual(RemoteUrl.choose({ packaged: true, ...settings }), noPage);
    }
  });

  it("is the end-to-end tests' page before any development page", () => {
    for (const other of [development, "https://example.com/"]) {
      const choice = RemoteUrl.choose({
        ...unpackaged,
        test: Option.some(test),
        development: Option.some(other),
      });
      assert.deepStrictEqual(choice, shows(test), other);
    }
  });
});
