import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { channelOfVersion, encodeSettings, isOffered, settingsFrom } from "./UpdateChannel.ts";

describe("channelOfVersion", () => {
  it("reads a nightly from its version and anything else as stable", () => {
    assert.strictEqual(channelOfVersion("0.2.0-nightly.20261116.42"), "nightly");
    assert.strictEqual(channelOfVersion("0.2.0"), "latest");
    assert.strictEqual(channelOfVersion("0.0.0"), "latest");
    assert.strictEqual(channelOfVersion("0.2.0-preview.20261116.1"), "latest");
  });
});

describe("isOffered", () => {
  const offered = (running: string, version: string, channel: "latest" | "nightly") =>
    isOffered({ running, offered: version, channel });

  it("takes a newer stable on stable and never an older or the same one", () => {
    assert.isTrue(offered("0.1.0", "0.1.1", "latest"));
    assert.isTrue(offered("0.1.9", "0.2.0", "latest"));
    assert.isTrue(offered("0.9.0", "1.0.0", "latest"));
    assert.isFalse(offered("0.1.1", "0.1.0", "latest"));
    assert.isFalse(offered("0.1.0", "0.1.0", "latest"));
  });

  it("compares numbers, not text", () => {
    assert.isTrue(offered("0.9.0", "0.10.0", "latest"));
    assert.isTrue(offered("0.2.0-nightly.20261116.9", "0.2.0-nightly.20261116.10", "nightly"));
  });

  it("orders nightlies by core, date and run, and below the stable they lead to", () => {
    assert.isTrue(offered("0.2.0-nightly.20261116.5", "0.2.0-nightly.20261117.6", "nightly"));
    assert.isTrue(offered("0.1.0", "0.2.0-nightly.20261116.5", "nightly"));
    assert.isFalse(offered("0.2.0", "0.2.0-nightly.20261116.5", "nightly"));
    assert.isFalse(offered("0.2.0-nightly.20261117.6", "0.2.0-nightly.20261116.5", "nightly"));
  });

  it("offers only versions of the selected channel", () => {
    assert.isFalse(offered("0.1.0", "0.2.0-nightly.20261116.5", "latest"));
    assert.isFalse(offered("0.2.0-nightly.20261116.5", "0.3.0", "nightly"));
  });

  it("keeps a nightly that switched to stable until a stable is newer, never downgrading", () => {
    assert.isFalse(offered("0.2.0-nightly.20261116.5", "0.1.0", "latest"));
    assert.isTrue(offered("0.2.0-nightly.20261116.5", "0.2.0", "latest"));
  });

  it("never offers a version of another shape", () => {
    assert.isFalse(offered("0.1.0", "0.2.0-beta.1", "latest"));
    assert.isFalse(offered("0.1.0", "v0.2.0", "latest"));
    assert.isFalse(offered("0.1.0", "", "latest"));
  });
});

describe("settingsFrom", () => {
  it("starts a build on its own channel without a file", () => {
    assert.deepStrictEqual(settingsFrom(Option.none(), "0.1.0"), { channel: "latest" });
    assert.deepStrictEqual(settingsFrom(Option.none(), "0.2.0-nightly.20261116.5"), {
      channel: "nightly",
    });
  });

  it("keeps the person's choice and reads back what it writes", () => {
    const written = encodeSettings({ channel: "nightly" });
    assert.deepStrictEqual(settingsFrom(Option.some(written), "0.1.0"), { channel: "nightly" });
  });

  it("falls back to the build's channel for a file that does not decode", () => {
    for (const text of ["", "{", "[]", '{"channel":"beta"}', '{"channel":1}']) {
      assert.deepStrictEqual(settingsFrom(Option.some(text), "0.1.0"), { channel: "latest" });
    }
  });
});
