import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { UpdateChannel } from "./UpdateChannel.ts";

// Whether the chosen channel has a release, asked after a failed check: electron-updater's error
// does not tell an absent release from a network or feed failure (its GitHub provider wraps them
// all), so the app asks the same GitHub host itself and answers "none" only when GitHub confirms it.

// The GitHub repository of the update feed, from the packaged app's app-update.yml; none for any
// other provider, such as a trial build's local feed.
export const repositoryOfUpdateConfig = (
  text: string,
): Option.Option<{ readonly owner: string; readonly repo: string }> => {
  const value = (key: string) =>
    new RegExp(`^${key}:\\s*["']?([A-Za-z0-9_.-]+)["']?\\s*$`, "mu").exec(text)?.[1];
  const provider = value("provider");
  const owner = value("owner");
  const repo = value("repo");
  return provider === "github" && owner !== undefined && repo !== undefined
    ? Option.some({ owner, repo })
    : Option.none();
};

const NIGHTLY_TAG = /\/releases\/tag\/v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+["<]/u;
// An Atom feed's root element, which GitHub's releases.atom has and a sign-in or error page has not.
const ATOM_FEED = /<feed\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2005\/Atom"/u;

// Whether the releases' Atom feed lists a nightly.
export const atomHasNightly = (xml: string): boolean => NIGHTLY_TAG.test(xml);

// GitHub did not answer the question.
export class ReleaseFeedError extends Schema.TaggedError<ReleaseFeedError>()("ReleaseFeedError", {
  cause: Schema.Defect(),
}) {}

interface Answer {
  readonly status: number;
  // The address the answer came from, after GitHub's redirects.
  readonly url: string;
  readonly text: string;
}

// Some(true) or Some(false) when GitHub answered, none when it did not (a network or other
// failure): then the check's failure stands. GitHub sends /releases/latest on to the latest stable
// release's tag, or to the list of releases when there is none; a nightly is in the Atom feed.
export const channelHasRelease = Effect.fn("ReleaseFeed.channelHasRelease")(function* <E>(
  repository: { readonly owner: string; readonly repo: string },
  channel: UpdateChannel,
  get: (url: string) => Effect.Effect<Answer, E>,
) {
  const base = `https://github.com/${repository.owner}/${repository.repo}/releases`;
  const answer = yield* get(channel === "latest" ? `${base}/latest` : `${base}.atom`).pipe(
    Effect.option,
  );
  if (Option.isNone(answer)) return Option.none<boolean>();
  const { status, url, text } = answer.value;
  if (channel === "latest") {
    if (status !== 200) return Option.none<boolean>();
    if (url.startsWith(`${base}/tag/`)) return Option.some(true);
    return url === base || url === `${base}/` ? Option.some(false) : Option.none<boolean>();
  }
  // Only the feed itself answers: not a page GitHub sent the request on to, nor anything else.
  return status === 200 && url === `${base}.atom` && ATOM_FEED.test(text)
    ? Option.some(atomHasNightly(text))
    : Option.none<boolean>();
});
