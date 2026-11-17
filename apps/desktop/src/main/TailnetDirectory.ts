import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { TailnetConfig } from "./Tailnet.ts";

// Which tailnets a packaged app joins, from any source (docs/adr/0008). Being listed grants
// nothing, since the control server admits only members; whatever the source, the app takes only
// control servers and DNS suffixes below Lazurio's own domains (Matěj, 2026-11-17).

const DirectoryEntry = Schema.Struct({
  tailnet: Schema.String,
  controlUrl: Schema.String,
  domains: Schema.Array(Schema.String),
});
type DirectoryEntry = typeof DirectoryEntry.Type;
const decodeDirectory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DirectoryEntry)),
);

// Lazurio's own domains. A tailnet's names lie below one of them, never at the domain itself,
// which would send every Organization's names to one tailnet.
const LAZURIO_DOMAINS: ReadonlyArray<string> = ["lazurio.io", "lazurio.ai"];

const normalize = (name: string): string => name.toLowerCase().replace(/^\.+|\.+$/gu, "");

const belowLazurio = (name: string): boolean => {
  const normalized = normalize(name);
  return LAZURIO_DOMAINS.some((domain) => normalized.endsWith(`.${domain}`));
};

// Why an entry is refused, or undefined when the app may join its tailnet.
export const refusalOf = (entry: DirectoryEntry): string | undefined => {
  if (entry.tailnet.trim() === "") return "it has no name";
  const control = URL.parse(entry.controlUrl);
  if (control === null || control.protocol !== "https:") {
    return "its control server is no https:// address";
  }
  if (control.username !== "" || control.password !== "" || control.port !== "") {
    return "its control server carries credentials or a port";
  }
  if (!belowLazurio(control.hostname)) {
    return `its control server ${control.hostname} lies outside Lazurio's domains`;
  }
  if (entry.domains.length === 0) return "it names no DNS suffix";
  const outside = entry.domains.find((domain) => !belowLazurio(domain));
  if (outside !== undefined) return `its DNS suffix ${outside} lies outside Lazurio's domains`;
  return undefined;
};

export interface Directory {
  readonly tailnets: ReadonlyArray<TailnetConfig>;
  // The entries the app does not join, with the reason, for the log.
  readonly refused: ReadonlyArray<{ readonly tailnet: string; readonly reason: string }>;
}

// The node's name an Owner sees when approving the Device: lazurio-app-<computer>.
export const nodeHostname = (computer: string): string => {
  const name = computer
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `lazurio-app-${name === "" ? "device" : name}`;
};

// The tailnets of a directory's JSON text, each with this computer's node name.
export const fromText = Effect.fn("TailnetDirectory.fromText")(function* (
  text: string,
  computer: string,
) {
  const entries = yield* decodeDirectory(text);
  const hostname = nodeHostname(computer);
  const tailnets: Array<TailnetConfig> = [];
  const refused: Array<{ tailnet: string; reason: string }> = [];
  for (const entry of entries) {
    const reason = refusalOf(entry);
    if (reason === undefined) {
      tailnets.push({
        tailnet: entry.tailnet,
        controlUrl: entry.controlUrl,
        hostname,
        domains: entry.domains,
      });
    } else {
      refused.push({ tailnet: entry.tailnet, reason });
    }
  }
  return { tailnets, refused } satisfies Directory;
});

// The tailnets of a directory file.
export const fromFile = Effect.fn("TailnetDirectory.fromFile")(function* (
  path: string,
  computer: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fromText(yield* fileSystem.readFileString(path), computer);
});
