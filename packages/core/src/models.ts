import { AGENT_CREDENTIALS, MODEL_GUIDANCE } from "./credentials.js";
import { MODEL_CATALOG as GENERATED_CATALOG } from "./model-catalog.generated.js";
import { MANUAL_CATALOG } from "./model-catalog.manual.js";

export interface CatalogModel {
  id: string;
  name: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** Environment variables that authenticate this provider. */
  env: readonly string[];
  /** Data URI, so it renders through an img tag rather than inline SVG. */
  logo: string;
  models: readonly CatalogModel[];
}

/**
 * Every provider Bento knows, refreshed ones first.
 *
 * The generated half comes from models.dev. The manual half is what that
 * snapshot cannot describe, currently Cursor's own Composer ids and
 * Poolside's own inference. Where both halves name the same provider,
 * generated models come first and manual ids that the snapshot missed
 * are appended, so Composer stays listed even after models.dev grows a
 * Cursor provider of its own.
 */
export const MODEL_CATALOG: readonly CatalogProvider[] = mergeCatalogs(GENERATED_CATALOG, MANUAL_CATALOG);

/** Generated providers first; manual ids fill gaps on the same provider. */
export function mergeCatalogs(
  generated: readonly CatalogProvider[],
  manual: readonly CatalogProvider[],
): CatalogProvider[] {
  const byId = new Map<string, CatalogProvider>();
  for (const provider of generated) byId.set(provider.id, provider);
  const extraIds: string[] = [];
  for (const extra of manual) {
    const existing = byId.get(extra.id);
    if (!existing) {
      byId.set(extra.id, extra);
      extraIds.push(extra.id);
      continue;
    }
    const seen = new Set(existing.models.map((m) => m.id));
    const added = extra.models.filter((m) => !seen.has(m.id));
    if (added.length === 0) continue;
    byId.set(extra.id, { ...existing, models: [...existing.models, ...added] });
  }
  return [...generated.map((p) => byId.get(p.id)!), ...extraIds.map((id) => byId.get(id)!)];
}

/**
 * Which providers a tool can be pointed at.
 *
 * The single provider tools take a bare model id, so they only make
 * sense against their own provider, plus OpenRouter when the matching
 * base URL is set. The provider agnostic ones name the provider in the
 * model string, so they can use anything in the catalog.
 *
 * Cursor is the exception on both counts. It takes a bare id like the
 * single provider tools, but it is not tied to one company: everything
 * it runs is billed through the Cursor plan, so Composer and Grok are
 * offered beside Claude and GPT rather than needing a key each. Grok
 * comes from the models.dev xAI snapshot; Composer is still listed by
 * hand because that snapshot has no Cursor provider. Anthropic stays
 * first because Cursor's default model is a Claude one, which is the
 * fallback providerForProfile leans on.
 *
 * pool reaches one provider and one only: Poolside's own inference,
 * whose ids carry the vendor prefix ("poolside/laguna-s-2.1"), which is
 * both what the API takes and what makes the single chip in the picker
 * worth drawing. Laguna weights through OpenRouter stay reachable the
 * way they always were, with pi or opencode.
 */
const BY_CLI: Record<string, readonly string[]> = {
  "claude-code": ["anthropic", "openrouter"],
  codex: ["openai", "openrouter"],
  cursor: ["anthropic", "openai", "google", "xai", "cursor"],
  opencode: ["anthropic", "openai", "google", "deepseek", "openrouter"],
  pi: ["anthropic", "openai", "google", "deepseek", "openrouter"],
  pool: ["poolside"],
  fake: [],
};

export function providersForCli(cli: string): CatalogProvider[] {
  const allowed = BY_CLI[cli] ?? [];
  return allowed
    .map((id) => MODEL_CATALOG.find((p) => p.id === id))
    .filter((p): p is CatalogProvider => Boolean(p));
}

export function providerById(id: string): CatalogProvider | undefined {
  return MODEL_CATALOG.find((p) => p.id === id);
}

/**
 * The string a tool expects for a chosen provider and model.
 *
 * Getting this wrong is a run that fails after a sandbox has already
 * started, so composing it here beats asking a person to remember which
 * tool wants which shape. OpenRouter ids already carry their vendor
 * ("microsoft/phi-4"), which is why the prefixed form nests.
 */
export function modelStringFor(cli: string, providerId: string, modelId: string): string {
  if (cli === "opencode" || cli === "pi") return `${providerId}/${modelId}`;
  if (providerId === "openrouter") return modelId;
  return modelId;
}

