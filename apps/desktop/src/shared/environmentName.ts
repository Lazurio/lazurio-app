// An Environment's name for people: its own and its Organization's from its Lazurio (shell.json,
// main/ShellNames.ts) when read, else from its origin `https://launchpad.<environment>.<org>
// .lazurio.io`, without the Organization's repeated prefix ("lazurio-bob" of
// "lazurioexampleorganization" is "Bob"), hyphens as spaces, capitalised. Else its host.

const capitalised = (label: string): string => {
  const words = label.replaceAll("-", " ").trim();
  return words === "" ? label : words.charAt(0).toUpperCase() + words.slice(1);
};

// The Environment's label without a leading part that the Organization's label starts with.
const withoutPrefix = (environment: string, organization: string): string => {
  const parts = environment.split("-");
  for (let cut = parts.length - 1; cut >= 1; cut -= 1) {
    const prefix = parts.slice(0, cut).join("-");
    if (organization.startsWith(prefix.replaceAll("-", ""))) return parts.slice(cut).join("-");
  }
  return environment;
};

export interface EnvironmentName {
  readonly name: string;
  readonly organization: string | null;
}

export const environmentName = (origin: string): EnvironmentName => {
  const host = URL.parse(origin)?.hostname ?? origin;
  const labels = host.split(".");
  if (labels[0] !== "launchpad" || !host.endsWith(".lazurio.io")) {
    return { name: host, organization: null };
  }
  const inner = labels.slice(1, -2);
  const [environment, organization] = inner;
  if (environment === undefined) return { name: host, organization: null };
  if (organization === undefined || inner.length > 2) {
    return { name: capitalised(environment), organization: null };
  }
  return {
    name: capitalised(withoutPrefix(environment, organization)),
    organization: capitalised(organization),
  };
};

// The names an Environment's Lazurio gave, kept with the Environment; either may be missing.
export interface EnvironmentNames {
  readonly name?: string;
  readonly organization?: string;
}

// Whether a name only repeats the address: the host or one of its labels ("lazurio-bob",
// "lazurioexampleorganization"), whatever the case, hyphens or spaces. A Lazurio that does not know
// the Environment's names gives such a stand-in, which is no better than the name from the
// address.
const comparable = (text: string): string => text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");
const repeatsAddress = (origin: string, text: string): boolean => {
  const host = URL.parse(origin)?.hostname ?? origin;
  const candidate = comparable(text);
  return [host, ...host.split(".")].some((label) => comparable(label) === candidate);
};

// The names worth keeping from a read: each that does not only repeat the address, else the one
// kept before, so a stand-in never replaces a real name.
export const keptNames = (
  origin: string,
  read: EnvironmentNames,
  before: EnvironmentNames,
): EnvironmentNames => {
  const pick = (fresh: string | undefined, old: string | undefined) =>
    fresh !== undefined && !repeatsAddress(origin, fresh) ? fresh : old;
  const name = pick(read.name, before.name);
  const organization = pick(read.organization, before.organization);
  return {
    ...(name === undefined ? {} : { name }),
    ...(organization === undefined ? {} : { organization }),
  };
};

// The Environment's own names where it gave them, else each from its address.
export const namedEnvironment = (origin: string, names: EnvironmentNames): EnvironmentName => {
  const fallback = environmentName(origin);
  const own = keptNames(origin, names, {});
  return {
    name: own.name ?? fallback.name,
    organization: own.organization ?? fallback.organization,
  };
};
