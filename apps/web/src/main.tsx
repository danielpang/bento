import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ToastHost } from "./components/Toasts.js";
import { startErrorTracking } from "./posthog.js";
import { buildWatch, PRELOAD_RELOAD_KEY, preloadErrorAction } from "./build-watch.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Fire and forget: exception autocapture should be on before the first
// screen paints, but a slow or missing PostHog key must not hold it.
void startErrorTracking();

/**
 * A lazy chunk that failed to load is, nearly always, a chunk the last
 * deploy replaced: this page names files the server no longer has.
 * A reload fetches a shell that names the current ones, so the first
 * failure reloads instead of blanking the console with "Something
 * went wrong". Once per build, remembered for the tab: a page that
 * still cannot load its chunks after reloading has a different
 * problem, and that one goes to the ErrorBoundary as before.
 */
window.addEventListener("vite:preloadError", (event) => {
  let reloadedFor: string | null = null;
  try {
    reloadedFor = sessionStorage.getItem(PRELOAD_RELOAD_KEY);
  } catch {}
  const action = preloadErrorAction(buildWatch.snapshot().own, reloadedFor);
  if (!action.reload) return;
  try {
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, action.mark);
  } catch {}
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
