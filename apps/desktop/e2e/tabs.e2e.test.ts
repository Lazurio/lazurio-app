// End-to-end: the main window's tabs (#82, variant A). A page of Lazurio opens a module's app in
// a new tab of the window, with the session the person already has there: its STAGING in the
// Environment (`<module>.<environment>.<organization>.lazurio.io`) and its Application, PROD
// (`<module>.<organization>.lazurio.app`), as the Launchpad opens them (`target="_blank"`, or an
// empty `window.open` that it then navigates). A local HTTPS server plays the sites; the launch's
// switches --host-resolver-rules and --ignore-certificate-errors are this test's, not the app's.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The server's request and response types.
import type * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTPS server plays the sites.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Effect from "effect/Effect";
import { _electron, type ElectronApplication } from "playwright-core";

import { selfSigned } from "./certificate.ts";
import { columnPage } from "./local-page.ts";
import { removeUserData, temporaryUserData } from "./user-data.ts";

const LAUNCHPAD = "https://launchpad.env.example.lazurio.io/";
const STAGING = "https://notes.env.example.lazurio.io/";
const PROD = "https://notes.example.lazurio.app/";
// A module named like a property of every object (review of #96).
const CONSTRUCTOR = "https://constructor.env.example.lazurio.io/";
// A module whose name resolves nowhere, so its page fails.
const BROKEN = "https://broken.env.example.lazurio.io/";
const HOSTS = [
  "launchpad.env.example.lazurio.io",
  "notes.env.example.lazurio.io",
  "notes.example.lazurio.app",
  "constructor.env.example.lazurio.io",
];
const COOKIE = "__Secure-lazurio-workspace=e2e";

let server: NodeHttps.Server;
let userData: string;
let app: ElectronApplication;
const output: Array<string> = [];
// Every request the sites served, as "host/path cookie".
const requests: Array<string> = [];

