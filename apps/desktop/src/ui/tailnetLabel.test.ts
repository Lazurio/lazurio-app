import { assert, describe, it } from "@effect/vitest";

import { messages } from "./messages.ts";
import { tailnetLabel } from "./tailnetLabel.ts";

const files = {
  keyFile: "/Users/alice/Library/Application Support/Lazurio App/tailnets/example.key",
  stateDirectory: "/Users/alice/Library/Application Support/Lazurio App/tailnets/example",
};

// The words with which the advice tells a person to delete something.
const DELETION = [/smažte/iu, /\bdelete\b(?! nothing)/iu];
const advisesDeletion = (text: string) => DELETION.some((pattern) => pattern.test(text));

const stopped = (
  reason: "key-inaccessible" | "key-not-saved" | "key-unreadable" | "state-unreadable",
) => ({ tailnet: "example", state: "stopped", problem: "p", reason, files }) as const;

describe("tailnetLabel", () => {
  it("tells a person without a keystore to unlock it, in either language", () => {
    const status = {
      tailnet: "example",
      state: "stopped",
      problem: "p",
      reason: "no-keystore",
    } as const;
    assert.deepStrictEqual(tailnetLabel(status, messages.en), {
      state: "Stopped",
      detail: { text: messages.en.noKeystore },
    });
    assert.include(tailnetLabel(status, messages.cs).detail?.text ?? "", "Odemkněte");
  });

  it("never advises deleting anything for a key file a person can repair", () => {
    for (const reason of ["key-inaccessible", "key-not-saved"] as const) {
      for (const text of [messages.cs, messages.en]) {
        const detail = tailnetLabel(stopped(reason), text).detail;
        assert.deepStrictEqual(detail?.files, [files.keyFile], reason);
        assert.isFalse(advisesDeletion(detail?.text ?? ""), `${reason}: ${detail?.text}`);
        assert.isUndefined(detail?.after, reason);
      }
    }
    assert.include(
      tailnetLabel(stopped("key-inaccessible"), messages.cs).detail?.text ?? "",
      "Nic nemažte",
    );
    assert.include(
      tailnetLabel(stopped("key-inaccessible"), messages.en).detail?.text ?? "",
      "Delete nothing",
    );
  });

  it("asks to unlock the keystore first, and only then to delete both files of a key it does not open", () => {
    for (const text of [messages.cs, messages.en]) {
      const detail = tailnetLabel(stopped("key-unreadable"), text).detail;
      assert.deepStrictEqual(detail?.files, [files.keyFile, files.stateDirectory]);
      assert.isTrue(advisesDeletion(detail?.text ?? ""));
    }
    const english = tailnetLabel(stopped("key-unreadable"), messages.en).detail?.text ?? "";
    assert.isBelow(english.indexOf("unlock"), english.indexOf("delete"));
    assert.include(
      tailnetLabel(stopped("key-unreadable"), messages.en).detail?.after ?? "",
      "waits for approval as a new device",
    );
    assert.include(
      tailnetLabel(stopped("key-unreadable"), messages.cs).detail?.after ?? "",
      "čeká na schválení",
    );
  });

  it("names both files for a sealed state its key does not open", () => {
    const detail = tailnetLabel(stopped("state-unreadable"), messages.en).detail;
    assert.include(detail?.text ?? "", "saved state");
    assert.deepStrictEqual(detail?.files, [files.keyFile, files.stateDirectory]);
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
