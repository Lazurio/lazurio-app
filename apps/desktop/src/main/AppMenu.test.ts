import { assert, describe, it } from "@effect/vitest";

import { messages } from "../ui/messages.ts";
import { menuTemplate, type MenuItem } from "./AppMenu.ts";

const actions = (calls: Array<string>) => ({
  toggleStatus: () => calls.push("status"),
  openAgentDesktop: () => calls.push("agent-desktop"),
  reloadPage: () => calls.push("reload"),
  goBack: () => calls.push("back"),
  goForward: () => calls.push("forward"),
  about: () => calls.push("about"),
});

const labels = (items: ReadonlyArray<MenuItem>) => items.map((item) => item.label);

describe("AppMenu.menuTemplate", () => {
  it("names Edit, View and Help in the app's language, and View holds the app's status", () => {
    const calls: Array<string> = [];
    const menu = menuTemplate({
      text: messages.cs.menu,
      appName: "Lazurio App (Alpha)",
      platform: "win32",
      statusShown: false,
      canGoBack: true,
      canGoForward: false,
      actions: actions(calls),
    });
    assert.deepStrictEqual(labels(menu), ["Úpravy", "Zobrazit", "Nápověda"]);
    const view = menu[1]?.submenu ?? [];
    const status = view[0];
    assert.deepStrictEqual(
      [status?.label, status?.type, status?.checked, status?.accelerator],
      ["Stav aplikace", "checkbox", false, "CmdOrCtrl+Shift+D"],
    );
    for (const item of view) item.click?.();
    menu[2]?.submenu?.[0]?.click?.();
    assert.deepStrictEqual(calls, [
      "status",
      "agent-desktop",
      "back",
      "forward",
      "reload",
      "about",
    ]);
    // Back and Forward with their keys, enabled only where the page's history goes.
    assert.deepStrictEqual(
      view.slice(3, 5).map((item) => [item.label, item.accelerator, item.enabled]),
      [
        ["Zpět", "Alt+Left", true],
        ["Vpřed", "Alt+Right", false],
      ],
    );
  });

  it("ticks the status item while the column shows, and gives a Mac the app's own menu first", () => {
    const menu = menuTemplate({
      text: messages.en.menu,
      appName: "Lazurio App (Alpha)",
      platform: "darwin",
      statusShown: true,
      canGoBack: false,
      canGoForward: false,
      actions: actions([]),
    });
    assert.deepStrictEqual(labels(menu), ["Lazurio App (Alpha)", "Edit", "View"]);
    // No Hide on a Mac: the window never hides while an agent works.
    assert.notInclude(
      menu.flatMap((item) => item.submenu ?? []).map((item) => item.role),
      "hide",
    );
    assert.isTrue(menu[2]?.submenu?.[0]?.checked);
    assert.deepStrictEqual(
      menu[2]?.submenu?.slice(3, 5).map((item) => item.accelerator),
      ["Cmd+[", "Cmd+]"],
    );
  });
});
