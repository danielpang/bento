import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ToastHost } from "./components/Toasts.js";
import { startErrorTracking } from "./posthog.js";
import { ownBuild } from "./build-watch.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Fire and forget: exception autocapture should be on before the first
// screen paints, but a slow or missing PostHog key must not hold it.
void startErrorTracking();

// A lazy chunk that fails to load is almost always one the last deploy
// replaced, so reload once per build; a second failure means something
// else and reaches the ErrorBoundary as before. Without storage there
// is no way to stop a loop, so no reload either.
window.addEventListener("vite:preloadError", (event) => {
  const mark = ownBuild ?? "no-build";
  try {
    if (sessionStorage.getItem("bento:preload-reloaded") === mark) return;
    sessionStorage.setItem("bento:preload-reloaded", mark);
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

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
