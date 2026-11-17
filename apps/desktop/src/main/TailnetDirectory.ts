import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { TailnetConfig } from "./Tailnet.ts";

// Which tailnets a packaged app joins (docs/adr/0008). The source is one interface: the proof of
// concept reads a directory built into the app; a list per Lazurio account replaces it later.
// Being listed grants nothing: the control server admits only members, through Lazurio Auth.

const DirectoryEntry = Schema.Struct({
  tailnet: Schema.String,
  controlUrl: Schema.String,
  domains: Schema.Array(Schema.String),
});
const decodeDirectory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DirectoryEntry)),
);

// The node's name an Owner sees when approving the Device: lazurio-app-<computer>.
export const nodeHostname = (computer: string): string => {
  const name = computer
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `lazurio-app-${name === "" ? "device" : name}`;
};

// The tailnets of the directory file, each with this computer's node name.
export const fromFile = Effect.fn("TailnetDirectory.fromFile")(function* (
  path: string,
  computer: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* decodeDirectory(yield* fileSystem.readFileString(path));
  const hostname = nodeHostname(computer);
  return entries.map((entry): TailnetConfig => ({
    tailnet: entry.tailnet,
    controlUrl: entry.controlUrl,
    hostname,
    domains: entry.domains,
  }));
});
