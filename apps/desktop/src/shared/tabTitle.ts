// A tab's name: the app and its place, from the address alone and never from the page's title
// (the window's prototype, #/lab/okno-gen4; decision 0248). Whose the Environment is comes later
// from its gateway; until then the place is the name the address gives.

// Which app a tab shows; the local windows put it in words (messages.ts).
export type TabApp =
  // Launchpad's Apps of an Environment, and its Settings.
  | "apps"
  | "settings"
  // The Environment's Chat (T3 Code) and Automations (Lazurio MausBot).
  | "chat"
  | "automations"
  // A module's app: its STAGING in an Environment, or its Application (PROD) on lazurio.app.
  | "module"
  // The Organization's overview, the Dashboard.
  | "overview"
  // Lazurio Auth, an Environment's own sign-in or GitHub's sign-in pages.
  | "sign-in"
  // A tab before its first page.
  | "new"
  // Any other page of Lazurio.
  | "lazurio";

export interface TabTitle {
  readonly app: TabApp;
  // The module's name in its address, for a module's app.
  readonly module?: string;
  // The Environment, or the Organization of an Application.
  readonly place?: string;
}
