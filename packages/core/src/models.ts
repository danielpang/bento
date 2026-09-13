import { AGENT_CREDENTIALS, MODEL_GUIDANCE, modelGuidanceFor } from "./credentials.js";
import { MODEL_CATALOG as GENERATED_CATALOG } from "./model-catalog.generated.js";
import { GATEWAY_CATALOG } from "./model-catalog.gateway.js";
import { MANUAL_CATALOG } from "./model-catalog.manual.js";
import { isOllamaModel } from "./ollama.js";

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
 * The generated half comes from models.dev. Vercel AI Gateway is a
 * second snapshot, from the Gateway's own model list, because those
 * slugs are not a models.dev provider. The manual half is what neither
 * snapshot can describe (Cursor's own Composer ids, Poolside's own
 * inference) or does not describe yet (a model released after the
 * snapshot was taken). Where both halves name the same provider,
 * generated models come first and manual ids that the snapshot missed
 * are appended, so Composer stays listed even after models.dev grows a
 * Cursor provider of its own, and a hand-added id drops out of the
 * manual list's way once a refresh carries it.
 */
export const MODEL_CATALOG: readonly CatalogProvider[] = mergeCatalogs(
  mergeCatalogs(GENERATED_CATALOG, GATEWAY_CATALOG),
  MANUAL_CATALOG,
);

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
 *
 * Vercel AI Gateway is the other gateway: one key, slugs that look
 * like OpenRouter's (`moonshotai/kimi-k3`). fx is a harness that
 * speaks Gateway and nothing else. pi, opencode, and Codex can pick
 * Gateway the way they pick OpenRouter: the prefix is `vercel/`, the
 * existing Anthropic and OpenAI keys are not used, and the bill is
 * the Gateway's. A slash on fx is still a Gateway slug, because fx
 * has no other provider.
 */
const BY_CLI: Record<string, readonly string[]> = {
  // Ollama is last wherever it appears, and only ever named by its
  // prefix (ollama/glm-5.1). See ollama.ts.
  "claude-code": ["anthropic", "openrouter", "ollama"],
  // vercel after openrouter so a bare slash on Codex stays OpenRouter
  // (the historical default) and only an explicit vercel/ prefix
  // selects Gateway. See providerForProfile.
  codex: ["openai", "openrouter", "vercel"],
  cursor: ["anthropic", "openai", "google", "xai", "cursor"],
  opencode: ["anthropic", "openai", "google", "deepseek", "openrouter", "vercel", "ollama"],
  pi: ["anthropic", "openai", "google", "deepseek", "openrouter", "vercel"],
  pool: ["poolside"],
  dsh: ["deepseek", "ollama"],
  // Antigravity reaches Gemini and nothing else here, but under its own
  // slugs rather than the Gemini API's ids, so it is its own provider.
  // See model-catalog.manual.ts.
  antigravity: ["antigravity"],
  // Muse Code reaches Muse Spark and nothing else here, under Meta's
  // own bare ids rather than the OpenRouter `meta/muse-spark-*` strings.
  muse: ["meta"],
  fx: ["vercel"],
  fake: [],
};

export function providersForCli(cli: string): CatalogProvider[] {
  const allowed = BY_CLI[cli] ?? [];
  return allowed
    .map((id) => MODEL_CATALOG.find((p) => p.id === id))
    .filter((p): p is CatalogProvider => Boolean(p));
}

/**
 * Whether this tool, running this model, goes to Ollama.
 *
 * The ollama/ prefix means Ollama only on the tools Bento points at it.
 * Anywhere else the string is whatever that tool makes of it (pi users
 * define providers of their own under that name), and Bento treats it
 * exactly as it did before Ollama was listed.
 */
export function routesToOllama(cli: string, model: string): boolean {
  return isOllamaModel(model) && (BY_CLI[cli] ?? []).includes("ollama");
}

/**
 * Whether Bento's Ollama waits for saved credentials on this tool.
 *
 * opencode names providers itself, and "ollama" is one its own config can
 * define, so an ollama/ model there runs with the user's own opencode
 * setup until Ollama credentials are saved in Bento. Claude Code and
 * DeepSeek Harness have no such setup to fall back on.
 */
