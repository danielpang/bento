import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import { secrets } from "@bento/db";
import type { AppContext } from "../context.js";
import { markModelProxyFailed, recordGrantUse, resolveGrant, type ResolvedGrant } from "../mcp/grants.js";
import { TokenBuckets } from "../mcp/rate-limit.js";
import { safeFetch, SafeFetchRefused, safeFetchPolicy } from "../mcp/safe-fetch.js";
import { MODEL_PROXY_PATH, modelProviderForSegment, type ModelProxyAuth } from "../orchestrator/model-providers.js";

/**
 * The model proxy: what an agent's model calls go to in multi mode.
 *
 * The sandbox holds the run's grant token where a provider key would
 * be, and the proxy's address where the provider's base URL would be
 * (orchestrator/model-proxy-env.ts). Each request is authenticated by
 * that token, checked against the provider keys the grant names, and
 * sent to the provider with the organization's real key in place of
 * the token. The key never crosses into the sandbox, and the token dies
 * with the run.
 *
 * Where it goes is decided here and nowhere else: the provider's
 * default upstream, or the base URL the organization saved for it,
 * plus the path and query the client asked for. Nothing in the request
 * names a host. A saved base URL is a tenant-chosen address, so it is
 * fetched through safeFetch, which refuses private addresses and plain
 * http in multi mode; a default upstream is a fixed vendor host.
 *
 * Mounted outside the actor and tenant middleware, beside the MCP
 * gateway: the caller is an agent process, not a session. Every query
 * filters by hand, every refusal is the same 404 so a probe learns
 * nothing, and every query happens before the upstream fetch starts,
 * so a stream that runs for minutes holds no database connection (the
 * streams rule). The one write after it is the failure stamp, when the
 * fetch itself failed and there is no stream.
 *
 * Bodies pass through untouched in both directions, as they arrive:
 * a streamed completion reaches the agent chunk by chunk. Nothing here
 * logs a body.
 */

/** Generous for one agent and its subagents; a runaway loop is what it stops. */
const buckets = new TokenBuckets({ capacity: 120, refillPerMs: 4 / 1000 });

/** A non-streamed completion can think for minutes before its headers. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 10 * 60_000;
/** And a streamed one can pause between events for a while. */
const UPSTREAM_BODY_TIMEOUT_MS = 10 * 60_000;

type UndiciBody = NonNullable<NonNullable<Parameters<typeof undiciFetch>[1]>["body"]>;

/** One keep-alive pool for the fixed vendor hosts. */
const vendorDispatcher = new Agent({
  headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
});

/** Where a client may put the key it was given, which is the run token here. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "proxy-authorization"];
/** Hop by hop, and anything about the connection or the caller rather than the request. */
const DROPPED_REQUEST_HEADERS = new Set([
  ...CREDENTIAL_HEADERS,
  "host",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "via",
  "x-real-ip",
]);
const DROPPED_REQUEST_PREFIXES = ["x-forwarded-", "fly-", "cf-"];
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The one answer to every refusal: no token, a dead one, a provider it does not cover. */
const NOT_FOUND = { error: "not found" };

/** What the agent is told when Bento, rather than the provider, failed the request. */
const BENTO_FAILURE = {
  type: "error",
  error: {
    type: "bento_model_proxy_error",
    message:
      "Bento's model proxy could not complete this request. This is a Bento failure, and a run that ends because of it is not billed.",
  },
};

export function modelProxyRoutes(ctx: AppContext) {
  const routes = new Hono();
  routes.all("/:provider", (c) => proxy(ctx, c));
  routes.all("/:provider/*", (c) => proxy(ctx, c));
  return routes;
}

