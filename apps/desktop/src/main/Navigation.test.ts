import { assert, describe, it } from "@effect/vitest";

import { afterNavigation, destinationOf, mayLoad, newView, type ViewState } from "./Navigation.ts";

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

  it("opens Lazurio Auth and the Dashboard in the app, and nothing else on lazurio.ai", () => {
    assert.strictEqual(
      tagOf("https://auth.lazurio.ai/realms/workspace/protocol/openid-connect/auth"),
      "Lazurio",
    );
    assert.strictEqual(tagOf("https://dashboard.lazurio.ai/orgs/example/applications"), "Lazurio");
    assert.strictEqual(tagOf("https://auth.lazurio.ai./realms/workspace"), "Lazurio");
    assert.strictEqual(tagOf("https://lazurio.ai/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://www.lazurio.ai/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://evil.lazurio.ai/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://auth.lazurio.ai.attacker.example/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://evil-lazurio.ai/"), "SystemBrowser");
    assert.strictEqual(tagOf("http://auth.lazurio.ai/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://user@auth.lazurio.ai/"), "Blocked");
  });

  it("hands GitHub and Composio's connection of an Integration to the system's browser", () => {
    assert.strictEqual(tagOf("https://github.com/login"), "SystemBrowser");
    assert.strictEqual(
      tagOf("https://dashboard.composio.dev/workspace/~/connect/apps"),
      "SystemBrowser",
    );
    assert.strictEqual(tagOf("https://accounts.google.com/o/oauth2/v2/auth"), "SystemBrowser");
  });

  it("treats a name with the root's trailing dot as the same name", () => {
    assert.strictEqual(tagOf("https://launchpad.example-env.lazurio.io./"), "Lazurio");
    assert.strictEqual(tagOf("https://lazurio.io./"), "Lazurio");
    assert.strictEqual(tagOf("https://evil-lazurio.io./"), "SystemBrowser");
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
  const lazurioView = newView("Lazurio");
  const localView = newView("Local");

  it("keeps every frame of a view on what the view is for", () => {
    assert.isTrue(mayLoad(lazurioView, lazurio, "main"));
    assert.isTrue(mayLoad(lazurioView, lazurio, "sub"));
    assert.isTrue(mayLoad(localView, local, "main"));
    assert.isTrue(mayLoad(localView, local, "sub"));
  });

  it("refuses foreign pages in the main frame and in every subframe", () => {
    assert.isFalse(mayLoad(lazurioView, foreign, "main"));
    assert.isFalse(mayLoad(lazurioView, foreign, "sub"));
    assert.isFalse(mayLoad(localView, foreign, "sub"));
    assert.isFalse(mayLoad(lazurioView, "http://user:password@example.com/", "sub"));
  });

  it("never moves a view between the app's files and the web", () => {
    assert.isFalse(mayLoad(lazurioView, local, "main"));
    assert.isFalse(mayLoad(lazurioView, local, "sub"));
    assert.isFalse(mayLoad(localView, lazurio, "main"));
    assert.isFalse(mayLoad(localView, lazurio, "sub"));
  });

  it("lets a page create empty subframes of its own, never an empty main frame", () => {
    assert.isTrue(mayLoad(lazurioView, "about:blank", "sub"));
    assert.isTrue(mayLoad(lazurioView, "about:srcdoc", "sub"));
    assert.isFalse(mayLoad(lazurioView, "about:blank", "main"));
  });

  it("refuses everything in a view the app did not create", () => {
    assert.isFalse(mayLoad(undefined, lazurio, "main"));
    assert.isFalse(mayLoad(undefined, "about:blank", "sub"));
  });
});

describe("a sign-in through Lazurio Auth", () => {
  // The way an Environment's sign-in went on 2026-11-14 (Lazurio/lazurio-app#4), with GitHub's
  // pages for a person GitHub does not know yet.
  const signIn = [
    "https://launchpad.lazurio-bob.example-org.lazurio.io/",
    "https://lazurio-bob.example-org.lazurio.io/oauth2/start",
    "https://auth.lazurio.ai/realms/workspace/protocol/openid-connect/auth",
    "https://auth.lazurio.ai/realms/workspace/broker/github/login",
    "https://github.com/login/oauth/authorize",
    "https://github.com/login",
    "https://github.com/session",
    "https://github.com/sessions/two-factor/webauthn",
    "https://github.com/login/oauth/authorize",
    "https://auth.lazurio.ai/realms/workspace/broker/github/endpoint",
    "https://lazurio-bob.example-org.lazurio.io/oauth2/callback",
    "https://launchpad.lazurio-bob.example-org.lazurio.io/",
  ];

  const walk = (addresses: ReadonlyArray<string>, from: ViewState = newView("Lazurio")) =>
    addresses.reduce((view, address) => {
      assert.isTrue(mayLoad(view, address, "main"), address);
      return afterNavigation(view, address, "main");
    }, from);

  it("goes from the Environment over Lazurio Auth and GitHub back to the Environment", () => {
    assert.isFalse(walk(signIn).signingIn);
  });

  it("is under way from Lazurio Auth until another page of Lazurio", () => {
    assert.isTrue(walk(signIn.slice(0, 3)).signingIn);
    assert.isTrue(walk(signIn.slice(0, 8)).signingIn);
    assert.isFalse(walk(signIn.slice(0, 2)).signingIn);
  });

  it("shows GitHub's sign-in pages only during a sign-in", () => {
    const view = newView("Lazurio");
    assert.isFalse(mayLoad(view, "https://github.com/login", "main"));
    assert.isFalse(mayLoad(walk(signIn), "https://github.com/login", "main"));
  });

  it("shows nothing of GitHub but its sign-in pages, and only in the main frame", () => {
    const view = walk(signIn.slice(0, 6));
    for (const address of [
      "https://github.com/",
      "https://github.com/join",
      "https://github.com/password_reset",
      "https://github.com/loginx",
      "https://github.com/sessionsx",
      "https://github.com/Lazurio/lazurio-app",
      "https://gist.github.com/login",
      "https://github.com.attacker.example/login",
      "https://github.com:8443/login",
      "http://github.com/login",
      "https://user@github.com/login",
      "https://example.com/login",
    ]) {
      assert.isFalse(mayLoad(view, address, "main"), address);
    }
    assert.isFalse(mayLoad(view, "https://github.com/login", "sub"));
    assert.isTrue(mayLoad(view, "https://github.com./login", "main"));
  });

  it("never lets a local window or a subframe start one", () => {
    const local = newView("Local");
    assert.isFalse(mayLoad(local, "https://auth.lazurio.ai/realms/workspace", "main"));
    const view = afterNavigation(
      newView("Lazurio"),
      "https://auth.lazurio.ai/realms/workspace",
      "sub",
    );
    assert.isFalse(view.signingIn);
    assert.isFalse(mayLoad(view, "https://github.com/login", "main"));
  });

  it("starts only on Lazurio Auth itself, not on the Dashboard or another port", () => {
    for (const start of [
      "https://dashboard.lazurio.ai/",
      "https://auth.lazurio.ai:8443/realms/workspace",
      "https://launchpad.example-env.lazurio.io/",
    ]) {
      const view = afterNavigation(newView("Lazurio"), start, "main");
      assert.isFalse(mayLoad(view, "https://github.com/login", "main"), start);
    }
  });
});
