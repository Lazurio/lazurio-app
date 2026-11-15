import { assert, describe, it } from "@effect/vitest";

import { messages } from "./messages.ts";
import { tailnetLabel } from "./tailnetLabel.ts";

const recovery = {
  keyFile: "/Users/alice/Library/Application Support/Lazurio App/tailnets/example.key",
  stateDirectory: "/Users/alice/Library/Application Support/Lazurio App/tailnets/example",
};

describe("tailnetLabel", () => {
  it("tells a person without a keystore to unlock it, in either language", () => {
    const status = {
      tailnet: "example",
      state: "stopped",
      problem: "the system's keystore is not available, so no tailnet node starts",
      reason: "no-keystore",
    } as const;
    assert.deepStrictEqual(tailnetLabel(status, messages.en), {
      state: "Stopped",
      detail: { text: messages.en.noKeystore },
    });
    assert.include(tailnetLabel(status, messages.cs).detail?.text ?? "", "Odemkněte");
  });

  it("names the files to delete for a key that does not open, and what follows", () => {
    const status = {
      tailnet: "example",
      state: "stopped",
      problem: "the keystore does not open its sealed key",
      reason: "key-unreadable",
      recovery,
    } as const;
    for (const text of [messages.cs, messages.en]) {
      assert.deepStrictEqual(tailnetLabel(status, text).detail?.files, [
        recovery.keyFile,
        recovery.stateDirectory,
      ]);
    }
    assert.include(
      tailnetLabel(status, messages.en).detail?.after ?? "",
      "waits for approval as a new device",
    );
    assert.include(tailnetLabel(status, messages.cs).detail?.after ?? "", "čeká na schválení");
  });

  it("names the same files for a sealed state its key does not open", () => {
    const status = {
      tailnet: "example",
      state: "stopped",
      problem: "the sealed state does not open with this state key",
      reason: "state-unreadable",
      recovery,
    } as const;
    const detail = tailnetLabel(status, messages.en).detail;
    assert.include(detail?.text ?? "", "saved state");
    assert.deepStrictEqual(detail?.files, [recovery.keyFile, recovery.stateDirectory]);
  });

  it("shows the helper's own words when there is nothing for the person to do", () => {
    assert.deepStrictEqual(
      tailnetLabel({ tailnet: "example", state: "stopped", problem: "no answer" }, messages.cs),
      { state: "Zastaveno", detail: { text: "no answer" } },
    );
  });

  it("shows a running node's addresses and the other states by name", () => {
    assert.deepStrictEqual(
      tailnetLabel(
        { tailnet: "example", state: "running", addresses: ["100.64.0.9"] },
        messages.en,
      ),
      { state: "Connected · 100.64.0.9" },
    );
    assert.deepStrictEqual(
      tailnetLabel({ tailnet: "example", state: "needs-login" }, messages.cs),
      {
        state: "Čeká na přihlášení",
      },
    );
  });
});
