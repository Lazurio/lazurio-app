import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { AuthClientShape, DirectoryNetwork } from "./AuthClient.ts";
import * as TailnetDirectory from "./TailnetDirectory.ts";

// The person's networks from Lazurio Auth (Auth's docs/network-directory-read.md, task 644): read
// at each sign-in, kept as the last complete list so a connected computer needs Auth only for a
// change. Being listed grants nothing; TailnetDirectory still takes only Lazurio's domains.

const CONTROL_SERVER_PREFIX = "headscale.";

// A network's DNS suffix: Auth answers only `https://headscale.<label>.lazurio.io`, whose names lie
// in `<label>.lazurio.io`; any other address gets none, so TailnetDirectory refuses it. A network
// serving Organizations in other zones needs the suffixes from Auth (a later field of v1).
const domainsOf = (controlUrl: string): ReadonlyArray<string> => {
  const host = URL.parse(controlUrl)?.hostname ?? "";
  return host.startsWith(CONTROL_SERVER_PREFIX) ? [host.slice(CONTROL_SERVER_PREFIX.length)] : [];
};

// The directory's text in TailnetDirectory's form, sorted, so that the same networks give the same
// text.
export const textOf = (networks: ReadonlyArray<DirectoryNetwork>): string =>
  JSON.stringify(
    [...networks]
      .sort((a, b) => (a.tailnet < b.tailnet ? -1 : a.tailnet > b.tailnet ? 1 : 0))
      .map(({ tailnet, controlUrl }) => ({ tailnet, controlUrl, domains: domainsOf(controlUrl) })),
    null,
    2,
  );

// The last complete list, or none when the app has none yet or cannot read it.
export const readSaved = Effect.fn("NetworkDirectory.readSaved")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(Effect.option);
});

export interface ReadOptions {
  readonly auth: AuthClientShape;
  readonly savedPath: string;
  // The text the running app took its tailnets from; none when they came from elsewhere.
  readonly inUse: Option.Option<string>;
  // Called once a list differs from the one in use and is saved: the app starts again with it.
  readonly changed: Effect.Effect<void>;
  readonly computer: string;
  // Tests only: after each sign-in's read is handled.
  readonly handled?: Effect.Effect<void>;
}

// Reads the person's networks whenever the app is signed in, and saves a complete, non-empty list
// that differs from the saved one. A refusal, an empty list or Auth out of reach keeps the last
// one, and the next sign-in or start reads again; the read never retries in a loop.
export const follow = Effect.fn("NetworkDirectory.follow")(function* (options: ReadOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* options.auth.changes.pipe(
    Stream.filter((state) => state === "signedIn"),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const networks = yield* options.auth.networks.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("network directory not read", { reason: error.message }),
          ),
          Effect.option,
        );
        if (Option.isNone(networks)) return;
        if (networks.value.length === 0) {
          yield* Effect.logInfo("network directory: no network for this person");
          return;
        }
        const text = textOf(networks.value);
        // A list the app would refuse whole is no list to start with.
        const directory = yield* TailnetDirectory.fromText(text, options.computer).pipe(
          Effect.option,
        );
        if (Option.isNone(directory) || directory.value.tailnets.length === 0) {
          yield* Effect.logWarning("network directory: no network the app accepts");
          return;
        }
        const saved = yield* readSaved(options.savedPath);
        if (Option.isNone(saved) || saved.value !== text) {
          yield* fileSystem.makeDirectory(path.dirname(options.savedPath), { recursive: true });
          yield* fileSystem.writeFileString(options.savedPath, text);
          yield* Effect.logInfo("network directory saved", {
            tailnets: directory.value.tailnets.map((tailnet) => tailnet.tailnet),
          });
        }
        if (Option.isNone(options.inUse) || options.inUse.value !== text) yield* options.changed;
      }).pipe(
        Effect.catch((error) => Effect.logWarning("network directory not saved", error)),
        Effect.andThen(options.handled ?? Effect.void),
      ),
    ),
    Effect.forkScoped,
  );
});
