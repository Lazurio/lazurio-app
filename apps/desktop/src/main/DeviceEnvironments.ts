import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { EnvironmentNames } from "../shared/environmentName.ts";
import { environmentOriginOf } from "./Navigation.ts";
import { nameText } from "./ShellNames.ts";

// The Environments the person added to Agent Desktop, by the origin of their Lazurio with the names
// it gave (ShellNames.ts), in `<userData>/agent-desktop-environments.json`: no secret, no switch
// (every switch is off after each start, docs/adr/0006). Version 1 had origins alone; it reads as
// version 2 without names, and the next change writes version 2.

class DeviceEnvironmentsError extends Schema.TaggedError<DeviceEnvironmentsError>()(
  "DeviceEnvironmentsError",
  { path: Schema.String },
) {
  override get message(): string {
    return `the list of Agent Desktop's Environments could not be saved to ${this.path}`;
  }
}

const FileV1 = Schema.Struct({
  version: Schema.Literal(1),
  origins: Schema.Array(Schema.String),
});
const FileV2 = Schema.Struct({
  version: Schema.Literal(2),
  environments: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      name: Schema.optional(Schema.String),
      organization: Schema.optional(Schema.String),
    }),
  ),
});
const decodeFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([FileV1, FileV2])),
);

export interface DeviceEnvironment extends EnvironmentNames {
  readonly origin: string;
}

// An Environment as a file lists it, before its names are checked.
interface Listed {
  readonly origin: string;
  readonly name?: string | undefined;
  readonly organization?: string | undefined;
}

// Only the names that are still names for people.
const withNames = ({ origin, ...names }: Listed): DeviceEnvironment => {
  const name = nameText(names.name);
  const organization = nameText(names.organization);
  return {
    origin,
    ...(name === undefined ? {} : { name }),
    ...(organization === undefined ? {} : { organization }),
  };
};

// The Environments a file names, each origin once, and only those that still are an Environment's
// origin.
export const environmentsFrom = (text: Option.Option<string>): ReadonlyArray<DeviceEnvironment> => {
  const listed = Option.match(Option.flatMap(text, decodeFile), {
    onNone: () => [],
    onSome: (file): ReadonlyArray<Listed> =>
      file.version === 1 ? file.origins.map((origin) => ({ origin })) : file.environments,
  });
  const seen = new Set<string>();
  return listed.flatMap((environment) => {
    const { origin } = environment;
    if (seen.has(origin) || environmentOriginOf(origin) !== origin) return [];
    seen.add(origin);
    return [withNames(environment)];
  });
};

const encodeEnvironments = (environments: ReadonlyArray<DeviceEnvironment>): string =>
  `${JSON.stringify({ version: 2, environments }, null, 2)}\n`;

export interface DeviceEnvironments {
  readonly origins: () => ReadonlyArray<string>;
  // The names kept with a listed Environment; none for another.
  readonly names: (origin: string) => EnvironmentNames;
  // Adds the origin at the end; an origin already there stays where it is.
  readonly add: (origin: string) => Effect.Effect<void, DeviceEnvironmentsError>;
  readonly remove: (origin: string) => Effect.Effect<void, DeviceEnvironmentsError>;
  // Keeps the names with a listed Environment, replacing those before; nothing for another.
  readonly setNames: (
    origin: string,
    names: EnvironmentNames,
  ) => Effect.Effect<void, DeviceEnvironmentsError>;
}

export const open = Effect.fn("DeviceEnvironments.open")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let listed = environmentsFrom(yield* fileSystem.readFileString(path).pipe(Effect.option));
  // One change at a time, computed from the list at its turn; each replaces the file whole, so a
  // crash leaves the old or the new list. A change that gives undefined writes nothing.
  const writing = yield* Semaphore.make(1);
  const change = (
    next: (
      current: ReadonlyArray<DeviceEnvironment>,
    ) => ReadonlyArray<DeviceEnvironment> | undefined,
  ) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const changed = next(listed);
        if (changed === undefined) return;
        const text = encodeEnvironments(changed);
        const temporary = `${path}.new`;
        yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true });
        yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
        yield* fileSystem.rename(temporary, path);
        listed = changed;
      }).pipe(Effect.mapError(() => new DeviceEnvironmentsError({ path }))),
    );
  const isListed = (current: ReadonlyArray<DeviceEnvironment>, origin: string) =>
    current.some((each) => each.origin === origin);
  const environments: DeviceEnvironments = {
    origins: () => listed.map((environment) => environment.origin),
    names: (origin) => {
      const { name, organization } = listed.find((each) => each.origin === origin) ?? { origin };
      return {
        ...(name === undefined ? {} : { name }),
        ...(organization === undefined ? {} : { organization }),
      };
    },
    add: (origin) =>
      change((current) => (isListed(current, origin) ? undefined : [...current, { origin }])),
    remove: (origin) =>
      change((current) =>
        isListed(current, origin) ? current.filter((each) => each.origin !== origin) : undefined,
      ),
    setNames: (origin, names) =>
      change((current) => {
        const next = withNames({ ...names, origin });
        const known = current.find((each) => each.origin === origin);
        if (known === undefined) return undefined;
        if (known.name === next.name && known.organization === next.organization) return undefined;
        return current.map((each) => (each.origin === origin ? next : each));
      }),
  };
  return environments;
});
