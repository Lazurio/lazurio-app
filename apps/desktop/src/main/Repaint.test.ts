import { assert, describe, it } from "@effect/vitest";

import { checkViews, type RepaintPort } from "./Repaint.ts";

// A window with views by name, whose answers to visibility a test scripts, and which may change
// while an answer is awaited.
const fakeWindow = (options: {
  readonly views: ReadonlyArray<{ readonly name: string; readonly reloadable: boolean }>;
  // The answers, in order, and what happens while each one is awaited.
  readonly answers: ReadonlyArray<{ readonly visibility: string; readonly meanwhile?: () => void }>;
}) => {
  const state = { showing: true, shown: new Set(options.views.map((view) => view.name)) };
  const done: Array<string> = [];
  const logged: Array<Readonly<Record<string, string>>> = [];
  const answers = [...options.answers];
  const port: RepaintPort<string> = {
    windowShowing: () => state.showing,
    views: () =>
      options.views
        .filter((view) => state.shown.has(view.name))
        .map((view) => ({ name: view.name, view: view.name, reloadable: view.reloadable })),
    usable: () => true,
    visibilityOf: async () => {
      const answer = answers.shift();
      if (answer === undefined) return "visible";
      answer.meanwhile?.();
      return answer.visibility;
    },
    reattach: (view) => done.push(`reattach ${view}`),
    reloaded: new Set(),
    reload: (view) => done.push(`reload ${view}`),
    log: (fields) => logged.push(fields),
  };
  return { state, done, logged, port };
};

describe("Repaint.checkViews", () => {
  it("leaves a visible view as it is", async () => {
    const window = fakeWindow({
      views: [{ name: "page", reloadable: false }],
      answers: [{ visibility: "visible" }],
    });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, []);
    assert.deepStrictEqual(window.logged, []);
  });

  it("attaches a hidden view again, and stops once it is visible", async () => {
    const window = fakeWindow({
      views: [{ name: "page", reloadable: false }],
      answers: [{ visibility: "hidden" }, { visibility: "visible" }],
    });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, ["reattach page"]);
    assert.deepStrictEqual(window.logged, [
      { view: "page", reason: "show", before: "hidden", after: "visible" },
    ]);
  });

  it("loads only the app's own page again, never a page of the web Lazurio", async () => {
    const window = fakeWindow({
      views: [
        { name: "column", reloadable: true },
        { name: "page", reloadable: false },
      ],
      answers: [
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "hidden" },
      ],
    });
    await checkViews(window.port, "active");
    assert.deepStrictEqual(window.done, ["reattach column", "reload column", "reattach page"]);
    assert.deepStrictEqual(
      window.logged.map((fields) => fields["after"]),
      ["reloaded", "hidden"],
    );
  });

  it("changes nothing when the window hides while the visibility is awaited", async () => {
    const window = fakeWindow({
      views: [{ name: "column", reloadable: true }],
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
      views: [{ name: "page", reloadable: false }],
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

  it("does not load again when the window hides after the view was attached again", async () => {
    const window = fakeWindow({
      views: [{ name: "column", reloadable: true }],
      answers: [
        { visibility: "hidden" },
        {
          visibility: "hidden",
          meanwhile: () => {
            window.state.showing = false;
          },
        },
      ],
    });
    await checkViews(window.port, "show");
    assert.deepStrictEqual(window.done, ["reattach column"]);
  });

  // A computer without a display, where a shown window's pages stay hidden: no reload every check.
  it("loads the app's own page again only once until it is seen visible", async () => {
    const window = fakeWindow({
      views: [{ name: "column", reloadable: true }],
      answers: [
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "hidden" },
        { visibility: "visible" },
        { visibility: "hidden" },
        { visibility: "hidden" },
      ],
    });
    await checkViews(window.port, "active");
    await checkViews(window.port, "active");
    await checkViews(window.port, "show");
    await checkViews(window.port, "active");
    assert.deepStrictEqual(window.done, [
      "reattach column",
      "reload column",
      "reattach column",
      "reattach column",
      "reload column",
    ]);
  });
});
