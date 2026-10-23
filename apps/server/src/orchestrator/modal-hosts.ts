import { MODEL_PROVIDERS } from "@bento/core";

/**
 * Where an API key goes when the organization has not set a base URL
 * (see model-providers.ts in @bento/core, which the model proxy and the
 * adapters read too).
 *
 * A restricted sandbox allowlists these or it does not start. A key
 * with no host in this list, and no base URL, is a refusal: opening
 * the network, or starting without the model, both ignore the setting.
 */
const DEFAULT_MODEL_HOSTS = MODEL_PROVIDERS;

const KNOWN_MODEL_KEYS = new Set(DEFAULT_MODEL_HOSTS.map((entry) => entry.key));

/**
 * Hosts a restricted Modal run is allowed to open.
 *
 * The gateway, each repository's clone URL, every `*_BASE_URL` already
 * resolved for the agent, a custom provider's base URL, and the default
 * host of any API key that has no base URL. Key values are not hosts
 * and are not returned. A key whose host cannot be named throws, so
 * the run fails before a sandbox exists.
 *
 * A key the model proxy carries (`proxiedKeys`) needs neither: the
 * sandbox reaches its provider only through the gateway, which is
 * already on the list, and the provider's own host and the base URL
 * the organization saved for it are Bento's to reach, not the
 * sandbox's.
 *
 * MCP servers never appear here, for the same reason: a locked run
 * attaches them through the gateway, which reaches each upstream from
 * Bento's side, so adding a server gives the sandbox no new route out.
 */
export function modalRunHosts(input: {
  gatewayUrl: string | undefined;
  cloneUrls: readonly (string | null | undefined)[];
  env: Readonly<Record<string, string>>;
  customBaseUrl?: string | undefined;
  proxiedKeys?: readonly string[];
}): string[] {
  const hosts: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) hosts.push(trimmed);
  };
  const proxied = new Set(input.proxiedKeys ?? []);
  // A base URL is the proxy's to reach once every key it serves is
  // proxied. One that also serves a key that is not (the Anthropic base
  // URL beside a login token) stays.
  const proxiedOnly = (baseUrlKey: string) => {
    const served = DEFAULT_MODEL_HOSTS.filter((entry) => entry.baseUrlKey === baseUrlKey && input.env[entry.key]?.trim());
    return served.length > 0 && served.every((entry) => proxied.has(entry.key));
  };
  push(input.gatewayUrl);
  for (const url of input.cloneUrls) push(url);
  for (const [key, value] of Object.entries(input.env)) {
    if (key.endsWith("_BASE_URL") && !proxiedOnly(key)) push(value);
  }
  push(input.customBaseUrl);

  for (const entry of DEFAULT_MODEL_HOSTS) {
    if (!input.env[entry.key]?.trim()) continue;
    if (proxied.has(entry.key)) continue;
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
