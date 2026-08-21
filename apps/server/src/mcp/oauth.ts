import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safeFetch, SafeFetchRefused, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * OAuth for MCP servers: PKCE, a stateless signed state blob, and the
 * form-encoded token and refresh exchanges.
 *
 * The state carries the PKCE verifier encrypted so the whole flow needs
 * no server-side row between authorize and callback, the way the Slack
 * install flow stays stateless. The HMAC is keyed the same way Slack's
 * is (BENTO_SECRET_KEY, or BETTER_AUTH_SECRET as a fallback).
 */

const STATE_TTL_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 15_000;

export interface OAuthState {
  userId: string;
  organizationId: string | null;
  serverId: string;
  scope: "org" | "user";
  /** SecretBox ciphertext of the PKCE verifier; decrypted only in the callback. */
  verifierEnc: string;
  expiresAt: number;
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function signState(payload: OAuthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyState(value: string | undefined, secret: string): OAuthState | null {
  if (!value) return null;
  const [body, provided] = value.split(".");
  if (!body || !provided) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(provided, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthState>;
    if (
      typeof parsed.userId === "string" &&
      (parsed.organizationId === null || typeof parsed.organizationId === "string") &&
      typeof parsed.serverId === "string" &&
      (parsed.scope === "org" || parsed.scope === "user") &&
      typeof parsed.verifierEnc === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as OAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

export function stateExpiry(): number {
  return Date.now() + STATE_TTL_MS;
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** RFC 8707 resource indicator: the MCP server the token is for. */
  resource: string;
  scope?: string | null;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface ExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  resource: string;
}

/** Authorization code for tokens. Form encoded, never JSON. */
export async function exchangeCode(input: ExchangeInput, policy: SafeFetchPolicy): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });
  if (input.clientSecret) form.set("client_secret", input.clientSecret);
  return postToken(input.tokenEndpoint, form, policy);
}

export interface RefreshInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  resource: string;
}

/** Refresh token for a new access token; the endpoint may rotate the refresh token. */
export async function refreshTokens(input: RefreshInput, policy: SafeFetchPolicy): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
  });
  if (input.clientSecret) form.set("client_secret", input.clientSecret);
  return postToken(input.tokenEndpoint, form, policy);
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** True when the provider says the grant is dead, so retrying is pointless. */
    readonly invalidGrant: boolean,
  ) {
    super(message);
  }
}

async function postToken(endpoint: string, form: URLSearchParams, policy: SafeFetchPolicy): Promise<TokenResponse> {
  let response;
  try {
    response = await safeFetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
        headersTimeoutMs: TOKEN_TIMEOUT_MS,
      },
      policy,
    );
  } catch (err) {
    if (err instanceof SafeFetchRefused) throw new OAuthError(err.message, false);
    throw new OAuthError("the token endpoint did not answer", false);
  }
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthError(`the token endpoint answered ${response.status} with non-JSON`, false);
  }
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http ${response.status}`;
    throw new OAuthError(`the token endpoint refused: ${code}`, code === "invalid_grant");
  }
  const accessToken = body.access_token;
  if (typeof accessToken !== "string") throw new OAuthError("the token endpoint returned no access token", false);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    // A small margin, so the gateway refreshes before the real expiry.
    expiresAt: expiresIn !== null ? new Date(Date.now() + Math.max(0, expiresIn - 30) * 1000) : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}
