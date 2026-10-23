/**
 * The hosts a team adds to its locked down agents' network.
 *
 * One entry is a host name (`registry.npmjs.org`) or a wildcard over a
 * domain's subdomains (`*.example.com`), which is the form Modal's
 * domain allowlist takes. A wildcard must name a registrable domain:
 * `*.com` would open most of the internet, which is the setting turned
 * off. The console and the server read the same rules, so a list the
 * field accepts is the list the route stores.
 */

/** More than this is no longer a lock anybody can read. */
export const MAX_ALLOWED_HOSTS = 100;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * One entry, normalized, or a sentence saying why it was refused.
 *
 * A pasted URL is reduced to its host, so `https://api.example.com/v1`
 * is `api.example.com`. Case and a trailing dot are dropped.
 */
export function parseAllowedHost(raw: string): { host: string } | { error: string } {
  let value = raw.trim().toLowerCase();
  if (!value) return { error: "An entry is empty." };
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) value = value.slice(scheme[0].length);
  value = value.replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");

  const wildcard = value.startsWith("*.");
  const name = wildcard ? value.slice(2) : value;
  if (name.includes("*")) {
    return { error: `${raw.trim()} has a wildcard in the middle. Only a leading *. is allowed, as in *.example.com.` };
  }
  const labels = name.split(".");
  if (!name || labels.some((label) => !LABEL.test(label))) {
    return { error: `${raw.trim()} is not a host name.` };
  }
  if (wildcard && labels.length < 2) {
    return { error: `${raw.trim()} would allow every site under .${name}. Name a domain, as in *.example.com.` };
  }
  return { host: wildcard ? `*.${name}` : name };
}

/**
 * A whole list, deduplicated in the order given, or every refusal.
 * Blank lines are skipped, so a textarea's trailing newline is fine.
 */
export function parseAllowedHosts(entries: readonly string[]): { hosts: string[] } | { errors: string[] } {
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const parsed = parseAllowedHost(entry);
    if ("error" in parsed) errors.push(parsed.error);
    else if (!hosts.includes(parsed.host)) hosts.push(parsed.host);
  }
  if (hosts.length > MAX_ALLOWED_HOSTS) {
    errors.push(`At most ${MAX_ALLOWED_HOSTS} sites can be allowed.`);
  }
  return errors.length > 0 ? { errors } : { hosts };
}
