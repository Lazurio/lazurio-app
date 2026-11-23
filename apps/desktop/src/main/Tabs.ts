// The main window's tabs as a list (#82, variant A; the window's prototype #/lab/okno-gen4): their
// order and the tab in front. Pure, so every case is a unit test; MainWindow keeps the views.

export interface TabList {
  // The tabs' ids from left to right.
  readonly order: ReadonlyArray<number>;
  readonly active: number;
}

export const single = (id: number): TabList => ({ order: [id], active: id });

// A new tab right after the one in front, as a browser opens it. In front itself, unless it opens
// in the background (a middle click).
export const opened = (list: TabList, id: number, background: boolean): TabList => {
  const at = list.order.indexOf(list.active) + 1 || list.order.length;
  return {
    order: [...list.order.slice(0, at), id, ...list.order.slice(at)],
    active: background ? list.active : id,
  };
};

// The window keeps one tab at least; closing its last tab closes the window instead.
export const canClose = (list: TabList): boolean => list.order.length > 1;

// Without the tab; the tab in front of a closed front tab is its right neighbour, or its left one
// at the end, as in a browser.
export const closed = (list: TabList, id: number): TabList => {
  const index = list.order.indexOf(id);
  if (index === -1 || !canClose(list)) return list;
  const order = list.order.filter((other) => other !== id);
  if (list.active !== id) return { order, active: list.active };
  return { order, active: order[Math.min(index, order.length - 1)] ?? list.active };
};

export const activated = (list: TabList, id: number): TabList =>
  list.order.includes(id) ? { ...list, active: id } : list;

// The next or previous tab, around the ends.
export const stepped = (list: TabList, by: 1 | -1): TabList => {
  const index = list.order.indexOf(list.active);
  const next = list.order[(index + by + list.order.length) % list.order.length];
  return next === undefined ? list : { ...list, active: next };
};

// The tab at a position from 1 to 8, or the last one for 9, as Ctrl/Cmd+1…9 in a browser.
export const atPosition = (list: TabList, position: number): TabList => {
  const id = position === 9 ? list.order.at(-1) : list.order[position - 1];
  return id === undefined ? list : { ...list, active: id };
};

// What a key does to the tabs, from Electron's before-input-event.
export type TabKey =
  | { readonly _tag: "New" }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Step"; readonly by: 1 | -1 }
  | { readonly _tag: "Position"; readonly position: number };

export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

// Ctrl+T and Ctrl+W (Cmd on a Mac), Ctrl+Tab and Ctrl+Shift+Tab, Ctrl+PageDown and Ctrl+PageUp,
// and Ctrl+1…9 (Cmd on a Mac). The menu shows them; the views catch them, because a page has the
// focus and a menu item has one accelerator.
export const tabKeyOf = (input: KeyInput, mac: boolean): TabKey | undefined => {
  if (input.type !== "keyDown" || input.alt) return undefined;
  if (input.control && !input.meta) {
    if (input.key === "Tab") return { _tag: "Step", by: input.shift ? -1 : 1 };
    if (!input.shift && input.key === "PageDown") return { _tag: "Step", by: 1 };
    if (!input.shift && input.key === "PageUp") return { _tag: "Step", by: -1 };
  }
  const command = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!command || input.shift) return undefined;
  const key = input.key.toLowerCase();
  if (key === "t") return { _tag: "New" };
  if (key === "w") return { _tag: "Close" };
  if (/^[1-9]$/u.test(key)) return { _tag: "Position", position: Number(key) };
  return undefined;
};
