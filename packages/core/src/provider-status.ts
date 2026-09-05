import { providerForProfile } from "./models.js";

/**
 * Official status pages for every model provider a Bento tool can
 * reach. When the provider is down, Bento is down too: the useful
 * next step is their page, not ours.
 *
 * Only providers a CLI talks to directly. Models served through
 * OpenRouter still point at OpenRouter, because that is the API
 * the tool called.
 */
export const PROVIDER_STATUS_PAGES = {
  anthropic: { name: "Claude", url: "https://status.claude.com" },
  openai: { name: "OpenAI", url: "https://status.openai.com" },
  openrouter: { name: "OpenRouter", url: "https://status.openrouter.ai" },
  cursor: { name: "Cursor", url: "https://status.cursor.com" },
  xai: { name: "Grok", url: "https://status.x.ai" },
  deepseek: { name: "DeepSeek", url: "https://status.deepseek.com" },
  google: { name: "Gemini", url: "https://aistudio.google.com/status" },
  poolside: { name: "Poolside", url: "https://status.poolside.ai" },
} as const;

export type StatusProvider = keyof typeof PROVIDER_STATUS_PAGES;

/** How a model-string prefix or catalog id maps onto a status page. */
const BY_ID: Record<string, StatusProvider> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  cursor: "cursor",
  xai: "xai",
  deepseek: "deepseek",
  google: "google",
  gemini: "google",
  poolside: "poolside",
};

/**
 * The tool's own API, when the error and model do not name anyone.
 * Cursor bills every model through Cursor, so a Cursor run that only
 * says 503 is a Cursor outage, not Claude's or Grok's.
 */
const BY_CLI: Record<string, StatusProvider> = {
  "claude-code": "anthropic",
  codex: "openai",
  cursor: "cursor",
  dsh: "deepseek",
  pool: "poolside",
};

/**
 * Mentions in the error, most specific first. OpenRouter wins over
 * the model behind it: a Claude Code run routed through OpenRouter
 * still says "openrouter" when the gateway is what failed.
 */
const MENTIONS: readonly [RegExp, StatusProvider][] = [
  [/openrouter/i, "openrouter"],
  [/anthropic|status\.claude|api\.anthropic|\bclaude\b/i, "anthropic"],
  [/\bopenai\b|chatgpt|api\.openai/i, "openai"],
  [/\bcursor\b|\bcomposer\b/i, "cursor"],
  [/\bgrok\b|\bxai\b|x\.ai/i, "xai"],
  [/deepseek/i, "deepseek"],
  [/gemini|aistudio\.google|generativelanguage\.googleapis|\bgoogle\b/i, "google"],
  [/poolside|\blaguna\b/i, "poolside"],
];

/**
 * The provider whose outage this error is about, when we can tell.
 *
 * Mentions in the error win, then a provider/model prefix, then the
 * tool's own API. providerForProfile is last, for opencode and pi
 * whose model string already names the company.
 */
export function outageProvider(
  error: string,
  hint?: { cli?: string | undefined; model?: string | undefined },
): StatusProvider | null {
  for (const [pattern, provider] of MENTIONS) {
    if (pattern.test(error)) return provider;
  }

  const model = hint?.model?.trim();
  if (model) {
    const prefix = model.split("/")[0] ?? "";
    const named = BY_ID[prefix];
    if (named) return named;
  }

  const fromCli = hint?.cli ? BY_CLI[hint.cli] : undefined;
  if (fromCli) return fromCli;

  if (hint?.cli && model) {
    const id = providerForProfile(hint.cli, model)?.id;
    if (id && id in BY_ID) return BY_ID[id] ?? null;
  }
  return null;
}

/**
 * Whether the provider is turning the request away because the model
 * is busy, rather than because the provider is broken.
 *
 * Google answers a capacity spike with a 503 whose message says so:
 * "This model is currently experiencing high demand. Spikes in demand
 * are usually temporary. Please try again later." That is one model
 * running hot for a few minutes, so it never reaches a status page,
 * which reports service health. Telling someone the provider is down
 * and pointing them at a page that is green wastes the one minute
 * they had, and hides the two things that do work: waiting, or
 * running the card on another model.
 *
 * Matched on the provider saying it itself. A generic 503 stays an
 * outage, because a provider that is actually failing does not
 * explain why.
 */
export function looksLikeCapacityPressure(error: string): boolean {
  if (!error) return false;
  return /high demand|spikes? in demand|at capacity|out of capacity|no capacity|(?:model|service) is (?:currently )?overloaded/i.test(
    error,
  );
}

/**
 * Whether this failure looks like the model provider is unavailable,
 * rather than a refused key, a missing model, or a rate limit.
 *
 * Matched on the phrases the CLIs actually print: Anthropic's 529 and
 * overloaded_error, OpenAI's "the server had an error", OpenRouter's
 * "provider returned error", and the 502/503 family. A 401 or 429 in
 * the same string is still not an outage; those have their own fixes.
 * Google's UNAVAILABLE is here too, because its gRPC status is the
 * only thing some of its errors carry a code in.
 */
export function looksLikeProviderOutage(error: string): boolean {
  if (!error) return false;
  if (/invalid api key|incorrect api key|unauthorized|authentication_error|revoked|no auth token|does not exist|model_not_found/i.test(error)) {
    return false;
  }
  if (/\b(401|403|404|429)\b/.test(error) && !/\b(502|503|529)\b/.test(error)) return false;
  return (
    looksLikeCapacityPressure(error) ||
    /got status: UNAVAILABLE/i.test(error) ||
    /overloaded/i.test(error) ||
    /\b529\b/.test(error) ||
    /provider returned error/i.test(error) ||
    /no available (model )?provider/i.test(error) ||
    /the server had an error/i.test(error) ||
    /service unavailable/i.test(error) ||
    /bad gateway/i.test(error) ||
    /internal server error/i.test(error) ||
    /\b(502|503)\b/.test(error) ||
    (/api error/i.test(error) && /\b5\d\d\b/.test(error))
  );
}

/**
 * The sentence to append when a run died on its model provider. Null
 * when the error is something else, or already names the status page.
 *
 * A model at capacity gets its own sentence: it says the provider is
 * busy rather than down, gives the two next steps that work, and says
 * up front that the status page will not show this, so nobody spends
 * their next minute confirming a green page.
 */
export function providerOutageAdvice(
  error: string,
  hint?: { cli?: string | undefined; model?: string | undefined },
): string | null {
  if (!looksLikeProviderOutage(error)) return null;
  const provider = outageProvider(error, hint);
  if (!provider) return null;
  const page = PROVIDER_STATUS_PAGES[provider];
  if (error.includes(page.url)) return null;
  if (looksLikeCapacityPressure(error)) {
    return `${page.name} is busy, not down: this model is out of capacity right now. Run the card again in a few minutes, or switch this agent to another model under Agents. A demand spike does not reach the status page (${page.url}), which stays green through it.`;
  }
  return `${page.name} appears to be down. Check their status page: ${page.url}`;
}

/**
 * The error a person should see: the original text, plus the status
 * page when this looks like a provider outage. Idempotent, so a
 * renderer can apply it to text the server already enriched.
 */
export function withProviderOutageAdvice(
  error: string,
  hint?: { cli?: string | undefined; model?: string | undefined },
): string {
  const advice = providerOutageAdvice(error, hint);
  return advice ? `${error} ${advice}` : error;
}
