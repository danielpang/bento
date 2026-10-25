/**
 * The model APIs an agent's keys are for: where each key goes when the
 * organization has not set a base URL, how Bento's model proxy reaches
 * it instead, and which of its endpoints the proxy will call.
 *
 * One table for every reader. A restricted Modal sandbox allowlists
 * these hosts or it does not start (the server's modal-hosts.ts), the
 * model proxy takes its upstreams and endpoints from here, and the
 * adapters that route a provider through a base URL of their own
 * (opencode, pi) key their provider ids off these entries, so none of
 * them can disagree about where a provider lives or what it is called.
 */

/** How the real key travels to the provider once the proxy swaps it in. */
export type ModelProxyAuth = "x-api-key" | "bearer" | "x-goog-api-key";

/**
 * One endpoint the proxy will call for a provider: a method, and a path
 * as the client sends it after `/api/model-proxy/<segment>`. `{id}`
 * stands for one path segment naming a model (letters, digits, dots,
 * dashes, underscores, @), never a dot segment or anything encoded.
 * WEBSOCKET is an upgrade request, which the proxy answers with 426
 * so the client falls back to HTTP (Codex opens each turn with one).
 */
export interface ModelEndpoint {
  method: "GET" | "POST" | "WEBSOCKET";
  path: string;
}

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
  /**
   * The inference endpoints the proxy calls with the organization's key:
   * completions, token counting and model listings, as the CLIs were
   * seen to send them. Anything else (files, fine tuning, batches,
   * account and admin APIs) is refused, because the token would
   * otherwise spend the key on the provider's whole API. A CLI that
   * starts calling a new endpoint is refused and reported to error
   * tracking, which is how this list learns about it.
   */
  endpoints: readonly ModelEndpoint[];
}

export interface ModelProvider {
  /** The stored secret holding the key. */
  key: string;
  /** The stored secret that points the key elsewhere, when the provider has one. */
  baseUrlKey?: string;
  /** Hosts a restricted sandbox must reach for this key when nothing proxies it. */
  hosts: readonly string[];
  /** Absent for a credential the proxy does not carry: logins, Cursor, Ollama, Meta. */
  proxy?: ModelProxyRoute;
}

const post = (path: string): ModelEndpoint => ({ method: "POST", path });
const get = (path: string): ModelEndpoint => ({ method: "GET", path });
const websocket = (path: string): ModelEndpoint => ({ method: "WEBSOCKET", path });

/** Anthropic's Messages API under a prefix: Anthropic itself, OpenRouter and AI Gateway serve it. */
const anthropicMessages = (prefix: string): ModelEndpoint[] => [
  post(`${prefix}/v1/messages`),
  post(`${prefix}/v1/messages/count_tokens`),
];

