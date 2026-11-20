import type { MenuText } from "../ui/messages.ts";

// The window's menu instead of Electron's English default (File, Edit, View, Window): editing for
// the pages, the app's status column and Agent Desktop under View, and Help. A Mac also gets the
// app's own menu first, where its system puts About and Quit.

export interface AppMenuActions {
  readonly toggleStatus: () => void;
  readonly openAgentDesktop: () => void;
  readonly reloadPage: () => void;
  // Back and Forward in the page's history (the coordinator's request after the first installation
  // by a person, 2026-11-20): functions at hand before the window gets buttons of its own (#82).
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly about: () => void;
}

// Electron.MenuItemConstructorOptions, kept free of Electron so tests can read it.
export interface MenuItem {
  readonly label?: string;
  readonly role?: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "quit" | "about";
  readonly type?: "separator" | "checkbox";
  readonly checked?: boolean;
  readonly enabled?: boolean;
  readonly accelerator?: string;
  readonly click?: () => void;
  readonly submenu?: ReadonlyArray<MenuItem>;
}

// The accelerator of the status column: Ctrl+Shift+D (Cmd+Shift+D on a Mac), D for diagnostics.
const STATUS_ACCELERATOR = "CmdOrCtrl+Shift+D";

export const menuTemplate = (options: {
  readonly text: MenuText;
  readonly appName: string;
  readonly platform: string;
  readonly statusShown: boolean;
  // Whether the page has somewhere to go back or forward to.
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly actions: AppMenuActions;
}): ReadonlyArray<MenuItem> => {
  const { text, actions } = options;
  const separator: MenuItem = { type: "separator" };
  const mac = options.platform === "darwin";
  return [
    ...(mac
      ? [
          {
            label: options.appName,
            submenu: [
              { label: text.about, click: actions.about },
              separator,
              // No Hide: the window never hides while an agent works (docs/adr/0006).
              { role: "quit" as const, label: text.quit },
            ],
          },
        ]
      : []),
    {
      label: text.edit,
      submenu: [
        { role: "undo", label: text.undo },
        { role: "redo", label: text.redo },
        separator,
        { role: "cut", label: text.cut },
        { role: "copy", label: text.copy },
        { role: "paste", label: text.paste },
        { role: "selectAll", label: text.selectAll },
      ],
    },
    {
      label: text.view,
      submenu: [
        {
          label: text.status,
          type: "checkbox",
          checked: options.statusShown,
          accelerator: STATUS_ACCELERATOR,
          click: actions.toggleStatus,
        },
        { label: text.agentDesktop, click: actions.openAgentDesktop },
        separator,
        {
          label: text.back,
          accelerator: mac ? "Cmd+[" : "Alt+Left",
          enabled: options.canGoBack,
          click: actions.goBack,
        },
        {
          label: text.forward,
          accelerator: mac ? "Cmd+]" : "Alt+Right",
          enabled: options.canGoForward,
          click: actions.goForward,
        },
        // F5 as well: MainWindow catches it in the views, since an item has one accelerator.
        { label: text.reload, accelerator: "CmdOrCtrl+R", click: actions.reloadPage },
      ],
    },
    ...(mac ? [] : [{ label: text.help, submenu: [{ label: text.about, click: actions.about }] }]),
  ];
};