async function proxy(ctx: AppContext, c: Context): Promise<Response> {
  const provider = modelProviderForSegment(c.req.param("provider") ?? "");
  if (!provider) return c.json(NOT_FOUND, 404);
  const url = new URL(c.req.url);
  const token = runToken(c.req.raw.headers, url);
  if (!token) return c.json(NOT_FOUND, 404);

  let grant: ResolvedGrant | null;
  try {
    grant = await resolveGrant(ctx, token);
  } catch (err) {
    // No grant to stamp: the lookup that would have found it failed.
    console.error(`model proxy could not look up a grant for ${provider.proxy.segment}:`, err);
    return c.json(BENTO_FAILURE, 502);
  }
  if (!grant || !grant.modelCredentials.includes(provider.key)) return c.json(NOT_FOUND, 404);
  if (!buckets.take(grant.id)) {
    c.header("retry-after", "1");
    return c.json(
      { type: "error", error: { type: "rate_limit_error", message: "Too many model requests from this run through Bento's model proxy." } },
      429,
    );
  }
  recordGrantUse(ctx, grant.id);
  /**
   * Codex opens each turn by asking to upgrade to the Responses API's
   * WebSocket transport, and goes on over plain HTTP when it is told
   * the upgrade is not on offer (426), which is the only answer that
   * makes it fall back (verified on codex-cli 0.163.0: a 400 ended the
   * turn). The proxy speaks HTTP, so that is the answer, after the
   * token was checked like any other request's.
   */
  if (c.req.header("upgrade")) {
    return c.json(
      { type: "error", error: { type: "upgrade_not_supported", message: "Bento's model proxy speaks HTTP only." } },
      426,
    );
  }

  // The key, and the base URL the organization saved when the grant
  // says the run would have used it. Read now, not at mint, so a key
  // rotated mid-run is the one that goes out.
  const baseUrlKey = provider.baseUrlKey && grant.modelCredentials.includes(provider.baseUrlKey) ? provider.baseUrlKey : null;
  let key: string;
  let savedBase: string | null = null;
  try {
    const rows = await ctx.db
      .select({ name: secrets.name, ciphertext: secrets.ciphertext })
      .from(secrets)
      .where(
        and(
          grant.organizationId ? eq(secrets.organizationId, grant.organizationId) : isNull(secrets.organizationId),
          inArray(secrets.name, baseUrlKey ? [provider.key, baseUrlKey] : [provider.key]),
        ),
      );
    const keyRow = rows.find((row) => row.name === provider.key);
    // Deleted since the run started: the organization withdrew it, which
    // is a refusal like any other, not Bento failing.
    if (!keyRow) return c.json(NOT_FOUND, 404);
    key = ctx.secretBox.decrypt(keyRow.ciphertext);
    const baseRow = baseUrlKey ? rows.find((row) => row.name === baseUrlKey) : undefined;
    if (baseRow) savedBase = ctx.secretBox.decrypt(baseRow.ciphertext).trim() || null;
  } catch (err) {
    console.error(`model proxy could not read the ${provider.key} of grant ${grant.id}:`, err);
    await markModelProxyFailed(ctx, grant.id);
    return c.json(BENTO_FAILURE, 502);
  }

  const target = upstreamUrl(savedBase ?? provider.proxy.upstream, url, provider.proxy.segment);
  if (!target) return c.json(NOT_FOUND, 404);
  const headers = upstreamHeaders(c.req.raw.headers, provider.proxy.auth, key);
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : (c.req.raw.body ?? undefined);

  let upstream: UndiciResponse;
  try {
    upstream = savedBase
      ? await safeFetch(
          target,
          {
            method,
            headers,
            ...(body ? { body: body as ReadableStream<Uint8Array> } : {}),
            signal: c.req.raw.signal,
            headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS,
            bodyTimeoutMs: UPSTREAM_BODY_TIMEOUT_MS,
            redirects: "return",
          },
          safeFetchPolicy(ctx.env),
        )
      : await undiciFetch(target, {
          method,
          headers,
          ...(body ? { body: body as unknown as UndiciBody, duplex: "half" as const } : {}),
          signal: c.req.raw.signal,
          dispatcher: vendorDispatcher,
          redirect: "manual",
        });
  } catch (err) {
    if (err instanceof SafeFetchRefused) {
      // The organization's own base URL is not one Bento will fetch.
      // Its setting, not Bento failing, so nothing is stamped.
      return c.json(
        {
          type: "error",
          error: {
            type: "model_proxy_upstream_refused",
            message: `The base URL saved for ${provider.key} cannot be used: ${err.message}. Bento sends model requests only to public https addresses.`,
          },
        },
        502,
      );
    }
    // The agent went away; there is nobody to answer and nothing failed.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    console.error(`model proxy could not reach ${provider.proxy.segment} for grant ${grant.id}: ${describe(err)}`);
    await markModelProxyFailed(ctx, grant.id);
    return c.json(BENTO_FAILURE, 502);
  }
  return passBack(upstream);
}

