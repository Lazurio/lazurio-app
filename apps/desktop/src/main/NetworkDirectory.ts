import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { AuthClientShape, DirectoryNetwork } from "./AuthClient.ts";
import * as TailnetDirectory from "./TailnetDirectory.ts";

// The person's networks from Lazurio Auth (Auth's docs/network-directory-read.md, task 644): read
// at each sign-in, kept as the last complete list so a connected computer needs Auth only for a
// change. Being listed grants nothing; TailnetDirectory still takes only Lazurio's domains.

// The networks Auth answers without `domains`. The read names only the person's own memberships,
// never the whole set a network serves, so not even a network listed with one Organization proves
// that its control server's suffix is that Organization's zone: such an answer keeps the last
// complete list, and the app never routes a network by a guessed suffix.
export const unroutable = (networks: ReadonlyArray<DirectoryNetwork>): ReadonlyArray<string> =>
  networks
    .filter((network) => network.domains === undefined || network.domains.length === 0)
    .map((network) => network.tailnet);

// Starts the app again for a new list only once no agent works, or may (work not confirmed ended
// counts), as SettingWatch waits; `restart` is the app's one restart for the run.
export const restartWhenIdle = (
  agentWorks: () => boolean,
  restart: Effect.Effect<void>,
  every: Duration.Input = "5 seconds",
): Effect.Effect<void> =>
  Effect.suspend(() => (agentWorks() ? Effect.fail("agent works" as const) : Effect.void)).pipe(
    Effect.retry(Schedule.spaced(every)),
    Effect.andThen(restart),
    Effect.ignore,
  );

// The directory's text in TailnetDirectory's form, sorted, so that the same networks give the same
// text.
export const textOf = (networks: ReadonlyArray<DirectoryNetwork>): string =>
  JSON.stringify(
    [...networks]
      .sort((a, b) => (a.tailnet < b.tailnet ? -1 : a.tailnet > b.tailnet ? 1 : 0))
      .map(({ tailnet, controlUrl, domains }) => ({ tailnet, controlUrl, domains: domains ?? [] })),
    null,
    2,
  );

// The last complete list, or none when the app has none yet or cannot read it.
export const readSaved = Effect.fn("NetworkDirectory.readSaved")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(Effect.option);
});

export type ReadOutcome = "read" | "needs-sign-in" | "not-read";

export interface ReadOptions {
  readonly auth: AuthClientShape;
  readonly savedPath: string;
  // The text the running app took its tailnets from; none when they came from elsewhere.
  readonly inUse: Option.Option<string>;
  // Called once a list differs from the one in use and is saved: the app starts again with it.
  readonly changed: Effect.Effect<void>;
  readonly computer: string;
  // How the latest read went: read, or the session lacks the directory's scope (a sign-in from
  // before the app asked for it) and the person must sign in again, or not read for another reason.
  readonly onRead: (outcome: ReadOutcome) => Effect.Effect<void>;
  // Tests only: after each sign-in's read is handled.
  readonly handled?: Effect.Effect<void>;
}

// Reads the person's networks whenever the app is signed in, and saves a complete list that differs
// from the saved one, an empty one too: Auth's answer replaces the list whole. A refusal or Auth out
// of reach keeps the last one, and the next sign-in or start reads again; never in a loop.
export const follow = Effect.fn("NetworkDirectory.follow")(function* (options: ReadOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* options.auth.changes.pipe(
    Stream.filter((state) => state === "signedIn"),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const networks = yield* options.auth.networks.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("network directory not read", { reason: error.message }).pipe(
              Effect.andThen(
                options.onRead(
                  error._tag === "NetworkDirectoryError" && error.reason === "scope-not-granted"
                    ? "needs-sign-in"
                    : "not-read",
                ),
              ),
            ),
          ),
          Effect.option,
        );
        if (Option.isNone(networks)) return;
        const unrouted = unroutable(networks.value);
        if (unrouted.length > 0) {
          yield* Effect.logWarning("network directory kept: a network without its zones", {
            tailnets: unrouted,
          });
          return yield* options.onRead("not-read");
        }
        if (networks.value.length === 0) {
          yield* Effect.logInfo("network directory: no network for this person");
        }
        const text = textOf(networks.value);
        // The list replaces the last one whole, or not at all: one network the app refuses keeps
        // the last complete list (Auth's contract, Required consumer proof).
        const directory = yield* TailnetDirectory.fromText(text, options.computer).pipe(
          Effect.option,
        );
        if (Option.isNone(directory) || directory.value.refused.length > 0) {
          yield* Effect.logWarning("network directory refused whole", {
            refused: Option.match(directory, {
              onNone: () => [],
              onSome: (value) => value.refused,
            }),
          });
          return yield* options.onRead("not-read");
        }
        // The read counts as done only once the list is saved: a list that cannot be written is
        // never used, so the window says the read failed and offers it again.
        const saved = yield* readSaved(options.savedPath);
        if (Option.isNone(saved) || saved.value !== text) {
          const written = yield* Effect.gen(function* () {
            yield* fileSystem.makeDirectory(path.dirname(options.savedPath), { recursive: true });
            yield* fileSystem.writeFileString(options.savedPath, text);
          }).pipe(
            Effect.tapError((error) => Effect.logWarning("network directory not saved", error)),
            Effect.option,
          );
          if (Option.isNone(written)) return yield* options.onRead("not-read");
          yield* Effect.logInfo("network directory saved", {
            tailnets: directory.value.tailnets.map((tailnet) => tailnet.tailnet),
          });
        }
        yield* options.onRead("read");
        if (Option.isNone(options.inUse) || options.inUse.value !== text) yield* options.changed;
      }).pipe(Effect.andThen(options.handled ?? Effect.void)),
    ),
    Effect.forkScoped,
  );
});
