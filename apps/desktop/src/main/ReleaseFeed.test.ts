import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  atomHasNightly,
  channelHasRelease,
  ReleaseFeedError,
  repositoryOfUpdateConfig,
} from "./ReleaseFeed.ts";

const REPOSITORY = { owner: "Lazurio", repo: "lazurio-app" };

describe("repositoryOfUpdateConfig", () => {
  it("reads the GitHub repository of app-update.yml, and nothing for another provider", () => {
    assert.deepStrictEqual(
      repositoryOfUpdateConfig(
        "owner: Lazurio\nrepo: lazurio-app\nprovider: github\nupdaterCacheDirName: lazurio-app-updater\n",
      ),
      Option.some(REPOSITORY),
    );
    assert.isTrue(
      Option.isNone(repositoryOfUpdateConfig("provider: generic\nurl: http://127.0.0.1:47123/\n")),
    );
  });
});

describe("atomHasNightly", () => {
  it("finds a nightly's tag among the releases' entries", () => {
    const entry = (tag: string) =>
      `<entry><link rel="alternate" type="text/html" href="https://github.com/Lazurio/lazurio-app/releases/tag/${tag}"/></entry>`;
    assert.isTrue(atomHasNightly(`<feed>${entry("v0.1.0-nightly.20261117.8")}</feed>`));
    assert.isFalse(atomHasNightly(`<feed>${entry("v0.1.0")}</feed>`));
    assert.isFalse(atomHasNightly("<feed></feed>"));
  });
});

describe("channelHasRelease", () => {
  const RELEASES = "https://github.com/Lazurio/lazurio-app/releases";
  const answering =
    (status: number, url = RELEASES, text = "") =>
    () =>
      Effect.succeed({ status, url, text });

  // As github.com answers on 2026-11-17: /releases/latest redirects to the latest stable release's
  // tag, or to the list of releases when there is no stable release.
  it.effect("confirms stable absent only when GitHub sends the latest release to the list", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* channelHasRelease(REPOSITORY, "latest", answering(200, RELEASES)),
        Option.some(false),
      );
      assert.deepStrictEqual(
        yield* channelHasRelease(REPOSITORY, "latest", answering(200, `${RELEASES}/tag/v0.1.0`)),
        Option.some(true),
      );
      assert.isTrue(Option.isNone(yield* channelHasRelease(REPOSITORY, "latest", answering(503))));
      assert.isTrue(
        Option.isNone(
          yield* channelHasRelease(
            REPOSITORY,
            "latest",
            answering(200, "https://github.com/login"),
          ),
        ),
      );
      assert.isTrue(
        Option.isNone(
          yield* channelHasRelease(REPOSITORY, "latest", () =>
            Effect.fail(new ReleaseFeedError({ cause: "offline" })),
          ),
        ),
      );
    }),
  );

  it.effect("reads a nightly from the releases' Atom feed, and asks the right address", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const atom = (text: string) => (url: string) =>
        Effect.sync(() => {
          urls.push(url);
          return { status: 200, url, text };
        });
      const feed = (entries: string) =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
      const NIGHTLY = `<link rel="alternate" href="${RELEASES}/tag/v0.1.0-nightly.20261117.8"/>`;
      assert.deepStrictEqual(
        yield* channelHasRelease(REPOSITORY, "nightly", atom(feed(""))),
        Option.some(false),
      );
      assert.deepStrictEqual(
        yield* channelHasRelease(REPOSITORY, "nightly", atom(feed(NIGHTLY))),
        Option.some(true),
      );
      assert.deepStrictEqual(urls, [`${RELEASES}.atom`, `${RELEASES}.atom`]);
    }),
  );

  it.effect("answers nothing about a nightly unless the feed itself answered", () =>
    Effect.gen(function* () {
      const unknown = (status: number, url: string, text: string) =>
        channelHasRelease(REPOSITORY, "nightly", answering(status, url, text)).pipe(
          Effect.map(Option.isNone),
        );
      const EMPTY_FEED = '<feed xmlns="http://www.w3.org/2005/Atom"></feed>';
      // Not found, or GitHub sent the request on to a sign-in page or elsewhere.
      assert.isTrue(yield* unknown(404, `${RELEASES}.atom`, EMPTY_FEED));
      assert.isTrue(yield* unknown(200, "https://github.com/login", EMPTY_FEED));
      assert.isTrue(yield* unknown(200, RELEASES, EMPTY_FEED));
      // The feed's address answered with a page, an empty body or a feed of another kind.
      assert.isTrue(
        yield* unknown(200, `${RELEASES}.atom`, "<!doctype html><title>Sign in</title>"),
      );
      assert.isTrue(yield* unknown(200, `${RELEASES}.atom`, ""));
      assert.isTrue(yield* unknown(200, `${RELEASES}.atom`, "<feed></feed>"));
    }),
  );
});