export function ollamaNeedsSavedCredentials(cli: string): boolean {
  return namesItsProvider(cli);
}

/**
 * The cost to record for a run, or nothing. Claude Code prices every
 * model as a Claude model, so the figure it reports for an Ollama run is
 * made up: $0.12 for a run on a free model. Recording nothing reads as
 * "not reported", which is true, rather than as spend.
 */
export function trustedCostUsd(cli: string, model: string, costUsd: number | undefined): number | undefined {
  return routesToOllama(cli, model) ? undefined : costUsd;
}

/**
 * The same rule for a transcript event. The result line of a run is
 * where the cost is shown ("finished · $0.12"), so an untrusted figure
 * is dropped there too, not only from the run's row.
 */
export function withTrustedCost<T extends { type: string; costUsd?: number | undefined }>(
  cli: string,
  model: string,
  event: T,
): T {
  if (event.type !== "result" || event.costUsd === undefined) return event;
  if (trustedCostUsd(cli, model, event.costUsd) !== undefined) return event;
  const { costUsd: _untrusted, ...rest } = event;
  return rest as T;
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
  // Bento's prefix, stripped before the CLI sees the id: it is what sends
  // this agent's runs to Ollama instead of the tool's own provider.
  if (providerId === "ollama") return `ollama/${modelId}`;
  if (providerId === "openrouter") return modelId;
  // Gateway slugs already look like OpenRouter's. Codex cannot treat a
  // bare slash as Gateway (that is OpenRouter), so the picker writes
  // the vercel/ prefix and the adapter strips it. fx has no other
  // provider, so it stores the slug alone.
  if (providerId === "vercel") return cli === "fx" ? modelId : `vercel/${modelId}`;
  return modelId;
}

