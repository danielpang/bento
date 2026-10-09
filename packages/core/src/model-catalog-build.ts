import type { CatalogProvider } from "./models.js";

/**
 * The two public lists a refresh reads. The committed snapshots in
 * model-catalog.generated.ts and model-catalog.gateway.ts are what a
 * server uses until one of these fetches has succeeded.
 */
export const MODELS_DEV_API = "https://models.dev/api.json";
export const GATEWAY_MODELS_API = "https://ai-gateway.vercel.sh/v1/models";

export const modelsDevLogoUrl = (id: string): string => `https://models.dev/logos/${id}.svg`;

/**
 * Official Vercel triangle. models.dev has no vercel logo for us to
 * inherit, so the mark is drawn here and copied into the snapshot.
 */
export const VERCEL_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBmaWxsPSJjdXJyZW50Q29sb3IiIGQ9Ik0xMiAzLjIgMjIuNCAyMS4ySDEuNkwxMiAzLjJ6Ii8+PC9zdmc+";

/**
 * Providers we snapshot. `cursor` is listed so a later models.dev
 * entry is picked up automatically; today it is absent and skipped.
 */
export const CATALOG_INCLUDE = ["anthropic", "openai", "google", "openrouter", "xai", "cursor"] as const;

/** Providers whose public catalog must carry at least one usable rate. */
const PRICED_REQUIRED = new Set<string>(["anthropic", "openai", "google", "openrouter", "xai"]);

/**
 * Per-provider overrides the snapshot cannot express.
 *
 * Bento stores no XAI_API_KEY. Grok is reachable here only through the
 * Cursor CLI, which pays for it with the Cursor key.
 */
const OPTIONS: Record<string, { env: string[] }> = {
  xai: { env: ["CURSOR_API_KEY"] },
};

/**
 * Words in an id that mark a model an agent cannot write code with:
 * image, video, music, and speech generators, realtime voice,
 * embeddings, moderation. Whole segments of the id only, so
 * `gpt-image-2` and `gemini-3.1-flash-live-preview` go and nothing whose
 * name merely contains the letters does. models.dev also says what a
 * model outputs and whether it calls tools; the id catches what it
 * describes loosely, and is all the Gateway gives.
 */
const NOT_FOR_CODING = new Set([
  "audio", "dall", "embed", "embedding", "embeddings", "image", "images", "imagen", "live", "lyria",
  "moderation", "realtime", "rerank", "sora", "speech", "transcribe", "transcription", "tts", "veo", "whisper",
]);

/**
 * Models to lift to the top of a provider's list.
 *
 * OpenRouter's auto router picks a model per request, which is the entry
 * most people want first and the one alphabetical order buries deepest.
 */
const PINNED: Record<string, readonly string[]> = {
  openrouter: ["openrouter/auto"],
  xai: ["grok-4.6", "grok-4.5"],
};

/** fx's default first, then the other slug its docs name. */
const GATEWAY_PINNED = ["moonshotai/kimi-k3", "openai/gpt-5.4"];

export interface ModelsDevModel {
  id: string;
  name?: string;
  status?: string;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number };
}

export interface ModelsDevProvider {
  name?: string;
  env?: string[];
  models?: Record<string, ModelsDevModel>;
}

export interface GatewayModel {
  id?: string;
  name?: string;
  type?: string;
}

export interface CatalogBuild {
  ok: true;
  providers: CatalogProvider[];
  warnings: string[];
}

export interface CatalogBuildFailure {
  ok: false;
  reason: string;
  warnings: string[];
}

function isCodingModel(id: string): boolean {
  return !id.toLowerCase().split(/[-/._:~]+/).some((word) => NOT_FOR_CODING.has(word));
}

/**
 * What a model lists at, in dollars per million tokens.
 *
 * models.dev quotes `cost.input` and `cost.output` in exactly those
 * units, so the figures are copied rather than converted. Only the two
 * that price a run are kept. A model the snapshot does not price keeps
 * no `cost` key at all. A zero would read as free.
 */
function listPrice(model: ModelsDevModel): { cost?: { input: number; output: number } } {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return {};
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return {};
  return { cost: { input, output } };
}

/**
 * Reads text, writes text, calls tools, not deprecated. A field
 * models.dev leaves out is not held against the model.
 */
function agentCapable(model: ModelsDevModel): boolean {
  if (model.status === "deprecated") return false;
  if (model.tool_call === false) return false;
  const input = model.modalities?.input;
  const output = model.modalities?.output;
  if (Array.isArray(input) && input.length > 0 && !input.includes("text")) return false;
  if (Array.isArray(output) && output.length > 0 && !output.includes("text")) return false;
  return true;
}

/**
 * The models.dev half of the catalog. `logos` maps a provider id to a
 * data URI already fetched. A missing logo is an empty string, the same
 * as a provider whose mark the script could not download.
 */
