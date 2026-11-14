import { assert, describe, it } from "@effect/vitest";

import { destinationOf, mayLoad } from "./Navigation.ts";

const tagOf = (address: string) => destinationOf(address)._tag;

describe("destinationOf", () => {
  it("opens the app's own files only from its local host", () => {
    assert.strictEqual(tagOf("lazurio-app://shell/index.html"), "Local");
    assert.strictEqual(tagOf("lazurio-app://other/index.html"), "Blocked");
  });

  it("opens Lazurio's pages over HTTPS in the app", () => {
    assert.strictEqual(tagOf("https://launchpad.example-env.lazurio.io/"), "Lazurio");
    assert.strictEqual(tagOf("https://notes.alice.personal.lazurio.io/today"), "Lazurio");
    assert.strictEqual(tagOf("https://lazurio.io/"), "Lazurio");
  });

  it("hands look-alike and foreign hosts to the system's browser", () => {
    assert.strictEqual(tagOf("https://lazurio.io.attacker.example/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://evil-lazurio.io/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://github.com/Lazurio"), "SystemBrowser");
    assert.strictEqual(tagOf("http://launchpad.example-env.lazurio.io/"), "SystemBrowser");
  });

  it("never opens addresses with credentials, over HTTPS or HTTP", () => {
    assert.strictEqual(tagOf("https://user:secret@launchpad.example-env.lazurio.io/"), "Blocked");
    assert.strictEqual(tagOf("https://user@example.com/"), "Blocked");
    assert.strictEqual(tagOf("http://user:password@example.com/"), "Blocked");
    assert.strictEqual(tagOf("http://user@launchpad.example-env.lazurio.io/"), "Blocked");
  });

  it("never opens local files, scripts or unknown schemes", () => {
    assert.strictEqual(tagOf("file:///etc/passwd"), "Blocked");
    assert.strictEqual(tagOf("javascript:alert(1)"), "Blocked");
    assert.strictEqual(tagOf("data:text/html,<p>hi</p>"), "Blocked");
    assert.strictEqual(tagOf("about:blank"), "Blocked");
    assert.strictEqual(tagOf("not an address"), "Blocked");
  });
});

describe("mayLoad", () => {
  const lazurio = "https://launchpad.example-env.lazurio.io/";
  const local = "lazurio-app://shell/index.html";
  const foreign = "https://example.com/";

  it("keeps every frame of a view on what the view is for", () => {
    assert.isTrue(mayLoad("Lazurio", lazurio, "main"));
    assert.isTrue(mayLoad("Lazurio", lazurio, "sub"));
    assert.isTrue(mayLoad("Local", local, "main"));
    assert.isTrue(mayLoad("Local", local, "sub"));
  });

  it("refuses foreign pages in the main frame and in every subframe", () => {
    assert.isFalse(mayLoad("Lazurio", foreign, "main"));
    assert.isFalse(mayLoad("Lazurio", foreign, "sub"));
    assert.isFalse(mayLoad("Local", foreign, "sub"));
    assert.isFalse(mayLoad("Lazurio", "http://user:password@example.com/", "sub"));
  });

  it("never moves a view between the app's files and the web", () => {
    assert.isFalse(mayLoad("Lazurio", local, "main"));
    assert.isFalse(mayLoad("Lazurio", local, "sub"));
    assert.isFalse(mayLoad("Local", lazurio, "main"));
    assert.isFalse(mayLoad("Local", lazurio, "sub"));
  });

  it("lets a page create empty subframes of its own, never an empty main frame", () => {
    assert.isTrue(mayLoad("Lazurio", "about:blank", "sub"));
    assert.isTrue(mayLoad("Lazurio", "about:srcdoc", "sub"));
    assert.isFalse(mayLoad("Lazurio", "about:blank", "main"));
  });

  it("refuses everything in a view the app did not create", () => {
    assert.isFalse(mayLoad(undefined, lazurio, "main"));
    assert.isFalse(mayLoad(undefined, "about:blank", "sub"));
  });
});
