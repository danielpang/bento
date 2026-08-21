import { safeFetch, SafeFetchRefused, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * OAuth server discovery for an MCP server URL.
 *
 * The MCP authorization spec chains three documents: the MCP server
 * names its authorization server via RFC 9728 protected resource
 * metadata (pointed to by the WWW-Authenticate header on a 401, or at a
 * well-known path), that names the authorization server, and RFC 8414
 * metadata on the authorization server gives the endpoints. When no
 * client is pre-registered, RFC 7591 dynamic registration mints one.
 */

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  issuer: string;
  /** RFC 9207: whether the AS returns an iss on the authorization response. */
  issParameterSupported: boolean;
  scopesSupported: string | null;
  /** RFC 8707 resource indicator for this MCP server. */
  resource: string;
}

export class DiscoveryError extends Error {}

export async function discoverOAuth(serverUrl: string, policy: SafeFetchPolicy): Promise<DiscoveredEndpoints> {
  const resourceMetadataUrl = await findResourceMetadataUrl(serverUrl, policy);
  const authServer = resourceMetadataUrl
    ? await readResourceMetadata(resourceMetadataUrl, policy)
    : new URL(serverUrl).origin;

  const metadata = await readAuthServerMetadata(authServer, policy);
  const authorizationEndpoint = str(metadata.authorization_endpoint);
  const tokenEndpoint = str(metadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new DiscoveryError("the authorization server metadata is missing its endpoints");
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(metadata.registration_endpoint),
    issuer: str(metadata.issuer) ?? authServer,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    scopesSupported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.join(" ") : null,
    resource: serverUrl,
  };
}

/**
 * The MCP server's 401 names its resource metadata in a WWW-Authenticate
 * header (RFC 9728). Falls back to the well-known path on the server's
 * own origin when there is no header.
 */
async function findResourceMetadataUrl(serverUrl: string, policy: SafeFetchPolicy): Promise<string | null> {
  try {
    const probe = await safeFetch(
      serverUrl,
      { method: "GET", headers: { accept: "application/json" }, headersTimeoutMs: DISCOVERY_TIMEOUT_MS },
      policy,
    );
    probe.body?.cancel().catch(() => {});
    const header = probe.headers.get("www-authenticate");
    const fromHeader = header ? parseResourceMetadata(header) : null;
    if (fromHeader) return fromHeader;
  } catch (err) {
    if (err instanceof SafeFetchRefused) throw new DiscoveryError(err.message);
    // A server that would not answer the probe may still publish the
    // well-known document; fall through.
  }
  // No challenge: probe the well-known PRM, path-aware first (RFC 9728).
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, "");
  for (const candidate of [
    path ? `${url.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]) {
    if (!candidate) continue;
    try {
      await readJson(candidate, policy);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** Pulls the resource_metadata URL out of a Bearer challenge. */
export function parseResourceMetadata(header: string): string | null {
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match ? match[1]! : null;
}

async function readResourceMetadata(url: string, policy: SafeFetchPolicy): Promise<string> {
  const doc = await readJson(url, policy);
  const servers = doc.authorization_servers;
  if (Array.isArray(servers) && typeof servers[0] === "string") return servers[0];
  throw new DiscoveryError("the protected resource metadata names no authorization server");
}

/**
 * RFC 8414 metadata, trying the path-aware well-known location first,
 * then the OpenID Connect location, both derived from the issuer.
 */
async function readAuthServerMetadata(
  authServer: string,
  policy: SafeFetchPolicy,
): Promise<Record<string, unknown>> {
  const issuer = new URL(authServer);
  const path = issuer.pathname.replace(/\/$/, "");
  const candidates = [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}${path}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const doc = await readJson(candidate, policy);
      // RFC 8414: the document's issuer must match, string-identical,
      // the issuer we built the URL from. A metadata document that
      // claims a different issuer is not to be trusted.
      const claimed = str(doc.issuer);
      if (claimed && claimed !== authServer) {
        throw new DiscoveryError("the authorization server metadata claims a different issuer");
      }
      return doc;
    } catch (err) {
      if (err instanceof DiscoveryError && /different issuer/.test(err.message)) throw err;
      lastError = err;
    }
  }
  throw new DiscoveryError(
    `could not read the authorization server metadata: ${lastError instanceof Error ? lastError.message : "not found"}`,
  );
}

export interface RegistrationResult {
  clientId: string;
  clientSecret: string | null;
}

/**
 * RFC 7591 dynamic client registration. Bento registers a public client
 * that authenticates with PKCE (token_endpoint_auth_method "none"), so
 * there is usually no client secret to store.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  policy: SafeFetchPolicy,
): Promise<RegistrationResult> {
  let response;
  try {
    response = await safeFetch(
      registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Bento",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        headersTimeoutMs: DISCOVERY_TIMEOUT_MS,
      },
      policy,
    );
  } catch (err) {
    if (err instanceof SafeFetchRefused) throw new DiscoveryError(err.message);
    throw new DiscoveryError("the registration endpoint did not answer");
  }
  const text = await response.text();
  if (!response.ok) throw new DiscoveryError(`dynamic client registration failed (${response.status})`);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DiscoveryError("dynamic client registration returned non-JSON");
  }
  const clientId = str(body.client_id);
  if (!clientId) throw new DiscoveryError("dynamic client registration returned no client id");
  return { clientId, clientSecret: str(body.client_secret) };
}

async function readJson(url: string, policy: SafeFetchPolicy): Promise<Record<string, unknown>> {
  const response = await safeFetch(
    url,
    { method: "GET", headers: { accept: "application/json" }, headersTimeoutMs: DISCOVERY_TIMEOUT_MS },
    policy,
  );
  const text = await response.text();
  if (!response.ok) throw new DiscoveryError(`fetching ${url} answered ${response.status}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DiscoveryError(`fetching ${url} returned non-JSON`);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
