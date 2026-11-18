import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { AgentBar } from "./AgentBar.tsx";
import { AgentDesktopWindow } from "./AgentDesktopWindow.tsx";
import { App } from "./App.tsx";
import { viewOf } from "./view.ts";
import { Waiting } from "./Waiting.tsx";
import "./styles.css";

// One bundle for every local view; its address picks the page (view.ts).
function LocalPage() {
  switch (viewOf(location.search, location.hash)) {
    // In the remote page's place while its tailnet cannot reach it, without a bridge.
    case "waiting":
      return <Waiting />;
    case "agent-bar":
      return <AgentBar />;
    case "agent-desktop":
      return <AgentDesktopWindow />;
    case "column":
      return <App status={window.lazurio.status()} />;
  }
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Suspense>
        <LocalPage />
      </Suspense>
    </StrictMode>,
  );
}
