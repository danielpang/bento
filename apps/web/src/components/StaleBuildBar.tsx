import { buildWatch, useBuildWatch } from "../build-watch.js";

/**
 * The console has been deployed since this page loaded.
 *
 * A bar under the topbar rather than a toast: a toast leaves in six
 * seconds and this has to outlast a glance. A button rather than an
 * automatic reload: the composer and the YAML editors hold unsaved
 * text, and only the person knows whether losing it is fine right
 * now. Later puts the prompt away until the next deploy; the preload
 * safety net in main.tsx covers whoever put it away and then opened a
 * panel whose chunk is gone.
 */
export function StaleBuildBar() {
  const { prompt } = useBuildWatch();
  if (!prompt) return null;
  return (
    <div className="setup-prompt stale-build" role="status">
      <span>A new version of Bento is available. Reload to keep the console working.</span>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button className="btn btn-ghost" onClick={() => buildWatch.dismiss()}>
        Later
      </button>
    </div>
  );
}
