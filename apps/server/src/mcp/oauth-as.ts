import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/**
 * Helpers for Bento as an MCP authorization server: the origin the
 * client typed, PKCE, and which redirect URIs a desktop host may
 * register. The routes own storage and HTTP; this file is the bits
 * that must not drift between authorize, consent, and token.
 */

/** The grant lives until disconnect. Clients that require expires_in get a long number. */
export const ACCESS_TOKEN_EXPIRES_IN = 315_360_000;

export const AUTH_TTL_MS = 10 * 60_000;

/**
 * The origin this deployment answers on, for the issuer, the resource
 * identifier, the resource-metadata pointer and the consent redirect.
 *
 * Configuration decides, not the caller. This used to prefer
 * X-Forwarded-Host (then Host) over BETTER_AUTH_URL, which made it the
 * one origin in the server a request header could choose: a forged Host
 * put an attacker's hostname into the 401's resource_metadata pointer
 * and into the authorization and token endpoints a client discovers
 * from it, which is a redirect to somewhere else wearing Bento's name.
 *
 * Headers still get a say, because a deployment legitimately answers on
 * more than one name and local development answers on a port the Host
 * header drops. They only get to select among origins the operator has
 * already named: BETTER_AUTH_URL and BENTO_TRUSTED_ORIGINS. Anything
 * else falls back to the configured URL rather than being honoured.
 */
export interface OriginConfig {
  BETTER_AUTH_URL: string;
  BENTO_TRUSTED_ORIGINS: string[];
}

export function requestOrigin(c: Context, env: OriginConfig): string {
  const stripSlash = (value: string) => value.replace(/\/$/, "");
  const configured = stripSlash(env.BETTER_AUTH_URL);
  const claimed = claimedOrigin(c, configured);
  if (!claimed) return configured;

  const allowed = new Set([configured, ...env.BENTO_TRUSTED_ORIGINS.map(stripSlash)]);
  return allowed.has(claimed) ? claimed : configured;
}

/** The origin the request says it reached, before it is checked. */
function claimedOrigin(c: Context, configured: string): string | null {
  let url: URL;
  try {
    url = new URL(c.req.url);
  } catch {
    return null;
  }
  const hostHeader = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]!.trim();
  const protoHeader = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim();
  let host = hostHeader || url.host;
  const proto = protoHeader || url.protocol.replace(":", "") || "http";
  if (proto !== "http" && proto !== "https") return null;
  if (!host || /[\s/]/.test(host)) return null;
  // Fetch and Hono's app.request often send Host without a port even
  // when the URL has one. Keep the URL's port so local /mcp OAuth
  // metadata is not issued for http://localhost/mcp.
  if (!host.includes(":") && url.port && url.hostname === host.split(":")[0]) {
    host = url.host;
  }
  const origin = `${proto}://${host}`;
  try {
    const built = new URL(origin);
    const known = new URL(configured);
    // Relative app.request paths also lose the listen port. If the
    // hostname still matches the public URL, take that URL's port.
    if (!built.port && known.port && built.hostname === known.hostname && built.protocol === known.protocol) {
      return configured;
    }
  } catch {
    return origin;
  }
  return origin;
}

export function canonicalResource(origin: string): string {
  return `${origin.replace(/\/$/, "")}/mcp`;
}

export function resourceAllowed(requested: string | undefined, origin: string): boolean {
  if (!requested) return true;
  const stripped = requested.replace(/\/$/, "");
  const base = origin.replace(/\/$/, "");
  return stripped === `${base}/mcp` || stripped === `${base}/api/mcp-server`;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(pkceChallenge(verifier), "utf8");
  const expected = Buffer.from(challenge, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "about:", "blob:", "vbscript:"]);

/**
 * Redirect URIs a dynamically registered client may use. HTTPS everywhere,
 * loopback HTTP for CLI hosts, and custom schemes for desktop apps
 * (Cursor's cursor:// callback, VS Code, and similar).
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (!uri || uri.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_SCHEMES.has(protocol)) return false;
  if (protocol === "https:") return true;
  if (protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(protocol);
}

export function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function oauthErrorRedirect(redirectUri: string, error: string, state: string | null | undefined, iss: string): string {
  return clientRedirect(redirectUri, {
    error,
    ...(state ? { state } : {}),
    iss,
  });
}
