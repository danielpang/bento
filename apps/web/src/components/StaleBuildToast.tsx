import { buildWatch, useBuildWatch } from "../build-watch.js";

/**
 * The console has been deployed since this page loaded.
 *
 * Rendered inside the toast stack, bottom left with the other
 * messages, but outside their list: it has no lifetime, because it has
 * to outlast a glance, and it does not count against the four at a
 * time. A button rather than an automatic reload: the composer and the
 * YAML editors hold unsaved text, and only the person knows whether
 * losing it is fine right now. The close control is "Later": it puts
 * the prompt away until the next deploy, and the preload safety net in
 * main.tsx covers whoever put it away and then opened a panel whose
 * chunk is gone.
 */
export function StaleBuildToast() {
  const { prompt } = useBuildWatch();
  if (!prompt) return null;
  return (
    <div className="toast stale-build" data-tone="update">
      <span className="toast-text">A new version of Bento is available. Reload to keep the console working.</span>
      <button className="btn btn-primary toast-action" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button className="toast-close" onClick={() => buildWatch.dismiss()} aria-label="Later" title="Later">
        ×
      </button>
    </div>
  );
}