const serve = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  request.resume();
  const host = request.headers.host ?? "";
  const path = new URL(request.url ?? "/", `https://${host}`).pathname;
  if (path === "/favicon.ico") {
    response.writeHead(404);
    response.end();
    return;
  }
  requests.push(`${host}${path} ${request.headers.cookie ?? "-"}`);
  if (host.startsWith("launchpad.")) {
    // The Environment's session, for every name of the Environment, as its gateway sets it.
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": `${COOKIE}; Domain=env.example.lazurio.io; Path=/; Secure; HttpOnly; SameSite=Lax`,
    });
    response.end(`<!doctype html><title>Launchpad</title>
<a id="prod" target="_blank" rel="noopener noreferrer" href="${PROD}">PROD</a>
<a id="staging" target="_blank" rel="noopener noreferrer" href="${STAGING}">STAGING</a>
<a id="foreign" target="_blank" rel="noopener noreferrer" href="https://example.com/">foreign</a>
<script>
  // The Launchpad's start of an app: a tab opened at the click, navigated once the app started.
  window.startThenOpen = (address) => {
    const tab = window.open("about:blank", "_blank");
    if (tab === null) return "null";
    tab.opener = null;
    tab.location.href = address;
    return "opened";
  };
</script>`);
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>${host}</title><p>${host}</p>`);
};

beforeAll(async () => {
  const { cert, key } = selfSigned(HOSTS);
  server = NodeHttps.createServer({ cert, key }, serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  const rules = [
    ...HOSTS.map((host) => `MAP ${host} 127.0.0.1:${address.port}`),
    "MAP * ~NOTFOUND",
  ];
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [
      NodePath.resolve(import.meta.dirname, ".."),
      `--host-resolver-rules=${rules.join(", ")}`,
      "--ignore-certificate-errors",
    ],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: LAUNCHPAD,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// The main window's tabs as the window shows them: each remote view's address and whether it
// shows, in the window's order, and the strip's state.
interface Shown {
  readonly pages: ReadonlyArray<{ readonly url: string; readonly visible: boolean }>;
  readonly strip: {
    readonly titles: ReadonlyArray<string>;
    readonly active: number;
    readonly canClose: boolean;
  };
}

const shown = (): Promise<Shown> =>
  app.evaluate(async ({ BaseWindow }) => {
    const views = (BaseWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
      (child): child is Electron.WebContentsView => "webContents" in child,
    );
    const pages = views
      .filter((view) => !view.webContents.getURL().startsWith("lazurio-app:"))
      .map((view) => ({ url: view.webContents.getURL(), visible: view.getVisible() }));
    const strip = views.find((view) => view.webContents.getURL().includes("view=tabs"));
    if (strip === undefined) throw new Error("no strip of tabs");
    // What the strip draws: each tab's name and which one is in front.
    const state = (await strip.webContents.executeJavaScript(`(() => {
      const tabs = [...document.querySelectorAll("[data-tab]")];
      return {
        titles: tabs.map((tab) => tab.querySelector(".tabs__title").textContent),
        active: tabs.findIndex((tab) => tab.classList.contains("is-active")),
        canClose: document.querySelector(".tabs__close") !== null,
      };
    })()`)) as Shown["strip"];
    return { pages, strip: state };
  });

// Runs the script in the front page of Lazurio, with a user's gesture as a click gives, and
// resolves once the window's next new tab has shown a page at the address, or once the app sent
// the address to the system's browser.
const openFromPage = (script: string, address: string) =>
  app.evaluate(
    async ({ app: electron, BaseWindow }, [code, expected]) => {
      const views = (BaseWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
        (child): child is Electron.WebContentsView => "webContents" in child,
      );
      const front = views.find(
        (view) => view.getVisible() && view.webContents.getURL().startsWith("https://launchpad."),
      );
      if (front === undefined) throw new Error("no Launchpad in front");
      const created = new Promise<string>((resolve) => {
        electron.once("web-contents-created", (_event, contents) => {
          contents.on("did-navigate", (_navigation, url) => {
            if (url === expected) contents.once("did-stop-loading", () => resolve(url));
          });
        });
      });
      const result = String(await front.webContents.executeJavaScript(code, true));
      return { result, url: await created };
    },
    [script, address] as const,
  );

// Waits for the strip to have drawn the given number of tabs.
const stripHas = (count: number) =>
  app.evaluate(async ({ BaseWindow }, wanted) => {
    const strip = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
      .filter((child): child is Electron.WebContentsView => "webContents" in child)
      .find((view) => view.webContents.getURL().includes("view=tabs"));
    if (strip === undefined) throw new Error("no strip of tabs");
    await strip.webContents.executeJavaScript(`new Promise((resolve) => {
      const check = () => {
        if (document.querySelectorAll("[data-tab]").length === ${wanted}) return resolve(true);
        new MutationObserver((_records, observer) => {
          if (document.querySelectorAll("[data-tab]").length === ${wanted}) {
            observer.disconnect();
            resolve(true);
          }
        }).observe(document.body, { childList: true, subtree: true });
      };
      check();
    })`);
  }, count);

// Sends a key to the front page, as a person types it there; the views catch the tabs' keys.
const press = (keyCode: string, modifiers: ReadonlyArray<"control" | "shift" | "meta">) =>
  app.evaluate(
    ({ BaseWindow }, [key, keys]) => {
      const front = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        // The page in front, or the app's page in its place while it cannot show.
        .find(
          (view) =>
            view.getVisible() &&
            (!view.webContents.getURL().startsWith("lazurio-app:") ||
              view.webContents.getURL().endsWith("#waiting")),
        );
      if (front === undefined) throw new Error("no page in front");
      front.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: [...keys] });
    },
    [keyCode, modifiers] as const,
  );

// Resolves once the first tab, the column's neighbour, shows the window's first page.
const firstPageShown = () =>
  app.evaluate(async ({ BaseWindow }, launchpad) => {
    const window = BaseWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("no main window");
    const remote = window.contentView.children[1] as Electron.WebContentsView | undefined;
    if (remote === undefined) throw new Error("no first tab");
    const contents = remote.webContents;
    while (contents.getURL() !== launchpad || contents.isLoading()) {
      await new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve()));
    }
  }, LAUNCHPAD);

// Runs a test with the key that goes with Ctrl on Windows and Linux, Cmd on a Mac
// (Tabs.tabKeyOf), read from HostProcess.Platform.
const withCommandKey = (body: (command: "control" | "meta") => Promise<void>) =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(() => body(platform === "darwin" ? "meta" : "control")),
  );

describe("Lazurio App GEN4's tabs", () => {
  it("starts with one tab, the window's first page, which cannot close", async () => {
    await firstPageShown();
    await stripHas(1);
    assert.deepStrictEqual(await shown(), {
      pages: [{ url: LAUNCHPAD, visible: true }],
      strip: { titles: ["Apps · env"], active: 0, canClose: false },
    });
  });

  it("opens a module's Application (PROD) from target=_blank in a new tab in front", async () => {
    const opened = await openFromPage(`document.getElementById("prod").click(); "clicked"`, PROD);
    assert.strictEqual(opened.url, PROD);
    await stripHas(2);
    assert.deepStrictEqual(await shown(), {
      pages: [
        { url: LAUNCHPAD, visible: false },
        { url: PROD, visible: true },
      ],
      strip: { titles: ["Apps · env", "notes · example"], active: 1, canClose: true },
    });
  });

  it.effect("opens a module's STAGING in a new tab with the Environment's session", () =>
    withCommandKey(async (command) => {
      await press("1", [command]);
      const opened = await openFromPage(
        `document.getElementById("staging").click(); "clicked"`,
        STAGING,
      );
      assert.strictEqual(opened.url, STAGING);
      assert.include(requests, `notes.env.example.lazurio.io/ ${COOKIE}`);
      await stripHas(3);
      const { pages, strip } = await shown();
      // Right after the tab in front, the Launchpad, and in front itself.
      assert.deepStrictEqual(
        pages.map((page) => page.url),
        [LAUNCHPAD, PROD, STAGING],
      );
      assert.deepStrictEqual(strip.titles, ["Apps · env", "notes · env", "notes · example"]);
      assert.strictEqual(strip.active, 1);
    }),
  );

  it.effect("gives the Launchpad's empty window.open a real tab that it then navigates", () =>
    withCommandKey(async (command) => {
      await press("1", [command]);
      const opened = await openFromPage(
        `window.startThenOpen(${JSON.stringify(STAGING)})`,
        STAGING,
      );
      assert.deepStrictEqual(opened, { result: "opened", url: STAGING });
      await stripHas(4);
    }),
  );

  it("keeps a new tab a page of Lazurio without any power, in the same session", async () => {
    const facts = await app.evaluate(async ({ BaseWindow, session }) => {
      const views = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .filter((view) => !view.webContents.getURL().startsWith("lazurio-app:"));
      const remote = session.fromPartition("persist:lazurio-remote");
      return Promise.all(
        views.map(async (view) => ({
          session: view.webContents.session === remote,
          // What the page itself can reach: no bridge, no Node, no Electron.
          page: (await view.webContents.executeJavaScript(
            `({ bridge: typeof window.lazurio, process: typeof process, require: typeof require })`,
          )) as unknown,
        })),
      );
    });
    assert.strictEqual(facts.length, 4);
    for (const fact of facts) {
      assert.deepStrictEqual(fact, {
        session: true,
        page: { bridge: "undefined", process: "undefined", require: "undefined" },
      });
    }
  });

  it.effect("sends a foreign site to the system's browser and opens no tab for it", () =>
    withCommandKey(async (command) => {
      await press("1", [command]);
      const before = output.join("").length;
      await app.evaluate(async ({ BaseWindow }) => {
        const front = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
          .filter((child): child is Electron.WebContentsView => "webContents" in child)
          .find((view) => view.getVisible() && view.webContents.getURL().startsWith("https://"));
        await front?.webContents.executeJavaScript(
          `document.getElementById("foreign").click()`,
          true,
        );
      });
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!output.join("").slice(before).includes("system-browser https://example.com/"))
            return;
          app.process().stdout?.off("data", check);
          resolve();
        };
        app.process().stdout?.on("data", check);
        check();
      });
      assert.strictEqual((await shown()).pages.length, 4);
    }),
  );

  it("closes an empty tab whose page went to the system's browser", async () => {
    const before = output.join("").length;
    await app.evaluate(async ({ BaseWindow }) => {
      const front = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .find((view) => view.getVisible() && view.webContents.getURL().startsWith("https://"));
      await front?.webContents.executeJavaScript(
        `window.startThenOpen("https://example.com/")`,
        true,
      );
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!output.join("").slice(before).includes("system-browser https://example.com/")) return;
        app.process().stdout?.off("data", check);
        resolve();
      };
      app.process().stdout?.on("data", check);
      check();
    });
    await stripHas(4);
    assert.strictEqual((await shown()).pages.length, 4);
  });

  it.effect("switches with Ctrl+Tab and closes with Ctrl/Cmd+W", () =>
    withCommandKey(async (command) => {
      await press("1", [command]);
      await press("Tab", ["control"]);
      assert.strictEqual((await shown()).strip.active, 1);
      await press("Tab", ["control", "shift"]);
      assert.strictEqual((await shown()).strip.active, 0);
      await press("9", [command]);
      assert.strictEqual((await shown()).strip.active, 3);
      await press("W", [command]);
      await stripHas(3);
      const { pages, strip } = await shown();
      assert.strictEqual(pages.length, 3);
      // The left neighbour of a closed last tab comes to the front, and only its page shows.
      assert.strictEqual(strip.active, 2);
      assert.deepStrictEqual(
        pages.filter((page) => page.visible).map((page) => page.url),
        [STAGING],
      );
    }),
  );

  it.effect("opens the window's first page in a new tab with Ctrl/Cmd+T", () =>
    withCommandKey(async (command) => {
      const opened = app.evaluate(({ app: electron }, launchpad) => {
        return new Promise<string>((resolve) => {
          electron.once("web-contents-created", (_event, contents) => {
            contents.on("did-navigate", (_navigation, url) => {
              if (url === launchpad) contents.once("did-stop-loading", () => resolve(url));
            });
          });
        });
      }, LAUNCHPAD);
      await press("T", [command]);
      assert.strictEqual(await opened, LAUNCHPAD);
      await stripHas(4);
      const { strip } = await shown();
      assert.strictEqual(strip.active, 3);
      assert.strictEqual(strip.titles[3], "Apps · env");
    }),
  );

  it("switches and closes from the strip", async () => {
    await app.evaluate(async ({ BaseWindow }) => {
      const strip = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .find((view) => view.webContents.getURL().includes("view=tabs"));
      await strip?.webContents.executeJavaScript(
        `document.querySelectorAll("[data-tab] .tabs__main")[1].click()`,
        true,
      );
    });
    assert.strictEqual((await shown()).strip.active, 1);
    await app.evaluate(async ({ BaseWindow }) => {
      const strip = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .find((view) => view.webContents.getURL().includes("view=tabs"));
      await strip?.webContents.executeJavaScript(
        `document.querySelectorAll("[data-tab] .tabs__close")[1].click()`,
        true,
      );
    });
    await stripHas(3);
    assert.deepStrictEqual((await shown()).strip.titles, [
      "Apps · env",
      "notes · env",
      "Apps · env",
    ]);
  });

  it.effect("names a module called constructor in the strip", () =>
    withCommandKey(async (command) => {
      await press("1", [command]);
      const opened = await openFromPage(
        `window.open(${JSON.stringify(CONSTRUCTOR)}, "_blank"); "opened"`,
        CONSTRUCTOR,
      );
      assert.strictEqual(opened.url, CONSTRUCTOR);
      await stripHas(4);
      assert.include((await shown()).strip.titles, "constructor · env");
    }),
  );

  it.effect("tells Copy status how the tab in front ended, after every switch", () =>
    withCommandKey(async (command) => {
      // The column's bridge reads the status that Copy status writes out.
      const column = await columnPage(app);
      const outcome = async () =>
        (await column.evaluate(() => window.lazurio.status())).page.outcome;
      await press("1", [command]);
      assert.strictEqual(await outcome(), "shown");
      // A tab whose page fails, in front.
      const failed = app.evaluate(({ app: electron }) => {
        return new Promise<void>((resolve) => {
          electron.once("web-contents-created", (_event, contents) => {
            contents.once("did-fail-load", () => setImmediate(resolve));
          });
        });
      });
      await app.evaluate(async ({ BaseWindow }, broken) => {
        const front = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
          .filter((child): child is Electron.WebContentsView => "webContents" in child)
          .find((view) => view.getVisible() && view.webContents.getURL().startsWith("https://"));
        await front?.webContents.executeJavaScript(
          `window.open(${JSON.stringify(broken)}); "opened"`,
          true,
        );
      }, BROKEN);
      await failed;
      await stripHas(5);
      assert.strictEqual(await outcome(), "failed");
      await press("1", [command]);
      assert.strictEqual(await outcome(), "shown");
      await press("2", [command]);
      assert.strictEqual(await outcome(), "failed");
    }),
  );

  it("gives the window's first page the place of a last tab whose page closed itself", async () => {
    // Only the tab of the module called constructor stays, which a page opened.
    await app.evaluate(async ({ BaseWindow }) => {
      const strip = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .find((view) => view.webContents.getURL().includes("view=tabs"));
      await strip?.webContents.executeJavaScript(`(async () => {
        const state = await window.lazurio.tabs.getState();
        const keep = state.tabs.find((tab) => tab.title.module === "constructor");
        for (const tab of state.tabs) {
          if (tab !== keep) await window.lazurio.tabs.command({ _tag: "Close", id: tab.id });
        }
      })()`);
    });
    await stripHas(1);
    assert.deepStrictEqual((await shown()).strip.titles, ["constructor · env"]);
    const replaced = app.evaluate(({ app: electron }, launchpad) => {
      return new Promise<string>((resolve) => {
        electron.once("web-contents-created", (_event, contents) => {
          contents.on("did-navigate", (_navigation, url) => {
            if (url === launchpad) contents.once("did-stop-loading", () => resolve(url));
          });
        });
      });
    }, LAUNCHPAD);
    await app.evaluate(async ({ BaseWindow }) => {
      const front = (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((child): child is Electron.WebContentsView => "webContents" in child)
        .find((view) => view.getVisible() && view.webContents.getURL().startsWith("https://"));
      // The page closes after this answers, so the call itself returns.
      await front?.webContents.executeJavaScript(
        "setTimeout(() => window.close()); 'closing'",
        true,
      );
    });
    assert.strictEqual(await replaced, LAUNCHPAD);
    await stripHas(1);
    assert.deepStrictEqual(await shown(), {
      pages: [{ url: LAUNCHPAD, visible: true }],
      strip: { titles: ["Apps · env"], active: 0, canClose: false },
    });
  });
});
