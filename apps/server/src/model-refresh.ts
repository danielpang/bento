import {
  GATEWAY_MODELS_URL,
  MODELS_DEV_URL,
  applyLiveCatalog,
  modelCatalog,
  parseGatewayModels,
  parseModelsDev,
  type CatalogProvider,
} from "@bento/core";

/**
 * Keeps this process's model catalog current.
 *
 * Reads models.dev and the AI Gateway once at boot and then every
 * `hours`, and lays what it finds over the committed snapshot. The
 * catalog route serves the result, so the console, the TUI, and the Mac
 * app pick up a new Claude or GPT model without anyone running
 * `pnpm models:update` and deploying.
 *
 * Not awaited at boot: a slow or unreachable models.dev must not hold
 * the server, and until the first read lands the snapshot is served,
 * which is what an offline board gets forever. A failed read keeps
 * whatever the last good one found.
 */
export function startModelRefresh(options: {
  hours: number;
  fetch?: typeof fetch;
  log?: Pick<Console, "log" | "warn">;
}): { refresh(): Promise<void>; stop(): void } {
  const log = options.log ?? console;
  let failing = false;

  async function refresh() {
    try {
      const before = countModels();
      const live = await fetchLiveCatalog(options.fetch ? { fetch: options.fetch } : {});
      applyLiveCatalog(live);
      const added = countModels() - before;
      if (failing || added > 0) log.log(`model catalog refreshed${added > 0 ? `: ${added} new models` : ""}`);
      failing = false;
    } catch (err) {
      // Once per outage, not once per interval.
      if (!failing) log.warn(`model catalog refresh failed, serving the last known list: ${messageOf(err)}`);
      failing = true;
    }
  }

  if (options.hours <= 0) return { refresh, stop() {} };

  void refresh();
  const timer = setInterval(() => void refresh(), options.hours * 60 * 60 * 1000);
  // A timer must not be what keeps a stopping process alive.
  timer.unref();
  return {
    refresh,
    stop() {
      clearInterval(timer);
    },
  };
}

function countModels(): number {
  return modelCatalog().reduce((sum, provider) => sum + provider.models.length, 0);
}

/**
 * Reads both sources. One failing does not sink the other: a Gateway
 * outage should not hold back a new Claude model. Throws only when both
 * fail, so the caller can say the catalog is stale.
 */
export async function fetchLiveCatalog(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogProvider[]> {
  const get = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const read = async (url: string) => {
    const res = await get(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const [modelsDev, gateway] = await Promise.allSettled([read(MODELS_DEV_URL), read(GATEWAY_MODELS_URL)]);
  if (modelsDev.status === "rejected" && gateway.status === "rejected") {
    throw new Error(`${messageOf(modelsDev.reason)}; ${messageOf(gateway.reason)}`);
  }
  return [
    ...(modelsDev.status === "fulfilled" ? parseModelsDev(modelsDev.value) : []),
    ...(gateway.status === "fulfilled" ? parseGatewayModels(gateway.value) : []),
  ];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
