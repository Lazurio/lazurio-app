import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import type { AppStatus } from "../shared/bridge.ts";

import { AgentBar } from "./AgentBar.tsx";
import { AgentDesktopFixtures } from "./AgentDesktopFixtures.tsx";
import { AgentDesktopWindow } from "./AgentDesktopWindow.tsx";
import { App } from "./App.tsx";
import { TabStrip } from "./TabStrip.tsx";
import { viewOf } from "./view.ts";
import { Waiting } from "./Waiting.tsx";
import "./styles.css";

// The column's first status, asked once. A promise made in render is new at each render, so `use`
// suspended on each one again: the column asked 17 times before it showed on Linux, and took
// more than 3 s on a Windows runner.
let firstStatus: Promise<AppStatus> | undefined;

// One bundle for every local view; its address picks the page (view.ts).
function LocalPage() {
  switch (viewOf(location.search, location.hash)) {
    // In the remote page's place while it cannot show: waiting for its tailnet, or why it failed.
    case "waiting":
      return <Waiting />;
    case "agent-bar":
      return <AgentBar />;
    case "agent-desktop":
      return <AgentDesktopWindow />;
    case "agent-desktop-fixtures":
      return <AgentDesktopFixtures />;
    case "tabs":
      return <TabStrip />;
    case "column":
      firstStatus ??= window.lazurio.status();
      return <App status={firstStatus} />;
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
