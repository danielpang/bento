import { providerForProfile } from "./models.js";

/**
 * Official status pages for the model providers a Bento run can fail
 * with. When the provider is down, Bento is down too: the useful next
 * step is their page, not ours.
 */
export const PROVIDER_STATUS_PAGES = {
  anthropic: { name: "Claude", url: "https://status.claude.com" },
  openai: { name: "OpenAI", url: "https://status.openai.com" },
  openrouter: { name: "OpenRouter", url: "https://status.openrouter.ai" },
} as const;

export type StatusProvider = keyof typeof PROVIDER_STATUS_PAGES;

/**
 * The provider whose outage this error is about, when we can tell.
 *
 * Mentions in the error win, because a Claude Code run routed through
 * OpenRouter still says "openrouter" when the gateway is the thing
 * that failed. The model string and the tool are the fallback for
 * errors that only report a status (529, overloaded) and name nobody.
 *
 * Cursor is left out of the fallback: everything it runs is billed
 * through Cursor, so a Cursor outage is not a Claude or OpenAI one.
 */
export function outageProvider(
  error: string,
  hint?: { cli?: string | undefined; model?: string | undefined },
): StatusProvider | null {
  const text = error.toLowerCase();
  if (text.includes("openrouter")) return "openrouter";
  if (/anthropic|status\.claude|api\.anthropic/.test(text)) return "anthropic";
  if (/\bopenai\b|chatgpt|api\.openai/.test(text)) return "openai";

  const model = hint?.model?.trim();
  if (model) {
    const prefix = model.split("/")[0];
    if (prefix === "openrouter" || prefix === "anthropic" || prefix === "openai") return prefix;
  }

  const cli = hint?.cli;
  if (cli === "claude-code") return "anthropic";
  if (cli === "codex") return "openai";
  if (cli && model && cli !== "cursor" && cli !== "pool" && cli !== "dsh" && cli !== "fake") {
    const id = providerForProfile(cli, model)?.id;
    if (id === "openrouter" || id === "anthropic" || id === "openai") return id;
  }
  return null;
}

/**
 * Whether this failure looks like the model provider is unavailable,
 * rather than a refused key, a missing model, or a rate limit.
 *
 * Matched on the phrases the CLIs actually print: Anthropic's 529 and
 * overloaded_error, OpenAI's "the server had an error", OpenRouter's
 * "provider returned error", and the 502/503 family. A 401 or 429 in
 * the same string is still not an outage; those have their own fixes.
 */
export function looksLikeProviderOutage(error: string): boolean {
  if (!error) return false;
  if (/invalid api key|incorrect api key|unauthorized|authentication_error|revoked|no auth token|does not exist|model_not_found/i.test(error)) {
    return false;
  }
  if (/\b(401|403|404|429)\b/.test(error) && !/\b(502|503|529)\b/.test(error)) return false;
  return (
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
 * The sentence to append when a run died because its model provider
 * is down. Null when the error is something else, or already names
 * the status page.
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
