import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  type AuthClientShape,
  type AuthState,
  type DirectoryNetwork,
  NetworkDirectoryError,
} from "./AuthClient.ts";
import type { DeviceStatus } from "../shared/bridge.ts";
import {
  follow,
  readSaved,
  type ReadOutcome,
  restartWhenIdle,
  textOf,
  unroutable,
} from "./NetworkDirectory.ts";
import * as TailnetDirectory from "./TailnetDirectory.ts";

const EXAMPLE: DirectoryNetwork = {
  tailnet: "lazurioexampleorganization",
  controlUrl: "https://headscale.lazurioexampleorganization.lazurio.io",
  domains: ["lazurioexampleorganization.lazurio.io"],
};
const OTHER: DirectoryNetwork = {
  tailnet: "another-org",
  controlUrl: "https://headscale.another-org.lazurio.io",
  domains: ["another-org.lazurio.io"],
};

describe("NetworkDirectory.textOf", () => {
  it.effect("keeps each network's zones as its suffixes, in the built-in directory's form", () =>
    Effect.gen(function* () {
      const text = textOf([OTHER, EXAMPLE]);
      // The same networks in any order give the same text.
      assert.strictEqual(text, textOf([EXAMPLE, OTHER]));
      const directory = yield* TailnetDirectory.fromText(text, "Desktop-1");
      assert.deepStrictEqual(
        directory.tailnets.map(({ tailnet, controlUrl, domains }) => ({
          tailnet,
          controlUrl,
          domains,
        })),
        [
          {
            tailnet: "another-org",
            controlUrl: OTHER.controlUrl,
            domains: ["another-org.lazurio.io"],
          },
          {
            tailnet: "lazurioexampleorganization",
            controlUrl: EXAMPLE.controlUrl,
            domains: ["lazurioexampleorganization.lazurio.io"],
          },
        ],
      );
    }),
  );

  it.effect("guesses no suffix for a network without zones, so it joins nothing", () =>
    Effect.gen(function* () {
      const directory = yield* TailnetDirectory.fromText(
        textOf([{ tailnet: "odd", controlUrl: "https://headscale.odd.lazurio.io" }]),
        "Desktop-1",
      );
      assert.deepStrictEqual(directory.tailnets, []);
      assert.deepStrictEqual(directory.refused, [
        { tailnet: "odd", reason: "it names no DNS suffix" },
      ]);
    }),
  );
});

// A signed-out app that a test signs in, whose directory answers what the test sets.
const fakeAuth = (
  answer: () => Effect.Effect<ReadonlyArray<DirectoryNetwork>, NetworkDirectoryError>,
) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<AuthState>("signedOut");
    let reads = 0;
    const auth: AuthClientShape = {
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      signIn: SubscriptionRef.set(state, "signedIn"),
      signOut: SubscriptionRef.set(state, "signedOut"),
      handOver: () => Effect.die("no hand-over here"),
      accountName: Effect.succeedNone,
      networks: Effect.suspend(() => {
        reads += 1;
        return answer();
      }),
    };
    return { auth, reads: () => reads, signOut: SubscriptionRef.set(state, "signedOut") };
  });

