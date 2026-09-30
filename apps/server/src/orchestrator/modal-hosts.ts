/**
 * Where an API key goes when the organization has not set a base URL.
 *
 * A restricted sandbox allowlists these or it does not start. A key
 * with no host in this list, and no base URL, is a refusal: opening
 * the network, or starting without the model, both ignore the setting.
 */
const DEFAULT_MODEL_HOSTS: readonly {
  key: string;
  baseUrlKey?: string;
  hosts: readonly string[];
}[] = [
  { key: "ANTHROPIC_API_KEY", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  { key: "ANTHROPIC_AUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  { key: "CLAUDE_CODE_OAUTH_TOKEN", baseUrlKey: "ANTHROPIC_BASE_URL", hosts: ["https://api.anthropic.com"] },
  { key: "OPENAI_API_KEY", baseUrlKey: "OPENAI_BASE_URL", hosts: ["https://api.openai.com"] },
  { key: "OPENROUTER_API_KEY", hosts: ["https://openrouter.ai"] },
  { key: "GEMINI_API_KEY", baseUrlKey: "GOOGLE_GEMINI_BASE_URL", hosts: ["https://generativelanguage.googleapis.com"] },
  { key: "DEEPSEEK_API_KEY", baseUrlKey: "DEEPSEEK_BASE_URL", hosts: ["https://api.deepseek.com"] },
  { key: "POOLSIDE_API_KEY", baseUrlKey: "POOLSIDE_STANDALONE_BASE_URL", hosts: ["https://inference.poolside.ai"] },
  { key: "AI_GATEWAY_API_KEY", hosts: ["https://ai-gateway.vercel.sh"] },
  { key: "OLLAMA_API_KEY", baseUrlKey: "OLLAMA_BASE_URL", hosts: ["https://ollama.com"] },
  {
    key: "CURSOR_API_KEY",
    hosts: ["https://api2.cursor.sh", "https://api5.cursor.sh", "https://agentn.global.api5.cursor.sh"],
  },
  {
    key: "CURSOR_AUTH_TOKEN",
    hosts: ["https://api2.cursor.sh", "https://api5.cursor.sh", "https://agentn.global.api5.cursor.sh"],
  },
  { key: "META_API_KEY", hosts: ["https://api.meta.ai"] },
];

const KNOWN_MODEL_KEYS = new Set(DEFAULT_MODEL_HOSTS.map((entry) => entry.key));

/**
 * Hosts a restricted Modal run is allowed to open.
 *
 * The gateway, each repository's clone URL, every `*_BASE_URL` already
 * resolved for the agent, a custom provider's base URL, and the default
 * host of any API key that has no base URL. Key values are not hosts
 * and are not returned. A key whose host cannot be named throws, so
 * the run fails before a sandbox exists.
 */
export function modalRunHosts(input: {
  gatewayUrl: string | undefined;
  cloneUrls: readonly (string | null | undefined)[];
  env: Readonly<Record<string, string>>;
  customBaseUrl?: string | undefined;
}): string[] {
  const hosts: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) hosts.push(trimmed);
  };
  push(input.gatewayUrl);
  for (const url of input.cloneUrls) push(url);
  for (const [key, value] of Object.entries(input.env)) {
    if (key.endsWith("_BASE_URL")) push(value);
  }
  push(input.customBaseUrl);

  for (const entry of DEFAULT_MODEL_HOSTS) {
    if (!input.env[entry.key]?.trim()) continue;
    if (entry.baseUrlKey && input.env[entry.baseUrlKey]?.trim()) continue;
    for (const host of entry.hosts) push(host);
  }

  for (const [key, value] of Object.entries(input.env)) {
    if (!value?.trim()) continue;
    if (KNOWN_MODEL_KEYS.has(key) || key.endsWith("_BASE_URL")) continue;
    if (!key.endsWith("_API_KEY") && !key.endsWith("_AUTH_TOKEN") && !key.endsWith("_OAUTH_TOKEN")) continue;
    if (input.customBaseUrl?.trim()) continue;
    throw new Error(
      `This organization requires agents to run without open network access, and the model host for ${key} could not be named. The run was not started.`,
    );
  }
  return hosts;
}
