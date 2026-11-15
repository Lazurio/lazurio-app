import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { run } from "./KeystoreCheck.ts";
import type { Keystore } from "./NodeKeys.ts";

const PREFIX = "sealed-by:";
// A keystore of one app identity: it opens only what the same identity sealed.
const keystoreOf = (identity: string): Keystore => ({
  available: () => true,
  backend: () => undefined,
  seal: (text) => new TextEncoder().encode(`${PREFIX}${identity}:${text}`),
  open: (sealed) => {
    const text = new TextDecoder().decode(sealed);
    const mark = `${PREFIX}${identity}:`;
    if (!text.startsWith(mark)) throw new Error("not sealed by this identity");
    return text.slice(mark.length);
  },
});

const inUserData = <A, E>(
  body: (userData: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const userData = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    return yield* body(userData);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readRecord = (userData: string) =>
  Effect.gen(function* () {
    const path = (yield* Path.Path).join(userData, "keystore-check.json");
    return JSON.parse(yield* (yield* FileSystem.FileSystem).readFileString(path)) as unknown;
  });

describe("KeystoreCheck", () => {
  it.effect("seals its key at the first start and opens it after an update", () =>
    inUserData((userData) =>
      Effect.gen(function* () {
        const options = {
          keystore: keystoreOf("io.lazurio.app"),
          userData,
          allowWithoutKeystore: false,
        };
        const first = yield* run({ ...options, appVersion: "0.0.1" });
        assert.deepStrictEqual(first, { version: "0.0.1", result: "created" });
        const next = yield* run({ ...options, appVersion: "0.0.2" });
        assert.deepStrictEqual(next, { version: "0.0.2", result: "opened" });
        assert.deepStrictEqual(yield* readRecord(userData), { version: "0.0.2", result: "opened" });
      }),
    ),
  );

  it.effect("reports a keystore that no longer opens what an earlier build sealed", () =>
    inUserData((userData) =>
      Effect.gen(function* () {
        yield* run({
          keystore: keystoreOf("io.lazurio.app"),
          userData,
          appVersion: "0.0.1",
          allowWithoutKeystore: false,
        });
        const next = yield* run({
          keystore: keystoreOf("another identity"),
          userData,
          appVersion: "0.0.2",
          allowWithoutKeystore: false,
        });
        assert.deepStrictEqual(next, { version: "0.0.2", result: "key-unreadable" });
      }),
    ),
  );

  it.effect("reports a missing keystore without sealing anything", () =>
    inUserData((userData) =>
      Effect.gen(function* () {
        const record = yield* run({
          keystore: { ...keystoreOf("io.lazurio.app"), available: () => false },
          userData,
          appVersion: "0.0.1",
          allowWithoutKeystore: false,
        });
        assert.deepStrictEqual(record, { version: "0.0.1", result: "no-keystore" });
      }),
    ),
  );
});
