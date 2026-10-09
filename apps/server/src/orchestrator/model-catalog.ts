import { eq } from "drizzle-orm";
import { modelCatalogSnapshots } from "@bento/db";
import {
  CATALOG_INCLUDE,
  GATEWAY_MODELS_API,
  MODEL_CATALOG,
  MODELS_DEV_API,
  buildGatewayCatalog,
  buildModelsDevCatalog,
  catalogModelCount,
  committedCatalogSources,
  isCatalogProviderList,
  modelsDevLogoUrl,
  previewModelCatalog,
  publishModelCatalog,
  refuseFreshCatalog,
  type CatalogProvider,
  type GatewayModel,
  type ModelsDevProvider,
} from "@bento/core";
import type { AppContext } from "../context.js";
import { captureJobErrors } from "../analytics.js";
import { QUEUE_POLL_SECONDS } from "./queue.js";

/**
 * Daily refresh of the model list.
 *
 * The committed snapshots are what a process serves until a fetch has
 * succeeded, and what it keeps serving when models.dev or the Gateway
 * answers badly. One fetch per machine per day, stored in one row so a
 * restart does not have to wait for the next morning to catch up. The
 * console, the TUI, and the Mac app read the served list, so a model
 * that shipped yesterday is choosable without a deploy.
 */
export const MODEL_CATALOG_QUEUE = "model-catalog.refresh";

/** 06:17 UTC, after the morning's releases and before the workday. */
export const MODEL_CATALOG_CRON = "17 6 * * *";

type CatalogDb = Pick<AppContext, "db" | "analytics">;

async function readJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function fetchLogos(fetchImpl: typeof fetch, ids: readonly string[]): Promise<Record<string, string>> {
  const committed = new Map(committedCatalogSources().generated.map((provider) => [provider.id, provider.logo]));
  const logos: Record<string, string> = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetchImpl(modelsDevLogoUrl(id));
      if (!res.ok) {
        logos[id] = committed.get(id) ?? "";
        return;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      logos[id] = `data:image/svg+xml;base64,${bytes.toString("base64")}`;
    } catch {
      logos[id] = committed.get(id) ?? "";
    }
  }));
  return logos;
}

/**
 * Fetches both sources and returns the halves, or a reason the current
 * list should stay. A failure here is the provider's response, not a
 * bug, so the caller logs it and does not retry in a loop.
 */
export async function pullModelCatalog(fetchImpl: typeof fetch = fetch): Promise<
  | { ok: true; generated: CatalogProvider[]; gateway: CatalogProvider[] }
  | { ok: false; reason: string }
> {
  let modelsDev: unknown;
  let gatewayPayload: unknown;
  try {
    [modelsDev, gatewayPayload] = await Promise.all([
      readJson(fetchImpl, MODELS_DEV_API),
      readJson(fetchImpl, GATEWAY_MODELS_API),
    ]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!modelsDev || typeof modelsDev !== "object" || Array.isArray(modelsDev)) {
    return { ok: false, reason: "models.dev did not return a provider map" };
  }
  const logos = await fetchLogos(fetchImpl, CATALOG_INCLUDE);
  const generated = buildModelsDevCatalog(modelsDev as Record<string, ModelsDevProvider>, logos);
  for (const warning of generated.warnings) console.warn(`model catalog: ${warning}`);
  if (!generated.ok) return { ok: false, reason: generated.reason };
  const gateway = buildGatewayCatalog(gatewayPayload as { data?: GatewayModel[] });
  for (const warning of gateway.warnings) console.warn(`model catalog: ${warning}`);
  if (!gateway.ok) return { ok: false, reason: gateway.reason };
  return { ok: true, generated: generated.providers, gateway: gateway.providers };
}

async function storeModelCatalog(
  ctx: CatalogDb,
  generated: readonly CatalogProvider[],
  gateway: readonly CatalogProvider[],
): Promise<void> {
  const row = {
    id: "current",
    generated: [...generated],
    gateway: [...gateway],
    fetchedAt: new Date(),
  };
  await ctx.db
    .insert(modelCatalogSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: modelCatalogSnapshots.id,
      set: { generated: row.generated, gateway: row.gateway, fetchedAt: row.fetchedAt },
    });
}

/**
 * Pulls the public lists and, when they are usable, serves them and
 * stores them. A refused refresh leaves both the memory and the row
 * as they were.
 */
export async function refreshModelCatalog(
  ctx: CatalogDb,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; models: number } | { ok: false; reason: string }> {
  const pulled = await pullModelCatalog(fetchImpl);
  if (!pulled.ok) return pulled;
  const next = previewModelCatalog(pulled.generated, pulled.gateway);
  const reason = refuseFreshCatalog(catalogModelCount(MODEL_CATALOG), catalogModelCount(next));
  if (reason) return { ok: false, reason };
  await storeModelCatalog(ctx, pulled.generated, pulled.gateway);
  if (!publishModelCatalog(pulled.generated, pulled.gateway)) {
    return { ok: false, reason: "the refresh could not be installed" };
  }
  const models = catalogModelCount(MODEL_CATALOG);
  console.log(`model catalog refreshed: ${models} models`);
  return { ok: true, models };
}

/** Serves the last good fetch, if one is stored and still a catalog. */
export async function loadStoredModelCatalog(ctx: Pick<AppContext, "db">): Promise<boolean> {
  const [row] = await ctx.db.select().from(modelCatalogSnapshots).where(eq(modelCatalogSnapshots.id, "current")).limit(1);
  if (!row) return false;
  if (!isCatalogProviderList(row.generated) || !isCatalogProviderList(row.gateway)) {
    console.warn("stored model catalog is unusable, keeping the committed snapshot");
    return false;
  }
  // A deploy can ship a snapshot newer than the stored fetch. Serving
  // the stored row then would hide models the build already has, until
  // the boot refresh returns. Keep the build when it lists more.
  const stored = previewModelCatalog(row.generated, row.gateway);
  if (catalogModelCount(stored) < catalogModelCount(MODEL_CATALOG)) return false;
  const installed = publishModelCatalog(row.generated, row.gateway);
  if (!installed) console.warn("stored model catalog was refused, keeping the committed snapshot");
  return installed;
}

export async function registerModelCatalogJobs(ctx: AppContext): Promise<void> {
  try {
    if (await loadStoredModelCatalog(ctx)) {
      console.log(`model catalog loaded from storage: ${catalogModelCount(MODEL_CATALOG)} models`);
    }
  } catch (err) {
    console.warn("could not read the stored model catalog:", err);
    ctx.analytics?.captureException(err, null, null, { source: "model_catalog" });
  }
  await ctx.boss.createQueue(MODEL_CATALOG_QUEUE);
  await ctx.boss.schedule(MODEL_CATALOG_QUEUE, MODEL_CATALOG_CRON);
  await ctx.boss.work(
    MODEL_CATALOG_QUEUE,
    { pollingIntervalSeconds: QUEUE_POLL_SECONDS },
    captureJobErrors(ctx.analytics, MODEL_CATALOG_QUEUE, async () => {
      const result = await refreshModelCatalog(ctx);
      if (!result.ok) {
        console.warn(`model catalog refresh skipped: ${result.reason}`);
        ctx.analytics?.captureException(new Error(result.reason), null, null, { source: "model_catalog" });
      }
    }),
  );
}
