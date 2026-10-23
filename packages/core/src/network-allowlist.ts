/**
 * The hosts a team adds to its locked down agents' network.
 *
 * One entry is a host name (`registry.npmjs.org`) or a wildcard over a
 * domain's subdomains (`*.example.com`), which is the form Modal's
 * domain allowlist takes. A wildcard must name a registrable domain:
 * `*.com` would open most of the internet, which is the setting turned
 * off. The console and the server read the same rules. Only the server
 * also refuses a wildcard over a multi part public suffix (`*.co.uk`,
 * `*.github.io`): that needs the public suffix list, which is too large
 * for the console's bundle, so the console hears it from the route.
 */

export interface AllowedHostOptions {
  /** True when `name` is a public suffix anyone can register under. */
  isPublicSuffix?: (name: string) => boolean;
}

/** More than this is no longer a lock anybody can read. */
export const MAX_ALLOWED_HOSTS = 100;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * One entry, normalized, or a sentence saying why it was refused.
 *
 * A pasted URL is reduced to its host, so `https://api.example.com/v1`
 * is `api.example.com`. Case and a trailing dot are dropped.
 */
export function parseAllowedHost(
  raw: string,
  options: AllowedHostOptions = {},
): { host: string } | { error: string } {
  let value = raw.trim().toLowerCase();
  if (!value) return { error: "An entry is empty." };
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) value = value.slice(scheme[0].length);
  value = value.replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");

  const wildcard = value.startsWith("*.");
  const name = wildcard ? value.slice(2) : value;
  if (name.includes("*")) {
    return { error: `${raw.trim()}: a wildcard can only lead, as in *.example.com.` };
  }
  const labels = name.split(".");
  if (!name || labels.some((label) => !LABEL.test(label))) {
    return { error: `${raw.trim()} is not a host name.` };
  }
  if (wildcard && (labels.length < 2 || options.isPublicSuffix?.(name))) {
    return { error: `${raw.trim()} is too broad. Use a domain, as in *.example.com.` };
  }
  return { host: wildcard ? `*.${name}` : name };
}

/**
 * A whole list, deduplicated in the order given, or every refusal.
 * Blank lines are skipped, so a textarea's trailing newline is fine.
 */
export function parseAllowedHosts(
  entries: readonly string[],
  options: AllowedHostOptions = {},
): { hosts: string[] } | { errors: string[] } {
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const parsed = parseAllowedHost(entry, options);
    if ("error" in parsed) errors.push(parsed.error);
    else if (!hosts.includes(parsed.host)) hosts.push(parsed.host);
  }
  if (hosts.length > MAX_ALLOWED_HOSTS) {
    errors.push(`At most ${MAX_ALLOWED_HOSTS} sites.`);
  }
  return errors.length > 0 ? { errors } : { hosts };
}
