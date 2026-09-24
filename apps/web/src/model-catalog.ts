import { useSyncExternalStore } from "react";
import { applyLiveCatalog, modelCatalogVersion, subscribeModelCatalog } from "@bento/core";
import type { BentoClient } from "@bento/api-client";

let loading: Promise<void> | null = null;

/**
 * Fetches the server's catalog once per page load and lays it over the
 * bundled snapshot, so the pickers offer models released after this
 * build was cut. A failure keeps the snapshot, which is what the
 * console showed before the server refreshed anything.
 */
export function loadLiveModels(client: Pick<BentoClient, "modelCatalog">): Promise<void> {
  loading ??= client
    .modelCatalog()
    .then((served) => applyLiveCatalog(served))
    .catch(() => {});
  return loading;
}

/**
 * Re-renders the caller when the live catalog lands. Components that
 * read providersForCli, checkAgentPairing, or providerForProfile during
 * render call this so a model the snapshot lacked appears without a
 * reload.
 */
export function useModelCatalog(): number {
  return useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
}
