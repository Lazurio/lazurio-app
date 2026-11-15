import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { stateKey, type Keystore } from "./NodeKeys.ts";

// At every start the app seals a check key with the system's keystore once, and opens it on each
// later start, the way it keeps the tailnet nodes' keys (ADR 0003). The result goes to
// `<userData>/keystore-check.json`, so an update that loses the keystore's access shows at once
// and the update test proves the opposite (docs/adr/0005, points 6 and 9).

const KeystoreCheckRecord = Schema.Struct({
  version: Schema.String,
  result: Schema.Literals([
    "created",
    "opened",
    "no-keystore",
    "key-inaccessible",
    "key-unreadable",
    "key-not-saved",
  ]),
});
type KeystoreCheckResult = typeof KeystoreCheckRecord.Type.result;
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(KeystoreCheckRecord));

export const run = Effect.fn("KeystoreCheck.run")(function* (options: {
  readonly keystore: Keystore;
  readonly userData: string;
  readonly appVersion: string;
  readonly allowWithoutKeystore: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const keyPath = path.join(options.userData, "keystore-check.key");
  const existed = yield* fileSystem.exists(keyPath).pipe(Effect.orElseSucceed(() => false));
  const result: KeystoreCheckResult = yield* stateKey({
    keystore: options.keystore,
    path: keyPath,
    allowWithoutKeystore: options.allowWithoutKeystore,
  }).pipe(
    Effect.as<KeystoreCheckResult>(existed ? "opened" : "created"),
    Effect.catch((error) => Effect.succeed<KeystoreCheckResult>(error.reason)),
  );
  const record = { version: options.appVersion, result };
  yield* encodeRecord(record).pipe(
    Effect.flatMap((text) =>
      fileSystem.writeFileString(path.join(options.userData, "keystore-check.json"), `${text}\n`),
    ),
    Effect.ignore,
  );
  yield* Effect.logInfo("keystore check").pipe(Effect.annotateLogs({ ...record }));
  return record;
});
