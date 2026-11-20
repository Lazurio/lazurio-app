// Which local page a view shows, by its address: the column, the agent's bar (?view=agent-bar),
// the Agent Desktop window (?view=agent-desktop) or the waiting page (#waiting). One bundle serves
// them all. ?view=agent-desktop-fixtures is the panel's sample states, which LocalScheme serves
// only to the end-to-end tests.
export type LocalView =
  | "column"
  | "agent-bar"
  | "agent-desktop"
  | "agent-desktop-fixtures"
  | "waiting";

export const viewOf = (search: string, hash: string): LocalView => {
  if (hash === "#waiting") return "waiting";
  const view = new URLSearchParams(search).get("view");
  return view === "agent-bar" || view === "agent-desktop" || view === "agent-desktop-fixtures"
    ? view
    : "column";
};
