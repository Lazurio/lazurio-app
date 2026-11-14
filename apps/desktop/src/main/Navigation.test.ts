import { assert, describe, it } from "@effect/vitest";

import { destinationOf, mayNavigate } from "./Navigation.ts";

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

  it("never opens addresses with credentials, local files, scripts or unknown schemes", () => {
    assert.strictEqual(tagOf("https://user:secret@launchpad.example-env.lazurio.io/"), "Blocked");
    assert.strictEqual(tagOf("file:///etc/passwd"), "Blocked");
    assert.strictEqual(tagOf("javascript:alert(1)"), "Blocked");
    assert.strictEqual(tagOf("data:text/html,<p>hi</p>"), "Blocked");
    assert.strictEqual(tagOf("not an address"), "Blocked");
  });
});

describe("mayNavigate", () => {
  const local = destinationOf("lazurio-app://shell/index.html");
  const lazurio = destinationOf("https://launchpad.example-env.lazurio.io/");
  const foreign = destinationOf("https://example.com/");

  it("keeps a view on its own kind of content", () => {
    assert.isTrue(mayNavigate(local, local));
    assert.isTrue(mayNavigate(lazurio, lazurio));
  });

  it("never moves a view between the app's files and the web, or out to the web", () => {
    assert.isFalse(mayNavigate(local, lazurio));
    assert.isFalse(mayNavigate(lazurio, local));
    assert.isFalse(mayNavigate(lazurio, foreign));
    assert.isFalse(mayNavigate(foreign, foreign));
  });
});
