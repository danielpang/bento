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
 * `hours`, and puts what it finds in place of the committed snapshot's
 * lists, so new models appear and sunset ones drop out. The
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
  /**
   * The newest list each source gave, by provider. When models.dev is
   * down but the Gateway answers, Anthropic and OpenAI keep what the
   * last good read found rather than falling back to the snapshot.
   */
  const lastGood = new Map<string, CatalogProvider>();

  async function refresh() {
    try {
      const before = modelIds();
      const live = await fetchLiveCatalog(options.fetch ? { fetch: options.fetch } : {});
      for (const provider of live) lastGood.set(provider.id, provider);
      applyLiveCatalog([...lastGood.values()]);
      const after = modelIds();
      const added = [...after].filter((id) => !before.has(id)).length;
      const removed = [...before].filter((id) => !after.has(id)).length;
      if (failing || added > 0 || removed > 0) {
        log.log(`model catalog refreshed: ${added} added, ${removed} sunset`);
      }
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

function modelIds(): Set<string> {
  return new Set(modelCatalog().flatMap((provider) => provider.models.map((m) => `${provider.id}:${m.id}`)));
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
