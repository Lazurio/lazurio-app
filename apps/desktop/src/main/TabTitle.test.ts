import { assert, describe, it } from "@effect/vitest";

import { tabTitleOf } from "./TabTitle.ts";

describe("a tab's name from its address", () => {
  it("names an Environment's own services by the Environment", () => {
    assert.deepStrictEqual(tabTitleOf("https://launchpad.env.example.lazurio.io/"), {
      app: "apps",
      place: "env",
    });
    assert.deepStrictEqual(tabTitleOf("https://launchpad.env.example.lazurio.io/settings/tools"), {
      app: "settings",
      place: "env",
    });
    assert.deepStrictEqual(tabTitleOf("https://launchpad.env.example.lazurio.io/settingsx"), {
      app: "apps",
      place: "env",
    });
    assert.deepStrictEqual(tabTitleOf("https://t3code.env.example.lazurio.io/chat/1"), {
      app: "chat",
      place: "env",
    });
    assert.deepStrictEqual(tabTitleOf("https://mausbot.env.example.lazurio.io/"), {
      app: "automations",
      place: "env",
    });
  });

  it("names a module's STAGING by the module and the Environment", () => {
    assert.deepStrictEqual(tabTitleOf("https://notes.env.example.lazurio.io/a?b#c"), {
      app: "module",
      module: "notes",
      place: "env",
    });
  });

  it("names an Application by the module and the Organization", () => {
    assert.deepStrictEqual(tabTitleOf("https://notes.example.lazurio.app/"), {
      app: "module",
      module: "notes",
      place: "example",
    });
    // A name of the wrong depth is no Application.
    assert.deepStrictEqual(tabTitleOf("https://example.lazurio.app/"), { app: "lazurio" });
  });

  it("names sign-in pages and the Organization's overview", () => {
    assert.deepStrictEqual(tabTitleOf("https://auth.lazurio.ai/realms/workspace"), {
      app: "sign-in",
    });
    assert.deepStrictEqual(tabTitleOf("https://github.com/login"), { app: "sign-in" });
    assert.deepStrictEqual(tabTitleOf("https://env.example.lazurio.io/oauth2/start"), {
      app: "sign-in",
      place: "env",
    });
    assert.deepStrictEqual(tabTitleOf("https://dashboard.lazurio.ai/"), { app: "overview" });
  });

  it("names a tab without a page yet, and never takes a look-alike's name", () => {
    assert.deepStrictEqual(tabTitleOf("about:blank"), { app: "new" });
    assert.deepStrictEqual(tabTitleOf(""), { app: "new" });
    assert.deepStrictEqual(tabTitleOf("https://notes.env.evil-lazurio.io/"), { app: "lazurio" });
    assert.deepStrictEqual(tabTitleOf("http://127.0.0.1:8080/first"), { app: "lazurio" });
  });

  it("ignores case and the root's dot", () => {
    assert.deepStrictEqual(tabTitleOf("https://Notes.Env.Example.Lazurio.IO./"), {
      app: "module",
      module: "notes",
      place: "env",
    });
  });
});
