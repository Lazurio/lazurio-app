// Which local page a view of the app shows, by its address: the main window's column, the bar
// that says an agent works (?view=agent-bar), the Agent Desktop window (?view=agent-desktop), or
// the waiting page in a remote page's place (#waiting). One bundle serves them all.
export type LocalView = "column" | "agent-bar" | "agent-desktop" | "waiting";

export const viewOf = (search: string, hash: string): LocalView => {
  if (hash === "#waiting") return "waiting";
  const view = new URLSearchParams(search).get("view");
  return view === "agent-bar" || view === "agent-desktop" ? view : "column";
};
