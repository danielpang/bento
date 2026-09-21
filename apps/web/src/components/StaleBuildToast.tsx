import { buildWatch, useBuildWatch } from "../build-watch.js";
import { desktop } from "../desktop.js";

/**
 * The console has been deployed since this page loaded. Lives in the
 * toast stack but outside its list: no lifetime, not counted against
 * the cap. A button rather than an automatic reload, because editors
 * hold unsaved text. Close means Later; main.tsx's preload safety net
 * covers whoever put it away and then hit a missing chunk.
 */
export function StaleBuildToast() {
  const { prompt } = useBuildWatch();
  // Electron serves its bundled console. Reloading cannot pick up a web deploy;
  // the desktop updater provides the matching application update notification.
  if (desktop || !prompt) return null;
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
