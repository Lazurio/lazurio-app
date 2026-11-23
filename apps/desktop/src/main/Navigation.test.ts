import { assert, describe, it } from "@effect/vitest";

import {
  afterNavigation,
  destinationOf,
  environmentOriginOf,
  mayLoad,
  newView,
  step,
  track,
  type NavigationStep,
  type Tracked,
  type ViewState,
  windowOpenOf,
} from "./Navigation.ts";

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

  it("opens an Organization's production applications on lazurio.app over HTTPS in the app", () => {
    assert.strictEqual(tagOf("https://deals.example-org.lazurio.app/"), "Lazurio");
    assert.strictEqual(tagOf("https://deals.example-org.lazurio.app./pipeline"), "Lazurio");
    assert.strictEqual(tagOf("https://lazurio.app/"), "Lazurio");
    assert.strictEqual(tagOf("http://deals.example-org.lazurio.app/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://evil-lazurio.app/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://lazurio.app.attacker.example/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://deals.example-org.lazurio.apps/"), "SystemBrowser");
    assert.strictEqual(tagOf("https://user@deals.example-org.lazurio.app/"), "Blocked");
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

describe("the guard's steps, in Electron's order", () => {
  const LAUNCHPAD = "https://launchpad.lazurio-bob.example-org.lazurio.io/";
  const START = "https://lazurio-bob.example-org.lazurio.io/oauth2/start";
  const AUTH = "https://auth.lazurio.ai/realms/workspace/protocol/openid-connect/auth";
  const BROKER = "https://auth.lazurio.ai/realms/workspace/broker/github/login";
  const AUTHORIZE = "https://github.com/login/oauth/authorize";
  const LOGIN = "https://github.com/login";
  const SESSION = "https://github.com/session";
  const ENDPOINT = "https://auth.lazurio.ai/realms/workspace/broker/github/endpoint";
  const CALLBACK = "https://lazurio-bob.example-org.lazurio.io/oauth2/callback";

  const start = (address: string): NavigationStep => ({ _tag: "Start", address, frame: "main" });
  const navigate = (address: string): NavigationStep => ({
    _tag: "Navigate",
    address,
    frame: "main",
  });
  const redirect = (address: string): NavigationStep => ({
    _tag: "Redirect",
    address,
    frame: "main",
  });
  const show = (address: string): NavigationStep => ({ _tag: "Show", address });

  interface Run {
    readonly tracked: Tracked;
    readonly refused: ReadonlyArray<string>;
    readonly ended: number;
  }
  const run = (events: ReadonlyArray<NavigationStep>, from: Tracked = track("Lazurio")): Run =>
    events.reduce<Run>(
      (state, event) => {
        const outcome = step(state.tracked, event);
        return {
          tracked: outcome.tracked,
          refused: outcome.allowed
            ? state.refused
            : [...state.refused, `${event._tag} ${event.address}`],
          ended: state.ended + (outcome.signInEnded ? 1 : 0),
        };
      },
      { tracked: from, refused: [], ended: 0 },
    );

  // The app loads the Environment, which sends the person over Lazurio Auth to GitHub's sign-in.
  const toGitHub = [
    start(LAUNCHPAD),
    redirect(START),
    redirect(AUTH),
    redirect(BROKER),
    redirect(AUTHORIZE),
    redirect(LOGIN),
    show(LOGIN),
  ];
  // The person signs in on GitHub, which sends them back over Lazurio Auth to the Environment.
  const back = [
    start(SESSION),
    navigate(SESSION),
    redirect(AUTHORIZE),
    redirect(ENDPOINT),
    redirect(CALLBACK),
    redirect(LAUNCHPAD),
    show(LAUNCHPAD),
  ];
  const signedIn = run([...toGitHub, ...back]).tracked;

  it("follows a whole sign-in and ends it on the Environment's page", () => {
    const signIn = run([...toGitHub, ...back]);
    assert.deepStrictEqual(signIn.refused, []);
    assert.isTrue(run(toGitHub).tracked.shown.signingIn);
    assert.isFalse(signIn.tracked.shown.signingIn);
    assert.strictEqual(signIn.ended, 1);
  });

  it("refuses GitHub once the sign-in ended, in a navigation and in a redirect", () => {
    assert.deepStrictEqual(run([start(LOGIN), navigate(LOGIN)], signedIn).refused, [
      `Navigate ${LOGIN}`,
    ]);
    assert.deepStrictEqual(run([start(LAUNCHPAD), redirect(LOGIN)], signedIn).refused, [
      `Redirect ${LOGIN}`,
    ]);
  });

  it("starts no sign-in with a navigation to Lazurio Auth that shows no page", () => {
    // A 204, a refused or a cancelled navigation: Electron reports nothing after its start.
    const failed = run([start(AUTH), navigate(AUTH), start(LOGIN), navigate(LOGIN)], signedIn);
    assert.deepStrictEqual(failed.refused, [`Navigate ${LOGIN}`]);
    assert.isUndefined(failed.tracked.underWay);
  });

  it("starts no sign-in with a navigation to Lazurio Auth that another one replaced", () => {
    const replaced = run(
      [start(AUTH), navigate(AUTH), start(LAUNCHPAD), redirect(LOGIN)],
      signedIn,
    );
    assert.deepStrictEqual(replaced.refused, [`Redirect ${LOGIN}`]);
  });

  it("ends a sign-in on an error page", () => {
    const failed = run([
      ...toGitHub,
      start(SESSION),
      navigate(SESSION),
      { _tag: "ShowError", address: SESSION },
    ]);
    assert.isFalse(failed.tracked.shown.signingIn);
    assert.strictEqual(failed.ended, 1);
    assert.deepStrictEqual(run([start(LOGIN), navigate(LOGIN)], failed.tracked).refused, [
      `Navigate ${LOGIN}`,
    ]);
  });

  it("takes a page for a sign-in's only when the navigation under way ended at it", () => {
    const elsewhere = "https://github.com/login?return_to=elsewhere";
    assert.isFalse(run([...toGitHub.slice(0, 6), show(elsewhere)]).tracked.shown.signingIn);
    // A history entry of GitHub, shown again by a page's history.back(): no Navigate comes first.
    const history = run([start(LOGIN), show(LOGIN), start(SESSION), navigate(SESSION)], signedIn);
    assert.deepStrictEqual(history.refused, [`Navigate ${SESSION}`]);
  });

  it("carries no sign-in into a redirect without a navigation under way", () => {
    const onGitHub = run(toGitHub).tracked;
    assert.deepStrictEqual(run([redirect(AUTHORIZE)], onGitHub).refused, [`Redirect ${AUTHORIZE}`]);
  });

  it("forgets a refused navigation at once, and keeps subframes out of a sign-in", () => {
    const foreign = "https://example.com/";
    assert.isUndefined(run([start(foreign), navigate(foreign)], signedIn).tracked.underWay);
    const onGitHub = run(toGitHub).tracked;
    const framed = run(
      [
        { _tag: "Start", address: AUTH, frame: "sub" },
        { _tag: "Navigate", address: LOGIN, frame: "sub" },
        { _tag: "Redirect", address: LOGIN, frame: "sub" },
      ],
      onGitHub,
    );
    assert.deepStrictEqual(framed.refused, [`Navigate ${LOGIN}`, `Redirect ${LOGIN}`]);
    assert.isUndefined(framed.tracked.underWay);
  });

  it("never lets a local window sign in", () => {
    const local = run([start(AUTH), show(AUTH), start(LOGIN), navigate(LOGIN)], track("Local"));
    assert.isFalse(local.tracked.shown.signingIn);
    assert.deepStrictEqual(local.refused, [`Navigate ${LOGIN}`]);
  });
});

describe("environmentOriginOf", () => {
  it("gives the origin of a page of an Environment's Lazurio", () => {
    assert.strictEqual(
      environmentOriginOf("https://launchpad.bob.example-org.lazurio.io/settings?tab=tools#x"),
      "https://launchpad.bob.example-org.lazurio.io",
    );
    assert.strictEqual(
      environmentOriginOf("https://Launchpad.Bob.lazurio.io./"),
      "https://launchpad.bob.lazurio.io",
    );
  });

  it("gives none for anything that is no Environment's page over HTTPS", () => {
    for (const address of [
      "https://lazurio.io/",
      "https://evil-lazurio.io/",
      "https://lazurio.io.attacker.example/",
      "https://notes.example-org.lazurio.app/",
      "https://notes.alice.personal.lazurio.io/today",
      "https://launchpad.lazurio.io.attacker.example/",
      "https://auth.lazurio.ai/realms/workspace",
      "https://dashboard.lazurio.ai/",
      "http://launchpad.bob.lazurio.io/",
      "https://launchpad.bob.lazurio.io:8443/",
      "https://user:secret@launchpad.bob.lazurio.io/",
      "lazurio-app://shell/index.html",
      "about:blank",
      "not an address",
    ]) {
      assert.isUndefined(environmentOriginOf(address), address);
    }
  });
});

describe("windowOpenOf", () => {
  const lazurio = newView("Lazurio");
  it("opens a page of Lazurio in a new tab, and an empty tab its page then navigates", () => {
    assert.strictEqual(windowOpenOf(lazurio, "https://notes.example.lazurio.app/"), "Tab");
    assert.strictEqual(windowOpenOf(lazurio, "https://notes.env.example.lazurio.io/"), "Tab");
    assert.strictEqual(windowOpenOf(lazurio, "about:blank"), "Tab");
  });

  it("sends any other page to the system's browser, as before", () => {
    assert.strictEqual(windowOpenOf(lazurio, "https://example.com/"), "SystemBrowser");
    assert.strictEqual(windowOpenOf(lazurio, "https://notes.evil-lazurio.app/"), "SystemBrowser");
  });

  it("opens nothing else, from nothing else", () => {
    for (const address of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "about:srcdoc",
      "data:,x",
    ]) {
      assert.strictEqual(windowOpenOf(lazurio, address), "Refused");
    }
    assert.strictEqual(windowOpenOf(lazurio, "lazurio-app://shell/index.html"), "Refused");
    assert.strictEqual(
      windowOpenOf(lazurio, "https://user:pass@notes.example.lazurio.app/"),
      "Refused",
    );
    assert.strictEqual(
      windowOpenOf(newView("Local"), "https://notes.example.lazurio.app/"),
      "Refused",
    );
    assert.strictEqual(windowOpenOf(undefined, "about:blank"), "Refused");
  });

  it("opens no tab inside a sign-in", () => {
    const signingIn: ViewState = { kind: "Lazurio", signingIn: true };
    assert.strictEqual(
      windowOpenOf(signingIn, "https://launchpad.env.example.lazurio.io/"),
      "Refused",
    );
    assert.strictEqual(windowOpenOf(signingIn, "about:blank"), "Refused");
    assert.strictEqual(windowOpenOf(signingIn, "https://github.com/settings"), "SystemBrowser");
  });
});