/**
 * Which provider an existing agent profile runs against.
 *
 * The inverse of modelStringFor, and lossier, because the tools disagree
 * about what a model string looks like. Three cases, in order:
 *
 * 1. A prefixed string ("anthropic/claude-sonnet-5") names its provider
 *    on the tools that put the provider in the model string (pi,
 *    opencode, and pool). Codex and Claude Code take bare ids natively,
 *    so openai/gpt-5-mini is OpenRouter's slug rather than OpenAI's.
 *    The explicit openrouter/ and vercel/ prefixes are the exceptions
 *    both kinds share.
 *    Codex goes further: every slash is OpenRouter, because that is how
 *    the picker writes the selected provider, and because a typed slug
 *    the snapshot has not listed yet is still that same selection. The
 *    Codex adapter reads this answer to pass `-c model_provider=openrouter`.
 *    Claude Code does not: a google/ slug there is Gemini, which it
 *    cannot run, not an OpenRouter id.
 * 2. A bare id, or a slug the prefix rule did not claim, is looked up
 *    among the providers that tool can use. This is why the search is
 *    scoped to the tool rather than the whole catalog: several
 *    providers serve the same model id through OpenRouter, and the
 *    tool decides which one is meant.
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
    // ollama/ is Bento's own prefix on every tool that reaches Ollama,
    // bare id tools included, because the adapter strips it.
    if (named && (namesItsProvider(cli) || prefix === "openrouter" || prefix === "ollama" || prefix === "vercel")) {
      return named;
    }
    // Codex native ids are bare. A slash is OpenRouter selected as the
    // provider: the picker writes catalog slugs that way, and a typed
    // id uses the same shape. The adapter then selects Codex's own
    // `model_provider=openrouter` from this same answer.
    if (cli === "codex") return allowed.find((p) => p.id === "openrouter");
    // fx native ids are Gateway slugs. The prefix names the vendor
    // behind the gateway, not a Bento provider, so a slash is Vercel
    // the way a slash on Codex is OpenRouter. Unlisted slugs stay
    // typeable and still wear the Gateway mark.
    if (cli === "fx") return allowed.find((p) => p.id === "vercel");
  }

  // Never Ollama: its cloud ids are bare (glm-5.1), and matching one here
  // would mark a Claude Code agent as Ollama's while its runs went to
  // Anthropic. Only the ollama/ prefix sends a run there.
  const serving = allowed.find((p) => p.id !== "ollama" && p.models.some((m) => m.id === model));
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
 *   it needs a credential that plain use does not. Codex is the
 *   exception: the adapter writes OpenRouter as a Codex provider, so
 *   picking an OpenRouter model is enough.
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
  // pool's ids carry the vendor prefix ("poolside/laguna-s-2.1"), which
  // is both what the API takes and how an unpublished Laguna stays
  // typeable. Claude Code and Codex take bare ids natively, so a
  // prefix there is an OpenRouter slug rather than a provider name.
  return cli === "opencode" || cli === "pi" || cli === "pool";
}

/** Whoever serves this model, ignoring which tool wants to run it. */
function providerOfModel(model: string): CatalogProvider | undefined {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const named = MODEL_CATALOG.find((p) => p.id === model.slice(0, slash));
    if (named) return named;
  }
  // Never Ollama by a bare id, for the reason providerForProfile gives. A
  // tool that cannot reach Ollama was allowed a model like gpt-oss:20b
  // before Ollama was listed (Codex pointed at an Ollama server of its
  // own), and listing it must not turn that into a refusal.
  return MODEL_CATALOG.find((p) => p.id !== "ollama" && p.models.some((m) => m.id === model));
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
  const guidance = modelGuidanceFor(cli);
  if (guidance?.bareModelId && model.includes("/") && !routesToOllama(cli, model)) {
    const example = guidance.examples[0] ?? guidance.defaultModel;
    return {
      status: "impossible",
      detail: `${guidance.label} takes a bare model id, for example ${example}, without a provider prefix.`,
    };
  }
  const allowed = providersForCli(cli);
  if (allowed.length === 0) {
    // The fake agent takes any model string: it calls nothing.
    return { status: "ok", detail: "This agent runs no model." };
  }

  const provider = providerForProfile(cli, model);
  if (!provider) {
    // Not reachable by this tool. Whether that is a mistake or just a
    // model the catalog has not caught up with depends on whether a
    // provider this tool cannot use serves it. A slash on Codex is
    // OpenRouter (handled above). A google/ slug on Claude Code names
    // a provider it cannot reach, so it is impossible rather than an
    // unlisted OpenRouter id. An ollama/ string reaches this point only
    // on a tool Bento does not point at Ollama, where it names nothing
    // Bento can judge.
    const elsewhere = providerOfModel(model);
    if (elsewhere && elsewhere.id !== "ollama" && !allowed.some((p) => p.id === elsewhere.id)) {
      const reachable = allowed.map((p) => p.name).join(", ");
      return {
        status: "impossible",
        provider: elsewhere,
        detail: `This tool cannot run ${elsewhere.name} models. It reaches ${reachable}.`,
      };
    }
    // A bare id Ollama serves may be meant for a base URL pointed at an
    // Ollama server, which is allowed. The prefix is the other reading.
    const ollamaServes =
      allowed.some((p) => p.id === "ollama") &&
      Boolean(providerById("ollama")?.models.some((m) => m.id === model));
    return {
      status: "unknown",
      detail: ollamaServes
        ? `This model is not in the catalog for this tool, so its provider could not be checked. To run it on Ollama, use ollama/${model}.`
        : "This model is not in the catalog, so its provider could not be checked.",
    };
  }

  if (provider.id === "vercel" && cli === "codex") {
    return { status: "ok", provider, detail: "Runs on Vercel AI Gateway." };
  }

  if (provider.id === "openrouter" && !namesItsProvider(cli)) {
    // Codex selects OpenRouter as its model_provider, so picking that
    // provider (a slash slug) is a first class pairing. Claude Code
    // still speaks Anthropic's API and needs ANTHROPIC_BASE_URL
    // pointed at OpenRouter.
    if (cli === "codex") {
      return { status: "ok", provider, detail: "Runs on OpenRouter." };
    }
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