/** Gemini's model methods, under one API version. */
const geminiModels = (version: string): ModelEndpoint[] => [
  post(`/${version}/models/{id}:generateContent`),
  post(`/${version}/models/{id}:streamGenerateContent`),
  post(`/${version}/models/{id}:countTokens`),
  get(`/${version}/models`),
  get(`/${version}/models/{id}`),
];

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    key: "BENTO_PERSONAL_ANTHROPIC", hosts: ["https://api.anthropic.com"],
    proxy: { segment: "subscription-anthropic", baseUrlEnv: "ANTHROPIC_BASE_URL",
      upstream: "https://api.anthropic.com", auth: "bearer",
      endpoints: [...anthropicMessages(""), get("/v1/models"), get("/v1/models/{id}")] },
  },
  {
    key: "BENTO_PERSONAL_CODEX", hosts: ["https://chatgpt.com"],
    proxy: { segment: "subscription-codex", baseUrlEnv: "OPENAI_BASE_URL",
      upstream: "https://chatgpt.com/backend-api/codex", auth: "bearer",
      endpoints: [post("/responses"), post("/responses/compact"), websocket("/responses"), post("/codex/responses"), websocket("/codex/responses")] },
  },
  {
    key: "ANTHROPIC_API_KEY",
    baseUrlKey: "ANTHROPIC_BASE_URL",
    hosts: ["https://api.anthropic.com"],
    proxy: {
      segment: "anthropic",
      baseUrlEnv: "ANTHROPIC_BASE_URL",
      upstream: "https://api.anthropic.com",
      auth: "x-api-key",
      // Claude Code, pi and opencode all send /v1/messages (Claude Code
      // with ?beta=true, which the query carries).
      endpoints: [...anthropicMessages(""), get("/v1/models"), get("/v1/models/{id}")],
    },
  },
  { key: "ANTHROPIC_AUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  // A subscription login, valid only at Anthropic's own API: not a key
  // the organization pays for per token, and not something to proxy.
  { key: "CLAUDE_CODE_OAUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  {
    key: "OPENAI_API_KEY",
    baseUrlKey: "OPENAI_BASE_URL",
    hosts: ["https://api.openai.com"],
    proxy: {
      segment: "openai",
      baseUrlEnv: "OPENAI_BASE_URL",
      upstream: "https://api.openai.com/v1",
      auth: "bearer",
      // Codex asks for a WebSocket on /responses first, then posts there;
      // its remote compaction posts to /responses/compact. pi and
      // opencode post to /responses.
      endpoints: [
        websocket("/responses"),
        post("/responses"),
        post("/responses/compact"),
        post("/chat/completions"),
        get("/models"),
        get("/models/{id}"),
      ],
    },
  },
  {
    key: "OPENROUTER_API_KEY",
    hosts: ["https://openrouter.ai"],
    proxy: {
      segment: "openrouter",
      baseUrlEnv: "OPENROUTER_BASE_URL",
      upstream: "https://openrouter.ai",
      auth: "bearer",
      // Codex's Responses provider, pi's and opencode's chat completions,
      // and pi's anthropic/ models over Anthropic's API under /api.
      endpoints: [
        websocket("/api/v1/responses"),
        post("/api/v1/responses"),
        post("/api/v1/chat/completions"),
        ...anthropicMessages("/api"),
        get("/api/v1/models"),
      ],
    },
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
      endpoints: [...geminiModels("v1beta"), ...geminiModels("v1")],
    },
  },
  {
    key: "DEEPSEEK_API_KEY",
    baseUrlKey: "DEEPSEEK_BASE_URL",
    hosts: ["https://api.deepseek.com"],
    proxy: {
      segment: "deepseek",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      upstream: "https://api.deepseek.com",
      auth: "bearer",
      // DeepSeek serves its OpenAI compatible API with and without /v1.
      endpoints: [post("/chat/completions"), post("/v1/chat/completions"), get("/models"), get("/v1/models")],
    },
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
      // OpenAI shaped, as the base URL's /v1 says; not yet seen from pool itself.
      endpoints: [post("/chat/completions"), post("/responses"), get("/models")],
    },
  },
  {
    key: "AI_GATEWAY_API_KEY",
    hosts: ["https://ai-gateway.vercel.sh"],
    proxy: {
      segment: "vercel",
      baseUrlEnv: "AI_GATEWAY_BASE_URL",
      upstream: "https://ai-gateway.vercel.sh",
      auth: "bearer",
      // Codex's compatibility endpoint under /codex/v1, opencode's AI SDK
      // gateway under /v3/ai, and pi's Anthropic Messages at the origin.
      endpoints: [
        websocket("/codex/v1/responses"),
        post("/codex/v1/responses"),
        post("/v3/ai/language-model"),
        get("/v3/ai/config"),
        ...anthropicMessages(""),
        post("/v1/chat/completions"),
        post("/v1/responses"),
        get("/v1/models"),
      ],
    },
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
  // Muse sends it to Meta with no base URL to point elsewhere, so the
  // proxy does not carry it.
  { key: "META_API_KEY", hosts: ["https://api.meta.ai"] },
];

/** Where the proxy is mounted, relative to the gateway base. */
export const MODEL_PROXY_PATH = "/api/model-proxy";

export type ProxiedModelProvider = ModelProvider & { proxy: ModelProxyRoute };

/** The provider a key belongs to. */
export function modelProviderForKey(key: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.key === key);
}

/** The proxied provider a path segment names, or undefined. */
export function modelProviderForSegment(segment: string): ProxiedModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider): provider is ProxiedModelProvider => provider.proxy?.segment === segment);
}

/** One model id segment: never empty, never a dot segment, never percent encoded. */
const ID_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._@-]*";

const compiled = new Map<ModelEndpoint, RegExp>();
function endpointPattern(endpoint: ModelEndpoint): RegExp {
  let pattern = compiled.get(endpoint);
  if (!pattern) {
    const source = endpoint.path
      .split("{id}")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(ID_SEGMENT);
    pattern = new RegExp(`^${source}$`);
    compiled.set(endpoint, pattern);
  }
  return pattern;
}

/**
 * Whether the proxy calls this endpoint for this provider. `path` is
 * the request's path after the provider segment, exactly as the client
 * sent it (still percent encoded, no query); `method` is the request's,
 * or WEBSOCKET for an upgrade.
 */
export function modelEndpointAllowed(route: ModelProxyRoute, method: string, path: string): boolean {
  const asked = method.toUpperCase();
  return route.endpoints.some((endpoint) => endpoint.method === asked && endpointPattern(endpoint).test(path));
}
