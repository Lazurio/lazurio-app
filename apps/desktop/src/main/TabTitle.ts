import type { TabApp, TabTitle } from "../shared/tabTitle.ts";
import { isSignInHost } from "./Navigation.ts";

// A tab's name from its address alone (shared/tabTitle.ts says what it holds).

// The names of an Environment's own services (its handover's entry), below
// `<environment>.<organization>.lazurio.io`. A Map, so a module named like a property of every
// object (`constructor`, `toString`) is a module (review of #96).
const SERVICES: ReadonlyMap<string, TabApp> = new Map([
  ["launchpad", "apps"],
  ["t3code", "chat"],
  ["mausbot", "automations"],
]);

export const tabTitleOf = (address: string): TabTitle => {
  const url = URL.parse(address);
  if (url === null || url.protocol === "about:") return { app: "new" };
  if (url.protocol !== "https:") return { app: "lazurio" };
  const name = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (isSignInHost(name)) return { app: "sign-in" };
  if (name === "dashboard.lazurio.ai") return { app: "overview" };
  const labels = name.split(".");
  const [first = "", second = ""] = labels;
  // <module>.<organization>.lazurio.app: an Application (decision 0239).
  if (name.endsWith(".lazurio.app") && labels.length === 4) {
    return { app: "module", module: first, place: second };
  }
  if (!name.endsWith(".lazurio.io")) return { app: "lazurio" };
  // <environment>.<organization>.lazurio.io: the Environment's own sign-in (its /oauth2/…).
  if (labels.length === 4) return { app: "sign-in", place: first };
  // <service or module>.<environment>.<organization>.lazurio.io.
  if (labels.length === 5) {
    const known = SERVICES.get(first);
    if (known === "apps" && /^\/settings(?:\/|$)/u.test(url.pathname)) {
      return { app: "settings", place: second };
    }
    if (known !== undefined) return { app: known, place: second };
    return { app: "module", module: first, place: second };
  }
  return { app: "lazurio" };
};
