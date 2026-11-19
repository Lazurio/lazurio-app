import { assert, describe, it } from "@effect/vitest";

import type { AppStatus, DeviceStatus } from "./bridge.ts";
import { statusText } from "./statusText.ts";

const STATUS: AppStatus = {
  appVersion: "0.1.0-nightly.20261118.17",
  generation: "GEN4",
  helpers: [
    { name: "lazurio-tailnet", state: "ready", version: "0.1.0-nightly.20261118.17" },
    { name: "lazurio-device", state: "failed", problem: "the helper did not answer" },
  ],
  tailnets: [
    { tailnet: "example-org", state: "running", addresses: ["100.64.0.7", "fd7a:115c:a1e0::7"] },
    {
      tailnet: "other-org",
      state: "stopped",
      problem: "C:\\Users\\ada\\AppData\\Roaming\\Lazurio App\\tailnets\\other-org.key",
      reason: "no-keystore",
    },
  ],
  networkMissing: false,
  updates: { channel: "latest", state: { phase: "ready", version: "0.1.1" } },
  page: { outcome: "failed", code: -111 },
};

const DEVICE: DeviceStatus = {
  state: "ready",
  environments: [],
  agent: {
    environmentId: "launchpad.ada.example-org.lazurio.io",
    label: "launchpad.ada.example-org.lazurio.io",
  },
  account: "signed-in",
  switches: [
    {
      origin: "https://launchpad.ada.example-org.lazurio.io",
      host: "launchpad.ada.example-org.lazurio.io",
      switch: { phase: "off", problem: { from: "auth", reason: "unknown-environment" } },
      channel: { state: "off" },
    },
  ],
  addable: null,
};

describe("statusText", () => {
  it("words the app's status line by line, without any address inside a tailnet", () => {
    const text = statusText({
      appName: "Lazurio App (Alpha)",
      platform: "win32",
      status: STATUS,
      device: DEVICE,
      at: "2026-11-18T23:00:00.000Z",
    });
    assert.strictEqual(
      text,
      [
        "Lazurio App (Alpha) 0.1.0-nightly.20261118.17 (GEN4, win32)",
        "Copied: 2026-11-18T23:00:00.000Z",
        "Update channel: latest; update: ready 0.1.1",
        "Networks:",
        "  example-org: running",
        "  other-org: stopped (no-keystore)",
        "Helper programs:",
        "  lazurio-tailnet: ready 0.1.0-nightly.20261118.17",
        "  lazurio-device: failed",
        "Page: failed (-111)",
        "Agent Desktop: ready; account signed-in; agent working",
        "  Environment 1: off (auth: unknown-environment); channel off",
        "",
      ].join("\n"),
    );
    assert.notInclude(text, "100.64");
    assert.notInclude(text, "fd7a");
    // No Environment's host, and no problem text, which may name a path, host or feed.
    assert.notInclude(text, "lazurio.io");
    assert.notInclude(text, "C:\\Users");
    assert.notInclude(text, "objects.githubusercontent.com");
  });

  it("names a failed update by its phase only, never by the updater's text", () => {
    const text = statusText({
      appName: "Lazurio App (Alpha)",
      platform: "win32",
      status: {
        ...STATUS,
        updates: {
          channel: "nightly",
          state: {
            phase: "failed",
            problem: "net::ERR_FAILED https://objects.githubusercontent.com/feed?token=secret",
          },
        },
      },
      device: DEVICE,
      at: "2026-11-18T23:00:00.000Z",
    });
    assert.include(text, "Update channel: nightly; update: failed\n");
    assert.notInclude(text, "token");
    assert.notInclude(text, "objects.githubusercontent.com");
  });
});