const withFollow = <E>(
  answer: () => Effect.Effect<ReadonlyArray<DirectoryNetwork>, NetworkDirectoryError>,
  inUse: Option.Option<string>,
  test: (setup: {
    readonly auth: AuthClientShape;
    readonly reads: () => number;
    readonly signOut: Effect.Effect<void>;
    readonly savedPath: string;
    readonly changes: () => number;
    readonly outcomes: ReadonlyArray<ReadOutcome>;
    // Waits until the read after the latest sign-in is handled.
    readonly handled: Effect.Effect<void>;
  }) => Effect.Effect<void, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const savedPath = (yield* Path.Path).join(directory, "network-directory.json");
    const { auth, reads, signOut } = yield* fakeAuth(answer);
    const done = yield* Queue.unbounded<void>();
    let changes = 0;
    const outcomes: Array<ReadOutcome> = [];
    yield* follow({
      auth,
      savedPath,
      inUse,
      computer: "Desktop-1",
      onRead: (outcome) =>
        Effect.sync(() => {
          outcomes.push(outcome);
        }),
      changed: Effect.sync(() => {
        changes += 1;
      }),
      handled: Queue.offer(done, undefined).pipe(Effect.asVoid),
    });
    yield* test({
      auth,
      reads,
      signOut,
      savedPath,
      changes: () => changes,
      outcomes,
      handled: Queue.take(done),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("NetworkDirectory.follow", () => {
  it.effect("saves the person's networks after a sign-in and starts the app again with them", () =>
    withFollow(
      () => Effect.succeed([EXAMPLE]),
      Option.none(),
      ({ auth, reads, savedPath, changes, handled }) =>
        Effect.gen(function* () {
          assert.strictEqual(reads(), 0);
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(yield* readSaved(savedPath), Option.some(textOf([EXAMPLE])));
          assert.strictEqual(changes(), 1);
        }),
    ),
  );

  it.effect("starts nothing again when the list in use is the person's", () =>
    withFollow(
      () => Effect.succeed([EXAMPLE]),
      Option.some(textOf([EXAMPLE])),
      ({ auth, savedPath, changes, handled }) =>
        Effect.gen(function* () {
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(yield* readSaved(savedPath), Option.some(textOf([EXAMPLE])));
          assert.strictEqual(changes(), 0);
        }),
    ),
  );

  it.effect("keeps the last list when Auth refuses or answers nothing the app accepts", () => {
    const answers: Array<Effect.Effect<ReadonlyArray<DirectoryNetwork>, NetworkDirectoryError>> = [
      Effect.fail(new NetworkDirectoryError({ reason: "unavailable", status: 503 })),
      Effect.succeed([
        {
          tailnet: "outside",
          controlUrl: "https://headscale.example.com",
          domains: ["example.com"],
        },
      ]),
    ];
    return withFollow(
      () => answers.shift() ?? Effect.die("no more answers"),
      Option.some(textOf([EXAMPLE])),
      ({ auth, signOut, savedPath, changes, handled }) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            yield* auth.signIn;
            yield* handled;
            yield* signOut;
          }
          assert.isTrue(Option.isNone(yield* readSaved(savedPath)));
          assert.strictEqual(changes(), 0);
        }),
    );
  });

  it.effect("replaces the list with an empty answer: a person in no Organization joins none", () =>
    withFollow(
      () => Effect.succeed([]),
      Option.some(textOf([EXAMPLE])),
      ({ auth, savedPath, changes, outcomes, handled }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(savedPath, textOf([EXAMPLE]));
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(yield* readSaved(savedPath), Option.some(textOf([])));
          assert.deepStrictEqual(
            (yield* TailnetDirectory.fromText(textOf([]), "Desktop-1")).tailnets,
            [],
          );
          assert.strictEqual(changes(), 1);
          assert.deepStrictEqual(outcomes, ["read"]);
        }),
    ),
  );

  it.effect("starts nothing again when the empty list is the one in use", () =>
    withFollow(
      () => Effect.succeed([]),
      Option.some(textOf([])),
      ({ auth, changes, handled }) =>
        Effect.gen(function* () {
          yield* auth.signIn;
          yield* handled;
          assert.strictEqual(changes(), 0);
        }),
    ),
  );

  // The read names only the person's memberships: a shared network may show one Organization.
  it.effect("keeps the last complete list for a network answered without its zones", () =>
    withFollow(
      () =>
        Effect.succeed([
          EXAMPLE,
          {
            tailnet: "shared-host",
            controlUrl: "https://headscale.shared-host.lazurio.io",
          },
        ]),
      Option.some(textOf([EXAMPLE])),
      ({ auth, savedPath, changes, outcomes, handled }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(savedPath, textOf([OTHER]));
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(yield* readSaved(savedPath), Option.some(textOf([OTHER])));
          assert.strictEqual(changes(), 0);
          assert.deepStrictEqual(outcomes, ["not-read"]);
        }),
    ),
  );

  it("routes no network by its control server's suffix, even one listed with one Organization", () => {
    assert.deepStrictEqual(unroutable([EXAMPLE, OTHER]), []);
    assert.deepStrictEqual(
      unroutable([
        { tailnet: OTHER.tailnet, controlUrl: OTHER.controlUrl },
        { ...EXAMPLE, domains: [] },
        { ...EXAMPLE, tailnet: "shared", domains: ["a.lazurio.io", "b.lazurio.io"] },
      ]),
      ["another-org", "lazurioexampleorganization"],
    );
  });

  it.effect("says the read failed when the list cannot be saved, and starts nothing again", () =>
    withFollow(
      () => Effect.succeed([EXAMPLE]),
      Option.none(),
      ({ auth, savedPath, changes, outcomes, handled }) =>
        Effect.gen(function* () {
          // A directory where the file goes: neither read nor written.
          yield* (yield* FileSystem.FileSystem).makeDirectory(savedPath);
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(outcomes, ["not-read"]);
          assert.strictEqual(changes(), 0);
        }),
    ),
  );

  it.effect("reads again at each sign-in and never while signed out", () =>
    withFollow(
      () => Effect.succeed([EXAMPLE]),
      Option.some(textOf([EXAMPLE])),
      ({ auth, reads, signOut, handled }) =>
        Effect.gen(function* () {
          yield* auth.signIn;
          yield* handled;
          yield* signOut;
          assert.strictEqual(reads(), 1);
          yield* auth.signIn;
          yield* handled;
          assert.strictEqual(reads(), 2);
        }),
    ),
  );

  it.effect("keeps the last complete list when one network of a new answer is refused", () =>
    withFollow(
      () =>
        Effect.succeed([
          OTHER,
          {
            tailnet: "outside",
            controlUrl: "https://headscale.outside.example.com",
            domains: ["outside.example.com"],
          },
        ]),
      Option.some(textOf([EXAMPLE])),
      ({ auth, savedPath, changes, outcomes, handled }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(savedPath, textOf([EXAMPLE]));
          yield* auth.signIn;
          yield* handled;
          assert.deepStrictEqual(yield* readSaved(savedPath), Option.some(textOf([EXAMPLE])));
          assert.strictEqual(changes(), 0);
          assert.deepStrictEqual(outcomes, ["not-read"]);
        }),
    ),
  );

  it.effect("asks for a new sign-in when the session lacks the directory's scope", () => {
    // A session from a version that asked only for the device scope, then a new sign-in.
    const answers: Array<Effect.Effect<ReadonlyArray<DirectoryNetwork>, NetworkDirectoryError>> = [
      Effect.fail(new NetworkDirectoryError({ reason: "scope-not-granted" })),
      Effect.fail(new NetworkDirectoryError({ reason: "unavailable", status: 503 })),
      Effect.succeed([EXAMPLE]),
    ];
    return withFollow(
      () => answers.shift() ?? Effect.die("no more answers"),
      Option.none(),
      ({ auth, outcomes, changes, handled }) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            // A sign-in while signed in reads again too.
            yield* auth.signIn;
            yield* handled;
          }
          assert.deepStrictEqual(outcomes, ["needs-sign-in", "not-read", "read"]);
          assert.strictEqual(changes(), 1);
        }),
    );
  });

  it.effect("takes the suffixes Auth answers for a network that serves several zones", () =>
    Effect.gen(function* () {
      const shared: DirectoryNetwork = {
        tailnet: "shared-host",
        controlUrl: "https://headscale.shared-host.lazurio.io",
        domains: ["first-org.lazurio.io", "second-org.lazurio.io"],
      };
      const directory = yield* TailnetDirectory.fromText(textOf([shared]), "Desktop-1");
      assert.deepStrictEqual(
        directory.tailnets.map((tailnet) => tailnet.domains),
        [["first-org.lazurio.io", "second-org.lazurio.io"]],
      );
      // Tailnet.test.ts routes each such suffix through its network.
      // A suffix outside Lazurio's domains refuses the network whole.
      const outside = yield* TailnetDirectory.fromText(
        textOf([{ ...shared, domains: ["first-org.lazurio.io", "example.com"] }]),
        "Desktop-1",
      );
      assert.deepStrictEqual(outside.tailnets, []);
    }),
  );
});

describe("NetworkDirectory.restartWhenIdle", () => {
  it.effect("starts the app again only once no agent works or may work", () =>
    Effect.gen(function* () {
      // An agent at work, then one whose work was not confirmed ended, then none.
      const agents: Array<DeviceStatus["agent"]> = [
        { environmentId: "env-1", label: "Prostředí" },
        "unknown",
        null,
      ];
      let agent: DeviceStatus["agent"] = agents[0] ?? null;
      let restarts = 0;
      const fiber = yield* Effect.forkChild(
        restartWhenIdle(
          () => agent !== null,
          Effect.sync(() => {
            restarts += 1;
          }),
          "5 seconds",
        ),
      );
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(restarts, 0);
      agent = agents[1] ?? null;
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(restarts, 0);
      agent = agents[2] ?? null;
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual(restarts, 1);
    }),
  );
});
