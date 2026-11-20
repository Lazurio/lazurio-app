// End-to-end: Back, Forward and Reload of the page from the View menu, with their keys (Alt+Left,
// Alt+Right, Ctrl+R and F5; Cmd+[ and Cmd+] on a Mac), as asked after the first installation by a
// person (#36, 2026-11-20). Back and Forward are enabled only where the page's history goes.
// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server serves the remote page.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test resolves the app on disk.
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright-core";

import { removeUserData, temporaryUserData } from "./user-data.ts";

let server: NodeHttp.Server;
let userData: string;
let app: ElectronApplication;
let first: string;
let second: string;
// How often the server answered each path, to see a reload reach it.
const answered = new Map<string, number>();

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    const path = request.url ?? "/";
    answered.set(path, (answered.get(path) ?? 0) + 1);
    // A page that never answers, for a failed load.
    if (path === "/broken") {
      request.socket.destroy();
      return;
    }
    response.writeHead(path === "/favicon.ico" ? 404 : 200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><title>${path}</title><p>${path}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  first = `http://127.0.0.1:${address.port}/first`;
  second = `http://127.0.0.1:${address.port}/second`;
  userData = temporaryUserData();
  app = await _electron.launch({
    args: [NodePath.resolve(import.meta.dirname, "..")],
    chromiumSandbox: process.env["LAZURIO_APP_E2E_OS_SANDBOX"] === "true",
    env: {
      ...process.env,
      LAZURIO_APP_E2E: "true",
      LAZURIO_APP_E2E_USER_DATA: userData,
      LAZURIO_APP_E2E_REMOTE_URL: first,
    },
  });
  await app.firstWindow();
});

afterAll(async () => {
  await app?.close();
  removeUserData(userData);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// Runs the step in the main process and resolves with the remote page's address once it has
// loaded after it.
const afterLoad = (step: "start" | "second" | "back" | "forward" | "f5" | "f5-bar" | "broken") =>
  app.evaluate(
    async ({ BaseWindow, Menu }, [which, firstAddress, secondAddress]) => {
      const remote = BaseWindow.getAllWindows()[0]?.contentView.children[1] as
        | Electron.WebContentsView
        | undefined;
      if (remote === undefined) throw new Error("no remote view");
      const contents = remote.webContents;
      // Resolves once the page stopped loading, whether it loaded or failed; a failed main-frame
      // load rejects with its code, so a test says why instead of waiting until its timeout.
      const loaded = () =>
        new Promise<void>((resolve, reject) => {
          const failed = (
            _event: Electron.Event,
            code: number,
            description: string,
            address: string,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame) reject(new Error(`${address} did not load: ${code} ${description}`));
          };
          contents.on("did-fail-load", failed);
          contents.once("did-stop-loading", () => {
            contents.off("did-fail-load", failed);
            setImmediate(resolve);
          });
        });
      const viewItems = () =>
        Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []) ?? [];
      const item = (accelerators: ReadonlyArray<string>) => {
        const found = viewItems().find((candidate) =>
          accelerators.includes(candidate.accelerator ?? ""),
        );
        if (found === undefined) throw new Error(`no menu item for ${accelerators.join(", ")}`);
        return found;
      };
      if (which === "start") {
        // The first page may have loaded before this runs, or may still wait for its start.
        while (contents.getURL() !== firstAddress || contents.isLoading()) await loaded();
      } else if (which === "second" || which === "broken") {
        const done = loaded();
        void contents
          .loadURL(which === "second" ? secondAddress : secondAddress.replace("/second", "/broken"))
          .catch(() => undefined);
        await done;
      } else if (which === "back" || which === "forward") {
        const done = loaded();
        item(which === "back" ? ["Alt+Left", "Cmd+["] : ["Alt+Right", "Cmd+]"]).click();
        await done;
      } else {
        // F5 in the page, or in Agent Desktop's bar above it (the window's last view).
        const children = BaseWindow.getAllWindows()[0]?.contentView.children ?? [];
        const bar = (children.at(-1) as Electron.WebContentsView | undefined)?.webContents;
        const target = which === "f5-bar" ? bar : contents;
        if (target === undefined || (which === "f5-bar" && target === contents)) {
          throw new Error("no bar view");
        }
        const done = loaded();
        target.sendInputEvent({ type: "keyDown", keyCode: "F5" });
        await done;
      }
      const back = item(["Alt+Left", "Cmd+["]);
      const forward = item(["Alt+Right", "Cmd+]"]);
      // The page's own title proves its content, also when a load failed before this listened:
      // Chromium's error page for the same address has none of it (review of #85).
      const title = String(await contents.executeJavaScript("document.title"));
      return { url: contents.getURL(), title, back: back.enabled, forward: forward.enabled };
    },
    [step, first, second] as const,
  );

describe("Lazurio App GEN4's Back, Forward and Reload", () => {
  it("has nowhere to go back or forward on its first page", async () => {
    assert.deepStrictEqual(await afterLoad("start"), {
      url: first,
      title: "/first",
      back: false,
      forward: false,
    });
  });

  it("goes back and forward between two pages from the View menu", async () => {
    assert.deepStrictEqual(await afterLoad("second"), {
      url: second,
      title: "/second",
      back: true,
      forward: false,
    });
    assert.deepStrictEqual(await afterLoad("back"), {
      url: first,
      title: "/first",
      back: false,
      forward: true,
    });
    assert.deepStrictEqual(await afterLoad("forward"), {
      url: second,
      title: "/second",
      back: true,
      forward: false,
    });
  });

  it("reloads the page with F5", async () => {
    const before = answered.get("/second") ?? 0;
    assert.deepStrictEqual(await afterLoad("f5"), {
      url: second,
      title: "/second",
      back: true,
      forward: false,
    });
    assert.strictEqual(answered.get("/second"), before + 1);
  });

  it("reloads the page with F5 while Agent Desktop's bar has the focus", async () => {
    const before = answered.get("/second") ?? 0;
    assert.deepStrictEqual(await afterLoad("f5-bar"), {
      url: second,
      title: "/second",
      back: true,
      forward: false,
    });
    assert.strictEqual(answered.get("/second"), before + 1);
  });

  // The check itself: a page that does not load is a failure, never a pass.
  it("reports a page that does not load as a failure", async () => {
    let failure: unknown;
    try {
      await afterLoad("broken");
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /did not load/u);
  });
});
