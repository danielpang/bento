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

export function requestOrigin(c: Context, fallback: string): string {
  const fallbackOrigin = fallback.replace(/\/$/, "");
  const url = new URL(c.req.url);
  const hostHeader = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]!.trim();
  const protoHeader = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim();
  const host = hostHeader || url.host;
  const proto = protoHeader || url.protocol.replace(":", "") || "http";
  if (proto !== "http" && proto !== "https") return fallbackOrigin;
  if (!host || /[\s/]/.test(host)) return fallbackOrigin;
  return `${proto}://${host}`;
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
