import { localeOf, messages } from "./messages.ts";

// What the window shows in the remote page's place while a tailnet's page cannot be reached yet
// (MainWindow.ts, waitForReachable): it explains, waits and opens the app's status.
export function Waiting() {
  const text = messages[localeOf(navigator.language)].waiting;
  return (
    <main className="waiting">
      <h1>{text.title}</h1>
      <p>{text.lead}</p>
      <button
        type="button"
        data-action="waiting-show-status"
        onClick={() => void window.lazurio.setStatusPanel(true)}
      >
        {text.showStatus}
      </button>
    </main>
  );
}
