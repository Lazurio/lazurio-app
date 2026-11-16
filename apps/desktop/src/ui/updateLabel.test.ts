import { assert, describe, it } from "@effect/vitest";

import type { UpdatesStatus } from "../shared/bridge.ts";
import { messages } from "./messages.ts";
import { updateLabel } from "./updateLabel.ts";

const text = messages.en.updates;
const status = (state: UpdatesStatus["state"], channel: UpdatesStatus["channel"] = "latest") => ({
  channel,
  state,
});

describe("updateLabel", () => {
  it("says why a build does not update itself, in the catalog's words", () => {
    for (const reason of ["unpackaged", "macos-unsigned", "linux-not-appimage"] as const) {
      const label = updateLabel(status({ phase: "off", reason }), "0.1.0", text);
      assert.strictEqual(label.text, text[reason]);
      assert.isFalse(label.canInstall);
    }
  });

  it("offers to install only a ready update, naming its version", () => {
    const ready = updateLabel(status({ phase: "ready", version: "0.2.0" }), "0.1.0", text);
    assert.isTrue(ready.canInstall);
    assert.include(ready.text, "0.2.0");
    for (const state of [
      { phase: "idle" },
      { phase: "checking" },
      { phase: "downloading", version: "0.2.0" },
      { phase: "installing", version: "0.2.0" },
      { phase: "restarting", version: "0.2.0" },
      { phase: "failed", problem: "electron-updater failed to check" },
    ] as const) {
      assert.isFalse(updateLabel(status(state), "0.1.0", text).canInstall);
    }
  });

  it("never shows the updater's own problem, only the catalog's text", () => {
    const label = updateLabel(status({ phase: "failed", problem: "ECONNRESET" }), "0.1.0", text);
    assert.strictEqual(label.text, text.failed);
  });

  it("explains the floor only to a nightly build on the stable channel", () => {
    const nightly = "0.2.0-nightly.20261116.5";
    assert.isTrue(updateLabel(status({ phase: "idle" }, "latest"), nightly, text).floor);
    assert.isFalse(updateLabel(status({ phase: "idle" }, "nightly"), nightly, text).floor);
    assert.isFalse(updateLabel(status({ phase: "idle" }, "latest"), "0.1.0", text).floor);
  });
});