export function buildModelsDevCatalog(
  api: Record<string, ModelsDevProvider | undefined>,
  logos: Readonly<Record<string, string>> = {},
): CatalogBuild | CatalogBuildFailure {
  const warnings: string[] = [];
  const providers: CatalogProvider[] = [];
  for (const id of CATALOG_INCLUDE) {
    const provider = api[id];
    if (!provider) {
      warnings.push(`skipping ${id}: not in the models.dev catalog`);
      continue;
    }
    const options = OPTIONS[id];
    const pinned = PINNED[id] ?? [];
    const rank = (modelId: string) => {
      const at = pinned.indexOf(modelId);
      return at === -1 ? pinned.length : at;
    };
    const models = Object.values(provider.models ?? {})
      .filter((model) => isCodingModel(model.id) && agentCapable(model))
      .map((model) => ({ id: model.id, name: model.name ?? model.id, ...listPrice(model) }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    for (const want of pinned) {
      if (!models.some((model) => model.id === want)) warnings.push(`pinned model ${want} is not in ${id}`);
    }
    if (models.length === 0) {
      warnings.push(`skipping ${id}: no models listed`);
      continue;
    }
    const priced = models.filter((model) => model.cost).length;
    if (PRICED_REQUIRED.has(id) && priced === 0) {
      return { ok: false, reason: `${id} listed ${models.length} models but no input and output prices`, warnings };
    }
    const logo = logos[id] ?? "";
    if (!logo) warnings.push(`no logo for ${id}`);
    providers.push({
      id,
      name: provider.name ?? id,
      env: options?.env ?? provider.env ?? [],
      logo,
      models,
    });
  }
  for (const id of PRICED_REQUIRED) {
    if (!providers.some((provider) => provider.id === id)) {
      return { ok: false, reason: `models.dev listed no usable ${id} models`, warnings };
    }
  }
  return { ok: true, providers, warnings };
}

/** Language models the Gateway serves, under the slugs fx, pi, opencode, and Codex actually send. */
export function buildGatewayCatalog(payload: { data?: GatewayModel[] } | null | undefined): CatalogBuild | CatalogBuildFailure {
  const warnings: string[] = [];
  const listed = Array.isArray(payload?.data) ? payload.data : [];
  const rank = (modelId: string) => {
    const at = GATEWAY_PINNED.indexOf(modelId);
    return at === -1 ? GATEWAY_PINNED.length : at;
  };
  const models = listed
    .filter((model): model is GatewayModel & { id: string } =>
      model?.type === "language" && typeof model.id === "string" && model.id !== "" && isCodingModel(model.id))
    .map((model) => ({ id: model.id, name: typeof model.name === "string" && model.name !== "" ? model.name : model.id }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  for (const want of GATEWAY_PINNED) {
    if (!models.some((model) => model.id === want)) warnings.push(`pinned model ${want} is not in vercel`);
  }
  if (models.length === 0) return { ok: false, reason: "AI Gateway listed no language models", warnings };
  return {
    ok: true,
    warnings,
    providers: [{
      id: "vercel",
      name: "Vercel AI Gateway",
      env: ["AI_GATEWAY_API_KEY"],
      logo: VERCEL_LOGO,
      models,
    }],
  };
}

export function catalogModelCount(providers: readonly { models: readonly unknown[] }[]): number {
  return providers.reduce((sum, provider) => sum + provider.models.length, 0);
}

/**
 * Whether a freshly fetched pair may replace the list the process is
 * serving. A provider that came back empty, or a list that shrank by
 * half, is a bad response rather than a sunset, and the previous list
 * stays up.
 */
export function refuseFreshCatalog(
  previousCount: number,
  nextCount: number,
): string | null {
  if (nextCount === 0) return "the refresh listed no models";
  if (previousCount > 0 && nextCount * 2 < previousCount) {
    return `the refresh listed ${nextCount} models, under half of the ${previousCount} already served`;
  }
  return null;
}

/** A catalog payload from the API or from the snapshot row, checked before it replaces the live list. */
export function isCatalogProviderList(value: unknown): value is CatalogProvider[] {
  if (!Array.isArray(value)) return false;
  return value.every((provider) => {
    if (!provider || typeof provider !== "object") return false;
    const entry = provider as CatalogProvider;
    if (typeof entry.id !== "string" || entry.id === "") return false;
    if (typeof entry.name !== "string") return false;
    if (!Array.isArray(entry.env) || !entry.env.every((name) => typeof name === "string")) return false;
    if (typeof entry.logo !== "string") return false;
    if (!Array.isArray(entry.models)) return false;
    return entry.models.every((model) => {
      if (!model || typeof model !== "object") return false;
      if (typeof model.id !== "string" || model.id === "") return false;
      if (typeof model.name !== "string") return false;
      if (model.cost === undefined) return true;
      return typeof model.cost.input === "number" && typeof model.cost.output === "number"
        && Number.isFinite(model.cost.input) && Number.isFinite(model.cost.output);
    });
  });
}
