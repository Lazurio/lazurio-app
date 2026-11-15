import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { STATE_KEY_SIZE, stateKey, type Keystore } from "./NodeKeys.ts";

// A keystore that seals by a marked prefix, so a test sees what reaches the disk.
const PREFIX = new TextEncoder().encode("sealed:");
const fakeKeystore = (overrides: Partial<Keystore> = {}): Keystore => ({
  available: () => true,
  backend: () => undefined,
  seal: (text) => new Uint8Array([...PREFIX, ...new TextEncoder().encode(text)]),
  open: (sealed) => {
    if (!PREFIX.every((byte, index) => sealed[index] === byte)) throw new Error("not sealed here");
    return new TextDecoder().decode(sealed.slice(PREFIX.length));
  },
  ...overrides,
});

const inTempDirectory = <A, E>(
  run: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    return yield* run(directory);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("stateKey", () => {
  it.effect("makes a key once, keeps it only sealed, and gives the same key back", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const path = (yield* Path.Path).join(directory, "example.key");
        const options = { keystore: fakeKeystore(), path, allowWithoutKeystore: false };
        const first = yield* stateKey(options);
        assert.strictEqual(first.length, STATE_KEY_SIZE);
        const onDisk = yield* (yield* FileSystem.FileSystem).readFile(path);
        assert.isTrue(PREFIX.every((byte, index) => onDisk[index] === byte));
        const again = yield* stateKey(options);
        assert.deepStrictEqual([...again], [...first]);
      }),
    ),
  );

  it.effect("makes a different key for each tailnet", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const one = yield* stateKey({
          keystore: fakeKeystore(),
          path: path.join(directory, "one.key"),
          allowWithoutKeystore: false,
        });
        const two = yield* stateKey({
          keystore: fakeKeystore(),
          path: path.join(directory, "two.key"),
          allowWithoutKeystore: false,
        });
        assert.notDeepEqual([...one], [...two]);
      }),
    ),
  );

  it.effect("starts no node without the system's keystore", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const path = (yield* Path.Path).join(directory, "example.key");
        const exit = yield* Effect.exit(
          stateKey({
            keystore: fakeKeystore({ available: () => false }),
            path,
            allowWithoutKeystore: true,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(path));
      }),
    ),
  );

  it.effect("takes Linux's basic_text for no keystore, except in a development build", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const basicText = fakeKeystore({ backend: () => "basic_text" });
        const released = yield* Effect.exit(
          stateKey({
            keystore: basicText,
            path: path.join(directory, "released.key"),
            allowWithoutKeystore: false,
          }),
        );
        assert.isTrue(Exit.isFailure(released));
        const development = yield* stateKey({
          keystore: basicText,
          path: path.join(directory, "dev.key"),
          allowWithoutKeystore: true,
        });
        assert.strictEqual(development.length, STATE_KEY_SIZE);
        const gnome = yield* stateKey({
          keystore: fakeKeystore({ backend: () => "gnome_libsecret" }),
          path: path.join(directory, "gnome.key"),
          allowWithoutKeystore: false,
        });
        assert.strictEqual(gnome.length, STATE_KEY_SIZE);
      }),
    ),
  );

  it.effect("refuses a sealed key the keystore cannot open or of the wrong size", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const foreign = path.join(directory, "foreign.key");
        yield* fileSystem.writeFile(
          foreign,
          new TextEncoder().encode("not sealed by this keystore"),
        );
        const unopened = yield* Effect.exit(
          stateKey({ keystore: fakeKeystore(), path: foreign, allowWithoutKeystore: false }),
        );
        assert.isTrue(Exit.isFailure(unopened));

        const short = path.join(directory, "short.key");
        yield* fileSystem.writeFile(short, fakeKeystore().seal(btoa("sixteen bytes!!!")));
        const shortExit = yield* Effect.exit(
          stateKey({ keystore: fakeKeystore(), path: short, allowWithoutKeystore: false }),
        );
        assert.isTrue(Exit.isFailure(shortExit));
      }),
    ),
  );

  it.effect("names why a key failed: no keystore, or a key that does not open", () =>
    inTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const none = yield* Effect.flip(
          stateKey({
            keystore: fakeKeystore({ available: () => false }),
            path: path.join(directory, "none.key"),
            allowWithoutKeystore: true,
          }),
        );
        assert.strictEqual(none.reason, "no-keystore");
        const basicText = yield* Effect.flip(
          stateKey({
            keystore: fakeKeystore({ backend: () => "basic_text" }),
            path: path.join(directory, "basic.key"),
            allowWithoutKeystore: false,
          }),
        );
        assert.strictEqual(basicText.reason, "no-keystore");
        const foreign = path.join(directory, "foreign.key");
        yield* fileSystem.writeFile(
          foreign,
          new TextEncoder().encode("not sealed by this keystore"),
        );
        const unopened = yield* Effect.flip(
          stateKey({ keystore: fakeKeystore(), path: foreign, allowWithoutKeystore: false }),
        );
        assert.strictEqual(unopened.reason, "key-unreadable");
        const unsealed = yield* Effect.flip(
          stateKey({
            keystore: fakeKeystore({
              seal: () => {
                throw new Error("the keystore refuses");
              },
            }),
            path: path.join(directory, "unsealed.key"),
            allowWithoutKeystore: false,
          }),
        );
        assert.strictEqual(unsealed.reason, "key-not-saved");
      }),
    ),
  );
});
