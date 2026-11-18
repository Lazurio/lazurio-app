import { localeOf, messages } from "./messages.ts";

// What the window shows in the remote page's place while a tailnet's page cannot be reached yet
// (MainWindow.ts, waitForReachable). It needs no bridge: it only explains and waits.
export function Waiting() {
  const text = messages[localeOf(navigator.language)].waiting;
  return (
    <main className="waiting">
      <h1>{text.title}</h1>
      <p>{text.lead}</p>
    </main>
  );
}
