import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { Waiting } from "./Waiting.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Suspense>
        {/* The view in the remote page's place while its tailnet cannot reach it, without a bridge. */}
        {location.hash === "#waiting" ? <Waiting /> : <App status={window.lazurio.status()} />}
      </Suspense>
    </StrictMode>,
  );
}
