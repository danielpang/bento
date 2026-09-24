import type { CatalogModel, CatalogProvider } from "./models.js";

/**
 * The live half of the model catalog: the same two sources
 * scripts/update-models.mjs snapshots, read at run time.
 *
 * The committed snapshot trails releases by however long it has been
 * since somebody ran `pnpm models:update`, and a model missing from the
 * picker cannot be chosen for Claude Code or Codex in the console at
 * all, because the field is a select whenever the provider is known.
 * The server reads these sources on a timer and replaces the snapshot's
 * lists with what it finds (see overlayCatalog), so a model is listed
 * the day models.dev lists it, and drops out the day a provider sunsets
 * it, rather than whenever somebody next refreshes the snapshot.
 *
 * The snapshot is the fallback. A board that cannot reach the internet,
 * or a refresh where a source is down, keeps offering what the snapshot
 * lists. Hand-maintained ids (model-catalog.manual.ts) are merged on top
 * either way, because no source describes them and so none can retire
 * them.
 *
 * The filtering rules below mirror the script's INCLUDE, OPTIONS, and
 * PINNED, and isCodingModel mirrors its NOT_FOR_CODING. Change them
 * together, or a refresh and a snapshot will disagree about which
 * providers and models exist.
 */
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const INCLUDE = ["anthropic", "openai", "google", "openrouter", "xai", "cursor"] as const;

const OPTIONS: Record<string, { env?: string[] }> = {
  xai: { env: ["CURSOR_API_KEY"] },
};

const PINNED: Record<string, readonly string[]> = {
  openrouter: ["openrouter/auto"],
  xai: ["grok-4.6", "grok-4.5"],
};

const GATEWAY_PINNED = ["moonshotai/kimi-k3", "openai/gpt-5.4"];

/**
 * Words in a model id that mark it as something other than a model an
 * agent can write code with: image, video, music, and speech generators,
 * realtime voice, embeddings, moderation. Matched as whole segments of
 * the id, so `gpt-image-2` and `gemini-3.1-flash-live-preview` go and
 * nothing whose name merely contains the letters does.
 *
 * The id is the one signal every source carries. models.dev also says
 * what a model outputs and whether it calls tools, which parseModelsDev
 * checks as well, but the committed snapshot kept only ids and names,
 * so this is what cleans it.
 */
const NOT_FOR_CODING = new Set([
  "audio",
  "dall",
  "embed",
  "embedding",
  "embeddings",
  "image",
  "images",
  "imagen",
  "live",
  "lyria",
  "moderation",
  "realtime",
  "rerank",
  "sora",
  "speech",
  "transcribe",
  "transcription",
  "tts",
  "veo",
  "whisper",
]);

export function isCodingModel(id: string): boolean {
  return !id.toLowerCase().split(/[-/._:~]+/).some((word) => NOT_FOR_CODING.has(word));
}

/** Drops every model isCodingModel refuses, and any provider left empty. */
export function codingModelsOnly(catalog: readonly CatalogProvider[]): CatalogProvider[] {
  return catalog
    .map((provider) => ({ ...provider, models: provider.models.filter((m) => isCodingModel(m.id)) }))
    .filter((provider) => provider.models.length > 0);
}

function byPin(pinned: readonly string[]) {
  const rank = (id: string) => {
    const at = pinned.indexOf(id);
    return at === -1 ? pinned.length : at;
  };
  return (a: CatalogModel, b: CatalogModel) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasList = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0;

/**
 * Whether a models.dev entry is something a coding agent can run:
 * reads text, writes text, can call tools (every agent here edits files
 * through tools), and is not marked deprecated by the provider. A field
 * models.dev leaves out is not held against the model.
 */
function agentCapable(model: Record<string, unknown>): boolean {
  if (model.status === "deprecated") return false;
  if (model.tool_call === false) return false;
  const modalities = isRecord(model.modalities) ? model.modalities : {};
  if (hasList(modalities.input) && !modalities.input.includes("text")) return false;
  if (hasList(modalities.output) && !modalities.output.includes("text")) return false;
  return true;
}

/**
 * models.dev's api.json, narrowed to the providers Bento can store a
 * key for and the models a coding agent can run. Logos are left empty:
 * the snapshot already carries a mark for every included provider, and
 * overlayCatalog keeps it.
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
      .filter((m) => typeof m.id === "string" && m.id !== "" && isCodingModel(m.id))
      .filter(agentCapable)
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
    .filter((m) => m.type === "language" && typeof m.id === "string" && m.id !== "" && isCodingModel(m.id))
    .map((m) => ({ id: m.id as string, name: typeof m.name === "string" && m.name !== "" ? m.name : (m.id as string) }))
    .sort(byPin(GATEWAY_PINNED));
  if (models.length === 0) return [];
  return [{ id: "vercel", name: "Vercel AI Gateway", env: ["AI_GATEWAY_API_KEY"], logo: "", models }];
}

/**
 * Replaces a base catalog's model lists with live ones.
 *
 * Where both name a provider, the live list is the whole answer: a model
 * the source no longer lists has been sunset and leaves the picker. The
 * base keeps its name, env, and logo, which carry Bento's own overrides
 * (Grok billed through the Cursor key) and the marks the snapshot
 * inlined. A provider the live read did not return (its source was down,
 * or it listed nothing) keeps the base list. A live provider the base
 * lacks is appended.
 *
 * Hand-maintained ids are not the base here: models.ts merges them on
 * top afterwards, so a sunset in a source never takes Composer or a
 * model the snapshot has not caught up with.
 */
export function overlayCatalog(
  base: readonly CatalogProvider[],
  live: readonly CatalogProvider[],
): CatalogProvider[] {
  const liveById = new Map(live.map((p) => [p.id, p]));
  const merged = base.map((provider) => {
    const fresh = liveById.get(provider.id);
    return fresh && fresh.models.length > 0 ? { ...provider, models: fresh.models } : provider;
  });
  const baseIds = new Set(base.map((p) => p.id));
  return [...merged, ...live.filter((p) => !baseIds.has(p.id))];
}
