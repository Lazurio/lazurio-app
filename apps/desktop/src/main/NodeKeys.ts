import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

// Each tailnet node's state key (ADR 0003): 32 random bytes with which the tailnet helper seals
// the node's state, its machine and node keys among it. The app keeps the key only sealed by the
// system's keystore, in one file per tailnet, and gives it to the helper when the node starts.

export const STATE_KEY_SIZE = 32;

// The system's keystore as Electron's safeStorage offers it: the Keychain on macOS, DPAPI on
// Windows, the Secret Service or KWallet on Linux.
export interface Keystore {
  readonly available: () => boolean;
  // Linux names the backend it uses; a backend without a keystore seals with a fixed password.
  readonly backend: () => string | undefined;
  readonly seal: (text: string) => Uint8Array;
  readonly open: (sealed: Uint8Array) => string;
}

// Linux backends that are no keystore: "basic_text" seals with a password built into Chromium.
const NO_KEYSTORE: ReadonlySet<string> = new Set(["basic_text", "unknown"]);

export class NodeKeyError extends Schema.TaggedError<NodeKeyError>()("NodeKeyError", {
  // no-keystore: no keystore to seal with; key-unreadable: the sealed key does not open or cannot
  // be read; key-not-saved: a new key could not be sealed or written.
  reason: Schema.Literals(["no-keystore", "key-unreadable", "key-not-saved"]),
  problem: Schema.String,
}) {
  override get message(): string {
    return `node key: ${this.problem}`;
  }
}

export interface StateKeyOptions {
  readonly keystore: Keystore;
  // Where the sealed key lives, next to the node's state directory.
  readonly path: string;
  // Development builds only: Linux without a keystore keeps working, with a warning.
  readonly allowWithoutKeystore: boolean;
}

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// The node's state key: the one sealed at the path, or a new one, sealed and written there.
export const stateKey = Effect.fn("NodeKeys.stateKey")(function* (options: StateKeyOptions) {
  const failure = (reason: NodeKeyError["reason"], problem: string) =>
    new NodeKeyError({ reason, problem });
  if (!options.keystore.available()) {
    return yield* failure(
      "no-keystore",
      "the system's keystore is not available, so no tailnet node starts",
    );
  }
  const backend = options.keystore.backend();
  if (backend !== undefined && NO_KEYSTORE.has(backend)) {
    if (!options.allowWithoutKeystore) {
      return yield* failure(
        "no-keystore",
        `Linux offers no keystore here (${backend}), so no tailnet node starts`,
      );
    }
    yield* Effect.logWarning(
      `tailnet node keys: no keystore (${backend}); a development build seals them with Chromium's fixed password`,
    );
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem
    .exists(options.path)
    .pipe(Effect.mapError(() => failure("key-unreadable", "its sealed key cannot be read")));
  if (exists) {
    const sealed = yield* fileSystem
      .readFile(options.path)
      .pipe(Effect.mapError(() => failure("key-unreadable", "its sealed key cannot be read")));
    const key = yield* Effect.try({
      try: () => fromBase64(options.keystore.open(sealed)),
      catch: () => failure("key-unreadable", "the keystore does not open its sealed key"),
    });
    if (key.length !== STATE_KEY_SIZE) {
      return yield* failure("key-unreadable", "its sealed key has the wrong size");
    }
    return key;
  }

  const key = crypto.getRandomValues(new Uint8Array(STATE_KEY_SIZE));
  const sealed = yield* Effect.try({
    try: () => options.keystore.seal(toBase64(key)),
    catch: () => failure("key-not-saved", "the keystore does not seal a new key"),
  });
  yield* fileSystem
    .writeFile(options.path, sealed, { flag: "wx", mode: 0o600 })
    .pipe(Effect.mapError(() => failure("key-not-saved", "its sealed key cannot be written")));
  return key;
});
