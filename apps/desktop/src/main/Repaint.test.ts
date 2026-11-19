import { assert, describe, it } from "@effect/vitest";

import { checkViews, RETRY_AFTER_MS, type RepaintPort } from "./Repaint.ts";

// A window with views by name, whose answers to visibility a test scripts, and which may change
// while an answer is awaited.
const fakeWindow = (options: {
  readonly views: ReadonlyArray<string>;
  // The answers, in order, and what happens while each one is awaited.
  readonly answers: ReadonlyArray<{ readonly visibility: string; readonly meanwhile?: () => void }>;
}) => {
  const state = { showing: true, focused: true, shown: new Set(options.views), now: 0 };
  const done: Array<string> = [];
  const logged: Array<Readonly<Record<string, string>>> = [];
  const answers = [...options.answers];
  const port: RepaintPort<string> = {
    windowInFront: () => state.showing && state.focused,
    views: () =>
      options.views.filter((name) => state.shown.has(name)).map((name) => ({ name, view: name })),
    usable: () => true,
    visibilityOf: async () => {
      const answer = answers.shift();
      if (answer === undefined) return "visible";
      answer.meanwhile?.();
      return answer.visibility;
    },
    reattach: (view) => done.push(`reattach ${view}`),
    attached: new Map(),
    now: () => state.now,
    log: (fields) => logged.push(fields),
  };
  return { state, done, logged, port };
};

describe("Repaint.checkViews", () => {
  it("leaves a visible view as it is", async () => {
    const window = fakeWindow({ views: ["page"], answers: [{ visibility: "visible" }] });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, []);
    assert.deepStrictEqual(window.logged, []);
  });

  it("attaches a hidden view again, and logs that it became visible", async () => {
    const window = fakeWindow({
      views: ["page"],
      answers: [{ visibility: "hidden" }, { visibility: "visible" }],
    });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, ["reattach page"]);
    assert.deepStrictEqual(window.logged, [
      { view: "page", reason: "show", before: "hidden", after: "visible" },
    ]);
  });

  // A focused window that a window on top covers: its pages are rightly hidden. The check never
  // loads anything again, and attaches such a view again at most every RETRY_AFTER_MS.
  it("attaches a focused but covered window's view again at most every interval, never loading it", async () => {
    const window = fakeWindow({
      views: ["column"],
      answers: Array.from({ length: 8 }, () => ({ visibility: "hidden" })),
    });
    await checkViews(window.port, "resume");
    window.state.now = 5_000;
    await checkViews(window.port, "active");
    window.state.now = 10_000;
    await checkViews(window.port, "unlock-screen");
    window.state.now = RETRY_AFTER_MS + 1;
    await checkViews(window.port, "active");
    assert.deepStrictEqual(window.done, ["reattach column", "reattach column"]);
    assert.deepStrictEqual(
      window.logged.map((fields) => `${fields["reason"]} ${fields["after"]}`),
      ["resume hidden", "active hidden"],
    );
  });

  // The display was still off at the first attempt; it wakes without any event, and the next
  // check after the interval shows the page.
  it("tries again after the display woke, when the first attempt left the page hidden", async () => {
    const window = fakeWindow({
      views: ["page"],
      answers: [
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "visible" },
      ],
    });
    await checkViews(window.port, "resume");
    window.state.now = RETRY_AFTER_MS + 5_000;
    await checkViews(window.port, "active");
    assert.deepStrictEqual(window.done, ["reattach page", "reattach page"]);
    assert.deepStrictEqual(window.logged.at(-1), {
      view: "page",
      reason: "active",
      before: "hidden",
      after: "visible",
    });
  });

  it("attaches again at once after the view was seen visible in between", async () => {
    const window = fakeWindow({
      views: ["column"],
      answers: [
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "visible" },
        { visibility: "hidden" },
        { visibility: "visible" },
      ],
    });
    await checkViews(window.port, "resume");
    window.state.now = 1_000;
    await checkViews(window.port, "show");
    window.state.now = 2_000;
    await checkViews(window.port, "active");
    assert.deepStrictEqual(window.done, ["reattach column", "reattach column"]);
  });

  it("leaves a window that is not in front alone on resume or unlock", async () => {
    const window = fakeWindow({
      views: ["agent-desktop"],
      answers: [{ visibility: "hidden" }, { visibility: "hidden" }],
    });
    window.state.focused = false;
    await checkViews(window.port, "resume");
    await checkViews(window.port, "unlock-screen");
    assert.deepStrictEqual(window.done, []);
  });

  it("changes nothing when the window hides while the visibility is awaited", async () => {
    const window = fakeWindow({
      views: ["column"],
      answers: [
        {
          visibility: "hidden",
          meanwhile: () => {
            window.state.showing = false;
          },
        },
      ],
    });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, []);
  });

  // watchPage hid the page and showed the reason in its place meanwhile.
  it("changes nothing when the view stops being shown while the visibility is awaited", async () => {
    const window = fakeWindow({
      views: ["page"],
      answers: [
        {
          visibility: "hidden",
          meanwhile: () => {
            window.state.shown.delete("page");
          },
        },
      ],
    });
    await checkViews(window.port, "focus");
    assert.deepStrictEqual(window.done, []);
  });
});
