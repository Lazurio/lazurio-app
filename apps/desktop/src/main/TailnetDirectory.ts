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

// An ASCII DNS name of letters, digits and hyphens: the PAC script carries it as it is, and Chromium
// takes the script only as base64, which has no other characters. An international name comes as
// its xn-- form.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const isDnsName = (name: string): boolean =>
  name.length <= 253 && name.split(".").every((label) => LABEL.test(label));

const belowLazurio = (name: string): boolean => {
  const normalized = normalize(name);
  return (
    isDnsName(normalized) && LAZURIO_DOMAINS.some((domain) => normalized.endsWith(`.${domain}`))
  );
};

// A tailnet's name names its key and state files (Tailnet.run), so it is one plain path component
// and none of the device names Windows reserves, with or without an extension.
const TAILNET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u;

// Why an entry is refused, or undefined when the app may join its tailnet.
export const refusalOf = (entry: DirectoryEntry): string | undefined => {
  if (!TAILNET_NAME.test(entry.tailnet)) {
    return "its name is not lower-case letters, digits and hyphens";
  }
  if (WINDOWS_RESERVED.test(entry.tailnet)) return "its name is a device name Windows reserves";
  const control = URL.parse(entry.controlUrl);
  if (control === null || control.protocol !== "https:") {
    return "its control server is no https:// address";
  }
  if (control.username !== "" || control.password !== "" || control.port !== "") {
    return "its control server carries credentials or a port";
  }
  if (!belowLazurio(control.hostname)) {
    return `its control server ${control.hostname} is no name below Lazurio's domains`;
  }
  if (entry.domains.length === 0) return "it names no DNS suffix";
  const outside = entry.domains.find((domain) => !belowLazurio(domain));
  if (outside !== undefined) {
    return `its DNS suffix ${JSON.stringify(outside)} is no ASCII name below Lazurio's domains`;
  }
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
  const names = new Set<string>();
  for (const entry of entries) {
    const reason = names.has(entry.tailnet)
      ? "an earlier entry has the same name"
      : refusalOf(entry);
    if (reason === undefined) {
      names.add(entry.tailnet);
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

// Whether a packaged build may join the directory built into the app (Lazurio Example, Lazurio's
// own test network): a nightly may, for Lazurio's testers, and so may any build off Windows, which
// has no other source yet. A stable Windows build may not: a person at a customer whose network
// is not set yet is never sent to sign in to one that is not theirs (v0.1.0, 2026-11-19).
export const builtInAllowed = (appVersion: string, platform: string): boolean =>
  platform !== "win32" || /-nightly\./u.test(appVersion);

// Whether a packaged build tells the person that their Organization's network is not set up: a
// stable build with neither IT's policy nor the person's own setting. A Mac still joins the
// built-in Lazurio Example (builtInAllowed), but that is never a customer's own network.
export const networkMissing = (source: string, appVersion: string): boolean =>
  source === "built-in" && !/-nightly\./u.test(appVersion);

export const NO_TAILNETS: Directory = { tailnets: [], refused: [] };
