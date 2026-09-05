import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ToastHost } from "./components/Toasts.js";
import { startErrorTracking } from "./posthog.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Fire and forget: exception autocapture should be on before the first
// screen paints, but a slow or missing PostHog key must not hold it.
void startErrorTracking();

createRoot(root).render(
  <StrictMode>
    {/* One host for the whole app: every panel reports failures the
        same way, and none of them rearranges the page to do it. */}
    <ErrorBoundary>
      <ToastHost>
        <App />
      </ToastHost>
    </ErrorBoundary>
  </StrictMode>,
);
