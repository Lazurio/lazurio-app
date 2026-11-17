import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { environmentOriginOf } from "./Navigation.ts";

// The Environments the person added to Agent Desktop, each by the origin of its Lazurio
// (`https://<host>`), kept in `<userData>/agent-desktop-environments.json`. The file holds no secret
// and no switch: every switch is off after each start (docs/adr/0006, contract v3 in the app).

class DeviceEnvironmentsError extends Schema.TaggedError<DeviceEnvironmentsError>()(
  "DeviceEnvironmentsError",
  { path: Schema.String },
) {
  override get message(): string {
    return `the list of Agent Desktop's Environments could not be saved to ${this.path}`;
  }
}

const EnvironmentsFile = Schema.Struct({
  version: Schema.Literal(1),
  origins: Schema.Array(Schema.String),
});
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentsFile));

// The origins a file names, each once, and only those that still are an Environment's origin.
export const originsFrom = (text: Option.Option<string>): ReadonlyArray<string> => {
  const origins = Option.match(Option.flatMap(text, decodeFile), {
    onNone: () => [],
    onSome: (file) => file.origins,
  });
  return [...new Set(origins.filter((origin) => environmentOriginOf(origin) === origin))];
};

const encodeOrigins = (origins: ReadonlyArray<string>): string =>
  `${JSON.stringify({ version: 1, origins }, null, 2)}\n`;

export interface DeviceEnvironments {
  readonly origins: () => ReadonlyArray<string>;
  // Adds the origin at the end; an origin already there stays where it is.
  readonly add: (origin: string) => Effect.Effect<void, DeviceEnvironmentsError>;
  readonly remove: (origin: string) => Effect.Effect<void, DeviceEnvironmentsError>;
}

export const open = Effect.fn("DeviceEnvironments.open")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let origins = originsFrom(yield* fileSystem.readFileString(path).pipe(Effect.option));
  // One write at a time; each replaces the file whole, so a crash leaves the old or the new list.
  const writing = yield* Semaphore.make(1);
  const save = (next: ReadonlyArray<string>) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const text = encodeOrigins(next);
        const temporary = `${path}.new`;
        yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true });
        yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
        yield* fileSystem.rename(temporary, path);
        origins = next;
      }).pipe(Effect.mapError(() => new DeviceEnvironmentsError({ path }))),
    );
  const environments: DeviceEnvironments = {
    origins: () => origins,
    add: (origin) =>
      Effect.suspend(() => (origins.includes(origin) ? Effect.void : save([...origins, origin]))),
    remove: (origin) =>
      Effect.suspend(() =>
        origins.includes(origin) ? save(origins.filter((known) => known !== origin)) : Effect.void,
      ),
  };
  return environments;
});