/**
 * The run token, from wherever this provider's client puts its key:
 * Authorization Bearer (OpenAI and everything shaped like it), x-api-key
 * (Anthropic), x-goog-api-key or the `key` query parameter (Gemini).
 * Any of them for any provider, since the token is checked either way
 * and which header a CLI uses is its business; all of them are removed
 * before the request goes on.
 */
export function runToken(headers: Headers, url: URL): string | null {
  const bearer = headers.get("authorization");
  const candidates = [
    bearer && /^bearer\s+/i.test(bearer) ? bearer.replace(/^bearer\s+/i, "") : null,
    headers.get("x-api-key"),
    headers.get("x-goog-api-key"),
    url.searchParams.get("key"),
  ];
  const present = candidates.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  // A client that also sends some other credential beside the token
  // (a placeholder key it was configured with) is still recognized.
  return present.find((value) => value.startsWith("bmg_")) ?? present[0] ?? null;
}

/**
 * The upstream address: the base, then the path the client asked for
 * after the provider segment, then its query without a `key`. Null when
 * the result would leave the base's origin, which a path cannot do
 * once appended, but which is checked rather than assumed.
 */
export function upstreamUrl(base: string, requested: URL, segment: string): string | null {
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  const prefix = `${MODEL_PROXY_PATH}/${segment}`;
  const path = requested.pathname.startsWith(prefix) ? requested.pathname.slice(prefix.length) : null;
  if (path === null || (path !== "" && !path.startsWith("/"))) return null;
  const query = new URLSearchParams(requested.search);
  query.delete("key");
  const search = query.toString();
  let target: URL;
  try {
    target = new URL(`${base.replace(/\/+$/, "")}${path}${search ? `?${search}` : ""}`);
  } catch {
    return null;
  }
  if (target.origin !== baseUrl.origin) return null;
  return target.toString();
}

/** Every request header but credentials, cookies, hop by hop and the caller's, plus the real key. */
export function upstreamHeaders(inbound: Headers, auth: ModelProxyAuth, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  inbound.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower)) return;
    if (DROPPED_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix))) return;
    out[lower] = value;
  });
  if (auth === "x-api-key") out["x-api-key"] = key;
  else if (auth === "x-goog-api-key") out["x-goog-api-key"] = key;
  else out.authorization = `Bearer ${key}`;
  return out;
}

/**
 * The provider's answer as it came, errors included, streamed. Only
 * what belongs to the connection is dropped, and the encoding headers
 * when fetch already decoded the body, since they would describe bytes
 * the agent never receives.
 */
function passBack(upstream: UndiciResponse): Response {
  const headers = new Headers();
  const decoded = upstream.headers.has("content-encoding");
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower)) return;
    if (decoded && (lower === "content-encoding" || lower === "content-length")) return;
    headers.append(lower, value);
  });
  // A redirect goes back as it came, without a body: safeFetch has
  // already cancelled it, and Bento never follows one off the host.
  const redirect = upstream.status >= 300 && upstream.status < 400;
  const empty = upstream.status === 204 || redirect || !upstream.body;
  return new Response(empty ? null : (upstream.body as unknown as ReadableStream<Uint8Array>), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** An error's message and cause, never a body. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}
