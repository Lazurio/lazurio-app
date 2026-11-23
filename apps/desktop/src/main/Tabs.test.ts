import { assert, describe, it } from "@effect/vitest";

import {
  activated,
  atPosition,
  canClose,
  closed,
  opened,
  single,
  stepped,
  tabKeyOf,
  type KeyInput,
} from "./Tabs.ts";

const list = (order: ReadonlyArray<number>, active: number) => ({ order, active });

describe("the main window's tabs", () => {
  it("opens a tab right after the one in front, and in front", () => {
    assert.deepStrictEqual(opened(single(1), 2, false), list([1, 2], 2));
    assert.deepStrictEqual(opened(list([1, 2, 3], 1), 4, false), list([1, 4, 2, 3], 4));
  });

  it("opens a tab of a middle click in the background", () => {
    assert.deepStrictEqual(opened(list([1, 2, 3], 1), 4, true), list([1, 4, 2, 3], 1));
  });

  it("keeps one tab at least", () => {
    assert.isFalse(canClose(single(1)));
    assert.deepStrictEqual(closed(single(1), 1), single(1));
  });

  it("puts the right neighbour of a closed front tab in front, or the left one at the end", () => {
    assert.deepStrictEqual(closed(list([1, 2, 3], 2), 2), list([1, 3], 3));
    assert.deepStrictEqual(closed(list([1, 2, 3], 3), 3), list([1, 2], 2));
    assert.deepStrictEqual(closed(list([1, 2, 3], 1), 3), list([1, 2], 1));
    assert.deepStrictEqual(closed(list([1, 2], 1), 7), list([1, 2], 1));
  });

  it("switches to a tab, the next, the previous, around the ends", () => {
    assert.deepStrictEqual(activated(list([1, 2], 1), 2), list([1, 2], 2));
    assert.deepStrictEqual(activated(list([1, 2], 1), 9), list([1, 2], 1));
    assert.deepStrictEqual(stepped(list([1, 2, 3], 3), 1), list([1, 2, 3], 1));
    assert.deepStrictEqual(stepped(list([1, 2, 3], 1), -1), list([1, 2, 3], 3));
  });

  it("switches by position, 9 to the last", () => {
    assert.deepStrictEqual(atPosition(list([1, 2, 3], 1), 2), list([1, 2, 3], 2));
    assert.deepStrictEqual(atPosition(list([1, 2, 3], 1), 9), list([1, 2, 3], 3));
    assert.deepStrictEqual(atPosition(list([1, 2, 3], 1), 5), list([1, 2, 3], 1));
  });
});

const key = (over: Partial<KeyInput>): KeyInput => ({
  type: "keyDown",
  key: "",
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...over,
});

describe("the tabs' keys", () => {
  it("takes Ctrl on Windows and Linux, Cmd on a Mac", () => {
    assert.deepStrictEqual(tabKeyOf(key({ key: "t", control: true }), false), { _tag: "New" });
    assert.deepStrictEqual(tabKeyOf(key({ key: "T", meta: true }), true), { _tag: "New" });
    assert.isUndefined(tabKeyOf(key({ key: "t", meta: true }), false));
    assert.isUndefined(tabKeyOf(key({ key: "t", control: true }), true));
    assert.deepStrictEqual(tabKeyOf(key({ key: "w", control: true }), false), { _tag: "Close" });
    assert.deepStrictEqual(tabKeyOf(key({ key: "3", meta: true }), true), {
      _tag: "Position",
      position: 3,
    });
  });

  it("steps with Ctrl+Tab and Ctrl+PageDown on every system", () => {
    for (const mac of [false, true]) {
      assert.deepStrictEqual(tabKeyOf(key({ key: "Tab", control: true }), mac), {
        _tag: "Step",
        by: 1,
      });
      assert.deepStrictEqual(tabKeyOf(key({ key: "Tab", control: true, shift: true }), mac), {
        _tag: "Step",
        by: -1,
      });
      assert.deepStrictEqual(tabKeyOf(key({ key: "PageUp", control: true }), mac), {
        _tag: "Step",
        by: -1,
      });
    }
  });

  it("leaves other keys to the page", () => {
    assert.isUndefined(tabKeyOf(key({ key: "t" }), false));
    assert.isUndefined(tabKeyOf(key({ key: "t", control: true, shift: true }), false));
    assert.isUndefined(tabKeyOf(key({ key: "t", control: true, alt: true }), false));
    assert.isUndefined(tabKeyOf(key({ key: "0", control: true }), false));
    assert.isUndefined(tabKeyOf(key({ key: "t", control: true, type: "keyUp" }), false));
    assert.isUndefined(tabKeyOf(key({ key: "Tab" }), false));
  });
});
