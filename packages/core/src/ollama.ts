/**
 * Ollama as a model provider.
 *
 * Bento never runs Ollama itself. A run goes to Ollama Cloud, or to a
 * server the organization points it at with OLLAMA_BASE_URL (a GPU box
 * of its own, a gateway). Three harnesses reach it through an API they
 * already speak: Claude Code over Ollama's Anthropic compatible
 * endpoint, opencode and DeepSeek Harness over its OpenAI compatible
 * one.
 *
 * An agent opts in through its model string, `ollama/<model>`, rather
 * than an organization wide switch, so one Claude Code agent can run on
 * Ollama while every other stays on Anthropic. The prefix is Bento's:
 * adapters strip it before the CLI sees the id.
 */

/** Where a run goes when no OLLAMA_BASE_URL is saved. */
export const OLLAMA_CLOUD_URL = "https://ollama.com";

/** The only credentials an Ollama run is given, whichever tool runs it. */
export const OLLAMA_CREDENTIAL_NAMES = ["OLLAMA_API_KEY", "OLLAMA_BASE_URL"] as const;

const PREFIX = "ollama/";

/** Whether a profile's model string sends the run to Ollama. */
export function isOllamaModel(model: string): boolean {
  return model.startsWith(PREFIX) && model.length > PREFIX.length;
}

/** The id Ollama knows the model by: "gpt-oss:120b" for "ollama/gpt-oss:120b". */
export function ollamaModelId(model: string): string {
  return isOllamaModel(model) ? model.slice(PREFIX.length) : model;
}

/**
 * The server's address, without a trailing slash or /v1, because each
 * harness appends the path of the API it speaks: Claude Code adds
 * /v1/messages itself, while the OpenAI compatible clients are handed
 * /v1. A saved value ending in /v1 is what OpenAI style instructions
 * teach people to paste, so it is accepted rather than doubled.
 */
export function ollamaServerUrl(saved: string | undefined): string {
  const trimmed = (saved ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return trimmed || OLLAMA_CLOUD_URL;
}

/** Whether any Ollama credential was saved or exported. */
export function hasOllamaCredentials(env: Readonly<Record<string, string>>): boolean {
  return Boolean(env.OLLAMA_API_KEY || env.OLLAMA_BASE_URL);
}

/** The Ollama credentials out of a resolved environment, and nothing else. */
export function ollamaCredentialsOnly(env: Readonly<Record<string, string>>): Record<string, string> {
  const only: Record<string, string> = {};
  for (const name of OLLAMA_CREDENTIAL_NAMES) {
    const value = env[name];
    if (value) only[name] = value;
  }
  return only;
}

/** Ollama Cloud needs a key. A server the organization named may not. */
export function missingOllamaCredentials(env: Readonly<Record<string, string>>): string[] {
  return ollamaServerUrl(env.OLLAMA_BASE_URL) === OLLAMA_CLOUD_URL && !env.OLLAMA_API_KEY ? ["OLLAMA_API_KEY"] : [];
}

/**
 * The address a sandbox uses for a saved Ollama server. A Docker sandbox
 * reaches this machine's loopback as host.docker.internal, the same
 * rewrite the MCP gateway gets, so an Ollama server on the machine
 * running Bento works as saved. Every other driver dials it as given.
 */
export function ollamaUrlFromSandbox(saved: string, driver: string): string {
  if (driver !== "docker") return saved;
  return saved.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/, "//host.docker.internal");
}
