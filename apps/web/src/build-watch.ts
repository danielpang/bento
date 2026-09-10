import { useSyncExternalStore } from "react";

/**
 * Whether this tab is running the console the server is serving.
 *
 * A tab left open across a deploy keeps the old bundle. Its next lazy
 * chunk is a file the new image no longer has, and its requests speak
 * to a server that may have moved on. The page carries the build it
 * came from (`<meta name="bento-build">`, stamped by the Vite build),
 * every API response carries the build the server serves, and the
 * api-client reports each new value here through `note`. The first
 * disagreement makes the tab stale, and it stays stale until a reload
 * replaces the page: a later response that happens to agree (an old
 * machine answering mid deploy) does not make the old bundle current
 * again.
 *
 * The dev server stamps no build, so a page with none never becomes
 * stale, and the bar stays out of local development.
 */
export const BUILD_META = "bento-build";

export function staleAfter(own: string | null, seen: string, wasStale: boolean): boolean {
  if (wasStale) return true;
  if (!own) return false;
  return seen !== own;
}

/**
 * What to do when a lazy chunk fails to load (Vite's vite:preloadError).
 *
 * A reload fetches a shell that names chunks the server has, so the
 * first failure reloads. The mark records which build the reload was
 * for; a second failure from that same build means the reload did not
 * help, and the error falls through to the ErrorBoundary rather than
 * looping. A page with no build still reloads once, keyed on that.
 */
export function preloadErrorAction(own: string | null, reloadedFor: string | null): { reload: boolean; mark: string } {
  const mark = own ?? "no-build";
  return { reload: reloadedFor !== mark, mark };
}

export const PRELOAD_RELOAD_KEY = "bento:preload-reloaded";

export interface BuildWatchSnapshot {
  /** The build this page loaded, or null when it carries none. */
  own: string | null;
  /** The newest build a server response named. */
  latest: string | null;
  /** The page is not the build being served. Never clears without a reload. */
  stale: boolean;
  /** Stale, and the person has not put this particular build off. */
  prompt: boolean;
}

export interface BuildWatch {
  note(build: string): void;
  /** Hide the prompt for the build currently on offer. A newer one brings it back. */
  dismiss(): void;
  snapshot(): BuildWatchSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createBuildWatch(own: string | null): BuildWatch {
  let latest: string | null = null;
  let stale = false;
  let dismissed: string | null = null;
  const listeners = new Set<() => void>();
  // Replaced, never mutated: useSyncExternalStore compares by identity.
  let current: BuildWatchSnapshot = { own, latest, stale, prompt: false };

  const publish = () => {
    // Stale is about this page; the prompt is about what is on offer.
    // Nothing to offer while the newest answer is this page's own
    // build (an old machine answering mid deploy), or one already
    // put off.
    const prompt = stale && latest !== null && latest !== own && dismissed !== latest;
    if (
      current.latest === latest
      && current.stale === stale
      && current.prompt === prompt
    ) return;
    current = { own, latest, stale, prompt };
    for (const listener of listeners) listener();
  };

  return {
    note(build) {
      latest = build;
      stale = staleAfter(own, build, stale);
      publish();
    },
    dismiss() {
      dismissed = latest;
      publish();
    },
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function readOwnBuild(doc: Pick<Document, "querySelector"> | undefined): string | null {
  const content = doc?.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute("content")?.trim();
  return content || null;
}

/** The page's one watch. Node tests import this module with no document. */
export const buildWatch = createBuildWatch(readOwnBuild(typeof document === "undefined" ? undefined : document));

export function useBuildWatch(): BuildWatchSnapshot {
  return useSyncExternalStore(buildWatch.subscribe, buildWatch.snapshot, buildWatch.snapshot);
}
