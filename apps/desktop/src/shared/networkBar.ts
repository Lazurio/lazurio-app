import type { AppStatus } from "./bridge.ts";

// What the main window says while the Organization's network is missing (AgentBar.tsx, and the
// "network" page in a page's place): sign in with the Lazurio account, which brings the person's
// networks (NetworkDirectory), sign in again, the read under way or failed, or an account whose
// list names no network; "help" where the account plays no part (IT's policy or a setting).
export type NetworkBarStep =
  | "sign-in"
  | "sign-in-again"
  | "reading"
  | "not-read"
  | "empty"
  | "help";

// The account and the latest read come first: an empty list saved earlier says "no network" only
// while the account is signed in and its latest read did not fail.
export const networkBarStep = (
  status: Pick<AppStatus, "tailnetSource" | "account" | "networksNotRead">,
): NetworkBarStep => {
  if (status.tailnetSource !== "built-in" && status.tailnetSource !== "lazurio-auth") {
    return "help";
  }
  switch (status.account) {
    case "signed-out":
      return "sign-in";
    case "needs-sign-in":
      return "sign-in-again";
    case "signed-in":
      if (status.networksNotRead) return "not-read";
      return status.tailnetSource === "lazurio-auth" ? "empty" : "reading";
  }
};

// The steps where a sign-in is what the person does next: an empty list offers it to read again
// once the Admin added the person.
export const offersSignIn = (step: NetworkBarStep): boolean =>
  step === "sign-in" || step === "sign-in-again" || step === "not-read" || step === "empty";
