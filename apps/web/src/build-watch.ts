import { useSyncExternalStore } from "react";
import { BUILD_META } from "@bento/core";

/**
 * Whether the server has deployed a console build other than this page's.
 * The page carries its build in `<meta name="bento-build">`; the
 * api-client reports the build each response names to `note`. A dev
 * page carries none and never prompts.
 */
export interface BuildWatch {
  note(build: string): void;
  /** Hide the prompt for the build on offer; a newer one brings it back. */
  dismiss(): void;
  snapshot(): { prompt: boolean };
  subscribe(listener: () => void): () => void;
}

export function createBuildWatch(own: string | null): BuildWatch {
  // The newest build seen that is not this page's. Sticky: an old
  // machine answering with the page's own build mid deploy does not
  // clear it, only a reload does.
  let offered: string | null = null;
  let dismissed: string | null = null;
  const listeners = new Set<() => void>();
  let current = { prompt: false };

  const publish = () => {
    const prompt = offered !== null && dismissed !== offered;
    if (prompt === current.prompt) return;
    current = { prompt }; // a new object: useSyncExternalStore compares by identity
    for (const listener of listeners) listener();
  };

  return {
    note(build) {
      if (!own || build === own || build === offered) return;
      offered = build;
      publish();
    },
    dismiss() {
      dismissed = offered;
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

export const ownBuild: string | null =
  typeof document === "undefined"
    ? null
    : document.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute("content")?.trim() || null;

export const buildWatch = createBuildWatch(ownBuild);

export function useBuildWatch(): { prompt: boolean } {
  return useSyncExternalStore(buildWatch.subscribe, buildWatch.snapshot, buildWatch.snapshot);
}
