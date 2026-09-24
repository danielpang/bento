import type { CatalogModel, CatalogProvider } from "./models.js";

/**
 * The live half of the model catalog: the same two sources
 * scripts/update-models.mjs snapshots, read at run time.
 *
 * The committed snapshot trails releases by however long it has been
 * since somebody ran `pnpm models:update`, and a model missing from the
 * picker cannot be chosen for Claude Code or Codex in the console at
 * all, because the field is a select whenever the provider is known.
 * The server reads these sources on a timer and lays what it finds over
 * the snapshot (see overlayCatalog), so a model is listed the day
 * models.dev lists it rather than the day a release ships.
 *
 * The snapshot stays the floor. A board that cannot reach the internet
 * still offers every model it did before, and a live answer never
 * removes an id: a model the source has retired may still be what an
 * existing agent runs, and its logo should not vanish from the board.
 *
 * The filtering rules below mirror the script's INCLUDE, OPTIONS, and
 * PINNED. Change them together, or a refresh and a snapshot will
 * disagree about which providers and models exist.
 */
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const INCLUDE = ["anthropic", "openai", "google", "openrouter", "xai", "cursor"] as const;

const OPTIONS: Record<string, { env?: string[]; textOutputOnly?: boolean }> = {
  xai: { env: ["CURSOR_API_KEY"], textOutputOnly: true },
};

const PINNED: Record<string, readonly string[]> = {
  openrouter: ["openrouter/auto"],
  xai: ["grok-4.6", "grok-4.5"],
};

const GATEWAY_PINNED = ["moonshotai/kimi-k3", "openai/gpt-5.4"];

function byPin(pinned: readonly string[]) {
  const rank = (id: string) => {
    const at = pinned.indexOf(id);
    return at === -1 ? pinned.length : at;
  };
  return (a: CatalogModel, b: CatalogModel) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
}

function outputsText(model: { modalities?: { output?: unknown } }): boolean {
  const output = model.modalities?.output;
  if (!Array.isArray(output) || output.length === 0) return true;
  return output.includes("text");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * models.dev's api.json, narrowed to the providers Bento can store a
 * key for. Logos are left empty: the snapshot already carries a mark
 * for every included provider, and overlayCatalog keeps it.
 */
export function parseModelsDev(api: unknown): CatalogProvider[] {
  if (!isRecord(api)) return [];
  const providers: CatalogProvider[] = [];
  for (const id of INCLUDE) {
    const provider = api[id];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const options = OPTIONS[id] ?? {};
    const models = Object.values(provider.models)
      .filter(isRecord)
      .filter((m) => typeof m.id === "string" && m.id !== "")
      .filter((m) => !options.textOutputOnly || outputsText(m as { modalities?: { output?: unknown } }))
      .map((m) => ({ id: m.id as string, name: typeof m.name === "string" && m.name !== "" ? m.name : (m.id as string) }))
      .sort(byPin(PINNED[id] ?? []));
    if (models.length === 0) continue;
    const env = Array.isArray(provider.env) ? provider.env.filter((e): e is string => typeof e === "string") : [];
    providers.push({
      id,
      name: typeof provider.name === "string" ? provider.name : id,
      env: options.env ?? env,
      logo: "",
      models,
    });
  }
  return providers;
}

/** The Gateway's /v1/models, language models only. */
export function parseGatewayModels(payload: unknown): CatalogProvider[] {
  const listed = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const models = listed
    .filter(isRecord)
    .filter((m) => m.type === "language" && typeof m.id === "string" && m.id !== "")
    .map((m) => ({ id: m.id as string, name: typeof m.name === "string" && m.name !== "" ? m.name : (m.id as string) }))
    .sort(byPin(GATEWAY_PINNED));
  if (models.length === 0) return [];
  return [{ id: "vercel", name: "Vercel AI Gateway", env: ["AI_GATEWAY_API_KEY"], logo: "", models }];
}

/**
 * Lays a live list over a base catalog.
 *
 * Where both name a provider, the live model order wins (it is the
 * source's current, pinned-first order) and every base id the live list
 * lacks is appended, so hand-added ids, pins, and retired models all
 * stay. The base keeps its name, env, and logo: those carry Bento's own
 * overrides (Grok billed through the Cursor key) and the marks the
 * snapshot inlined. A live provider the base lacks is appended.
 */
export function overlayCatalog(
  base: readonly CatalogProvider[],
  live: readonly CatalogProvider[],
): CatalogProvider[] {
  const liveById = new Map(live.map((p) => [p.id, p]));
  const merged = base.map((provider) => {
    const fresh = liveById.get(provider.id);
    if (!fresh) return provider;
    const seen = new Set(fresh.models.map((m) => m.id));
    return { ...provider, models: [...fresh.models, ...provider.models.filter((m) => !seen.has(m.id))] };
  });
  const baseIds = new Set(base.map((p) => p.id));
  return [...merged, ...live.filter((p) => !baseIds.has(p.id))];
}