/**
 * Which provider an existing agent profile runs against.
 *
 * The inverse of modelStringFor, and lossier, because the tools disagree
 * about what a model string looks like. Three cases, in order:
 *
 * 1. A prefixed string ("anthropic/claude-sonnet-5") names its provider,
 *    which is the provider agnostic tools' shape.
 * 2. A bare id is looked up among the providers that tool can use. This
 *    is why the search is scoped to the tool rather than the whole
 *    catalog: several providers serve the same model id through
 *    OpenRouter, and the tool decides which one is meant.
 * 3. The tool's own default model belongs to the tool's own provider.
 *    The snapshot trails the tools, so a default can be newer than the
 *    catalog: codex ships gpt-5-codex, which is OpenAI's whether or not
 *    the list has caught up.
 *
 * Anything else is undefined, and deliberately not a guess. Every tool
 * here can reach more than one provider, so falling back to the first
 * would put one company's mark on another company's model the moment
 * someone types an id the snapshot does not carry. Where this answer
 * drives a logo, no logo is the honest output; the model string is
 * still shown beside it either way.
 *
 * Undefined also covers the fake agent, which exists so the pipeline
 * can be exercised without spending anything.
 */
export function providerForProfile(cli: string, model: string): CatalogProvider | undefined {
  const allowed = providersForCli(cli);
  if (allowed.length === 0) return undefined;

  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    const named = allowed.find((p) => p.id === prefix);
    if (named) return named;
  }

  const serving = allowed.find((p) => p.models.some((m) => m.id === model));
  if (serving) return serving;

  // BY_CLI lists a tool's own provider first, which is the one its
  // default model runs on.
  return model === MODEL_GUIDANCE.find((g) => g.cli === cli)?.defaultModel ? allowed[0] : undefined;
}

/**
 * Whether a coding agent can actually run a model.
 *
 * - `ok`: the tool reaches that model's provider directly.
 * - `routed`: it reaches it only by pointing its own base URL at
 *   OpenRouter. Legitimate, and the reason the pairing is allowed, but
 *   it needs a credential that plain use does not.
 * - `unknown`: the model is not in the catalog, so nothing can be
 *   proved either way. The snapshot trails the tools, and people run
 *   models newer than it, so this is not a failure.
 * - `impossible`: the model belongs to a provider the tool cannot
 *   reach at all. Claude Code cannot run a GPT model.
 */
export type PairingStatus = "ok" | "routed" | "unknown" | "impossible";

export interface AgentPairing {
  readonly status: PairingStatus;
  /** Resolved provider, absent when the model is unknown. */
  readonly provider?: CatalogProvider;
  /** The credential a `routed` pairing needs on top of the usual key. */
  readonly credential?: string;
  /** One line for a person, safe to show verbatim. */
  readonly detail: string;
}

/** Tools that name the provider inside the model string. */
function namesItsProvider(cli: string): boolean {
  return cli === "opencode" || cli === "pi";
}

/** Whoever serves this model, ignoring which tool wants to run it. */
function providerOfModel(model: string): CatalogProvider | undefined {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const named = MODEL_CATALOG.find((p) => p.id === model.slice(0, slash));
    if (named) return named;
  }
  return MODEL_CATALOG.find((p) => p.models.some((m) => m.id === model));
}

/**
 * Checks a coding agent against a model, so an impossible pairing is
 * caught where it is chosen rather than inside a sandbox thirty seconds
 * into a run.
 *
 * The verdict comes from the per-tool provider matrix that already
 * drives the pickers, so there is one place that knows what a tool can
 * reach, not two that can disagree.
 */
export function checkAgentPairing(cli: string, model: string): AgentPairing {
  const allowed = providersForCli(cli);
  if (allowed.length === 0) {
    // The fake agent takes any model string: it calls nothing.
    return { status: "ok", detail: "This agent runs no model." };
  }

  const provider = providerForProfile(cli, model);
  if (!provider) {
    // Not reachable by this tool. Whether that is a mistake or just a
    // model the catalog has not caught up with depends on whether
    // anyone else serves it, so ask the whole catalog before judging.
    const elsewhere = providerOfModel(model);
    if (elsewhere) {
      const reachable = allowed.map((p) => p.name).join(", ");
      return {
        status: "impossible",
        provider: elsewhere,
        detail: `This tool cannot run ${elsewhere.name} models. It reaches ${reachable}.`,
      };
    }
    return {
      status: "unknown",
      detail: "This model is not in the catalog, so its provider could not be checked.",
    };
  }

  if (provider.id === "openrouter" && !namesItsProvider(cli)) {
    // The tool's own provider is first in its list, and its base URL is
    // what gets pointed at OpenRouter.
    const native = allowed[0]?.id.toUpperCase();
    const credential = AGENT_CREDENTIALS.find((c) => c.name === `${native}_BASE_URL`)?.name;
    return {
      status: "routed",
      provider,
      ...(credential ? { credential } : {}),
      detail: credential
        ? `Runs through OpenRouter, which needs ${credential} set as well as the OpenRouter key.`
        : "Runs through OpenRouter, which needs this tool's base URL pointed at it.",
    };
  }

  return { status: "ok", provider, detail: `Runs on ${provider.name}.` };
}

/** The credential a provider needs, when Bento stores one for it. */
export function credentialForProvider(providerId: string, known: readonly string[]): string | undefined {
  const provider = providerById(providerId);
  return provider?.env.find((name) => known.includes(name));
}
