/**
 * Hosts a restricted Modal run is allowed to open.
 *
 * The gateway, each repository's clone URL, every `*_BASE_URL` already
 * resolved for the agent, and a custom provider's base URL. API keys
 * are not hosts and are not read. The driver turns these into domain
 * names and refuses the run when one cannot be named.
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
  return hosts;
}
