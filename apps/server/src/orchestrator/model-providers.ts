/**
 * The model APIs an agent's keys are for: where each key goes when the
 * organization has not set a base URL, and how Bento's model proxy
 * reaches it instead.
 *
 * Two readers, one list. A restricted Modal sandbox allowlists these
 * hosts or it does not start (modal-hosts.ts), and the model proxy
 * (routes/model-proxy.ts) takes its upstreams from here, so the two can
 * never disagree about where a provider lives.
 */

/** How the real key travels to the provider once the proxy swaps it in. */
export type ModelProxyAuth = "x-api-key" | "bearer" | "x-goog-api-key";

export interface ModelProxyRoute {
  /** The path segment: `/api/model-proxy/<segment>/...`. */
  segment: string;
  /**
   * The variable the sandbox is given the proxy's address in, which
   * the adapter reads (or the CLI itself does) as that provider's base
   * URL.
   */
  baseUrlEnv: string;
  /**
   * Where the proxy sends a request when the organization saved no base
   * URL. In the shape the base URL variable has for that provider, so
   * an organization's saved value takes its place exactly: OpenAI's
   * includes /v1 because OPENAI_BASE_URL does, Anthropic's does not
   * because ANTHROPIC_BASE_URL does not. A provider with no saved base
   * URL of its own (OpenRouter, Vercel AI Gateway) is the bare origin,
   * and each adapter adds the path its client expects.
   */
  upstream: string;
  auth: ModelProxyAuth;
}

export interface ModelProvider {
  /** The stored secret holding the key. */
  key: string;
  /** The stored secret that points the key elsewhere, when the provider has one. */
  baseUrlKey?: string;
  /** Hosts a restricted sandbox must reach for this key when nothing proxies it. */
  hosts: readonly string[];
  /** Absent for a credential the proxy does not carry: logins, Cursor, Ollama. */
  proxy?: ModelProxyRoute;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    key: "ANTHROPIC_API_KEY",
    baseUrlKey: "ANTHROPIC_BASE_URL",
    hosts: ["https://api.anthropic.com"],
    proxy: { segment: "anthropic", baseUrlEnv: "ANTHROPIC_BASE_URL", upstream: "https://api.anthropic.com", auth: "x-api-key" },
  },
  { key: "ANTHROPIC_AUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  // A subscription login, valid only at Anthropic's own API: not a key
  // the organization pays for per token, and not something to proxy.
  { key: "CLAUDE_CODE_OAUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  {
    key: "OPENAI_API_KEY",
    baseUrlKey: "OPENAI_BASE_URL",
    hosts: ["https://api.openai.com"],
    proxy: { segment: "openai", baseUrlEnv: "OPENAI_BASE_URL", upstream: "https://api.openai.com/v1", auth: "bearer" },
  },
  {
    key: "OPENROUTER_API_KEY",
    hosts: ["https://openrouter.ai"],
    proxy: { segment: "openrouter", baseUrlEnv: "OPENROUTER_BASE_URL", upstream: "https://openrouter.ai", auth: "bearer" },
  },
  {
    key: "GEMINI_API_KEY",
    baseUrlKey: "GOOGLE_GEMINI_BASE_URL",
    hosts: ["https://generativelanguage.googleapis.com"],
    proxy: {
      segment: "gemini",
      baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
      upstream: "https://generativelanguage.googleapis.com",
      auth: "x-goog-api-key",
    },
  },
  {
    key: "DEEPSEEK_API_KEY",
    baseUrlKey: "DEEPSEEK_BASE_URL",
    hosts: ["https://api.deepseek.com"],
    proxy: { segment: "deepseek", baseUrlEnv: "DEEPSEEK_BASE_URL", upstream: "https://api.deepseek.com", auth: "bearer" },
  },
  {
    key: "POOLSIDE_API_KEY",
    baseUrlKey: "POOLSIDE_STANDALONE_BASE_URL",
    hosts: ["https://inference.poolside.ai"],
    proxy: {
      segment: "poolside",
      baseUrlEnv: "POOLSIDE_STANDALONE_BASE_URL",
      upstream: "https://inference.poolside.ai/v1",
      auth: "bearer",
    },
  },
  {
    key: "AI_GATEWAY_API_KEY",
    hosts: ["https://ai-gateway.vercel.sh"],
    proxy: { segment: "vercel", baseUrlEnv: "AI_GATEWAY_BASE_URL", upstream: "https://ai-gateway.vercel.sh", auth: "bearer" },
  },
  { key: "OLLAMA_API_KEY", baseUrlKey: "OLLAMA_BASE_URL", hosts: ["https://ollama.com"] },
  {
    key: "CURSOR_API_KEY",
    hosts: ["https://api2.cursor.sh", "https://api5.cursor.sh", "https://agentn.global.api5.cursor.sh"],
  },
  {
    key: "CURSOR_AUTH_TOKEN",
    hosts: ["https://api2.cursor.sh", "https://api5.cursor.sh", "https://agentn.global.api5.cursor.sh"],
  },
  {
    key: "META_API_KEY",
    hosts: ["https://api.meta.ai"],
    proxy: { segment: "meta", baseUrlEnv: "META_BASE_URL", upstream: "https://api.meta.ai", auth: "bearer" },
  },
];

/** Where the proxy is mounted, relative to the gateway base. */
export const MODEL_PROXY_PATH = "/api/model-proxy";

/** The provider a key belongs to. */
export function modelProviderForKey(key: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.key === key);
}

/** The proxied provider a path segment names, or undefined. */
export function modelProviderForSegment(segment: string): (ModelProvider & { proxy: ModelProxyRoute }) | undefined {
  return MODEL_PROVIDERS.find(
    (provider): provider is ModelProvider & { proxy: ModelProxyRoute } => provider.proxy?.segment === segment,
  );
}
