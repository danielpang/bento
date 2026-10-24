import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import {
  MODEL_PROXY_PATH,
  modelEndpointAllowed,
  modelProviderForSegment,
  type ModelProxyAuth,
  type ProxiedModelProvider,
} from "@bento/core";
import { secrets } from "@bento/db";
import type { AppContext } from "../context.js";
import {
  clearModelProxyFailure,
  hashGrantToken,
  markModelProxyFailed,
  recordGrantUse,
  resolveGrant,
  type ResolvedGrant,
} from "../mcp/grants.js";
import { ModelProxyCache, type CachedGrant, type ProviderCredentials } from "../mcp/model-proxy-cache.js";
import { TokenBuckets } from "../mcp/rate-limit.js";
import { safeFetch, SafeFetchRefused, safeFetchPolicy } from "../mcp/safe-fetch.js";

/**
 * The model proxy: what an agent's model calls go to in multi mode, and
 * in local mode on Docker unless BENTO_MODEL_PROXY is "false".
 *
 * The sandbox holds the run's grant token where a provider key would
 * be, and the proxy's address where the provider's base URL would be
 * (orchestrator/model-proxy-env.ts). Each request is authenticated by
 * that token, checked against the provider keys the grant names and
 * the inference endpoints the provider's entry lists (MODEL_PROVIDERS
 * in @bento/core), and sent to the provider with the organization's
 * real key in place of the token. The key never crosses into the
 * sandbox, and the token dies with the run.
 *
 * Where it goes is decided here and nowhere else: the provider's
 * default upstream, or the base URL the organization saved for it,
 * plus the path and query the client asked for. Nothing in the request
 * names a host. A saved base URL is a tenant-chosen address, so it is
 * fetched through safeFetch, which refuses private addresses and plain
 * http in multi mode; a default upstream is a fixed vendor host. A run
 * whose saved base URL fails that rule is never proxied (it is checked
 * at mint), so the refusal here is for a URL that changed since.
 *
 * Mounted outside the actor and tenant middleware, beside the MCP
 * gateway: the caller is an agent process, not a session. Every query
 * filters by hand, every refusal is the same 404 so a probe learns
 * nothing, and every read happens before the upstream fetch starts, so
 * a stream that runs for minutes holds no database connection (the
 * streams rule). A local server's grant also reads the keys the local
 * user keeps in this process's environment (readCredentials); a multi
 * mode server never does. The grant and its decrypted keys are cached per
 * process for a few minutes (mcp/model-proxy-cache.ts), so a run's
 * calls after its first read nothing at all. The writes are the
 * failure stamp, on Bento's own failure, and clearing it on the next
 * request the provider answers.
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
/**
 * Hop by hop, anything about the connection or the caller rather than
 * the request, and two that fetch must own: `expect`, which undici
 * refuses outright (a client sending 100-continue would fail every
 * request), and `accept-encoding`, so the upstream compresses only in
 * a coding fetch decodes before the body reaches the agent.
 */
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
  "expect",
  "accept-encoding",
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
/** The codings undici's fetch decodes (lib/web/fetch, 8.x); any other is passed through as sent. */
const DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);
/** Statuses fetch gives no body, so nothing was decoded. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** The one answer to every refusal: no token, a dead one, a provider or endpoint it does not cover. */
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

/**
 * What the agent is told when the provider could not be reached or did
 * not answer in time. A 502 with `x-should-retry`, which every client
 * the proxy serves retries. The provider's failure, not Bento's, so
 * nothing is stamped and a run that ends on it is billed like any
 * other provider outage.
 */
const PROVIDER_UNREACHABLE = {
  type: "error",
  error: {
    type: "api_error",
    message: "Bento's model proxy could not reach the model provider. Please try again.",
  },
};

/** One cache per process, made on its first request and fed by the bus. */
const caches = new WeakMap<AppContext, ModelProxyCache>();

/** The cache the routes for this context use. */
export function modelProxyCacheFor(ctx: AppContext): ModelProxyCache {
  let cache = caches.get(ctx);
  if (!cache) {
    const created = new ModelProxyCache();
    // The database announces a run's end and every change to its grant
    // (migration 0068), and a bus that reconnects may have missed some.
    ctx.bus.onGrantChanged((runId) => created.evictRun(runId));
    ctx.bus.onResync(() => created.clear());
    caches.set(ctx, created);
    cache = created;
  }
  return cache;
}

/**
 * What the readiness route answers. A local run asks for it from inside
 * its sandbox before its keys are swapped for a token (see
 * model-proxy-env.ts), and goes on with raw keys when it does not get it.
 */
export const MODEL_PROXY_READY = "bento-model-proxy";

export function modelProxyRoutes(ctx: AppContext) {
  const routes = new Hono();
  // Reads nothing, needs no token, and names no grant or provider: it
  // says only that this address reaches a Bento model proxy.
  routes.get("/", (c) => c.json({ service: MODEL_PROXY_READY }));
  // Made on the first request, so a process (or a test's context) that
  // never serves the proxy never subscribes to the bus for it.
  routes.all("/:provider", (c) => proxy(ctx, modelProxyCacheFor(ctx), c));
  routes.all("/:provider/*", (c) => proxy(ctx, modelProxyCacheFor(ctx), c));
  return routes;
}

async function proxy(ctx: AppContext, cache: ModelProxyCache, c: Context): Promise<Response> {
  const provider = modelProviderForSegment(c.req.param("provider") ?? "");
  if (!provider) return c.json(NOT_FOUND, 404);
  const url = new URL(c.req.url);
  const token = runToken(c.req.raw.headers, url);
  if (!token?.startsWith("bmg_")) return c.json(NOT_FOUND, 404);
  const started = new Date();

  const tokenHash = hashGrantToken(token);
  let cached = cache.get(tokenHash);
  if (!cached) {
    const generation = cache.generation;
    let resolved: ResolvedGrant | null;
    try {
      resolved = await resolveGrant(ctx, token);
    } catch (err) {
      // No grant to stamp: the lookup that would have found it failed.
      console.error(`model proxy could not look up a grant for ${provider.proxy.segment}:`, err);
      return c.json(BENTO_FAILURE, 502);
    }
    if (!resolved) return c.json(NOT_FOUND, 404);
    cached = cache.put(tokenHash, resolved, generation);
  }
  const entry = cached;
  const grant = entry.grant;
  if (!grant.modelCredentials.includes(provider.key)) return c.json(NOT_FOUND, 404);

  try {
    return await forward(ctx, cache, c, { provider, url, grant, entry, started });
  } catch (err) {
    // Anything this code threw rather than the provider failing: Bento's.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    console.error(`model proxy failed a request of grant ${grant.id} to ${provider.proxy.segment}:`, err);
    ctx.analytics?.captureException(err, grant.actingUserId, grant.organizationId, {
      source: "model_proxy",
      provider: provider.proxy.segment,
      run_id: grant.runId,
    });
    await markModelProxyFailed(ctx, grant.id);
    grant.proxyFailed = true;
    return c.json(BENTO_FAILURE, 502);
  }
}

async function forward(
  ctx: AppContext,
  cache: ModelProxyCache,
  c: Context,
  request: { provider: ProxiedModelProvider; url: URL; grant: ResolvedGrant; entry: CachedGrant; started: Date },
): Promise<Response> {
  const { provider, url, grant, entry } = request;
  const segment = provider.proxy.segment;
  const path = pathAfterSegment(url, segment);
  /**
   * Codex opens each turn by asking to upgrade to the Responses API's
   * WebSocket transport, and goes on over plain HTTP when it is told
   * the upgrade is not on offer (426), which is the only answer that
   * makes it fall back (verified on codex-cli 0.163.0: a 400 ended the
   * turn). The proxy speaks HTTP, so that is the answer, after the
   * token and the endpoint were checked like any other request's.
   */
  const upgrade = Boolean(c.req.header("upgrade"));
  const method = c.req.method;
  if (path === null || !modelEndpointAllowed(provider.proxy, upgrade ? "WEBSOCKET" : method, path)) {
    reportRefusedEndpoint(ctx, grant, segment, upgrade ? "WEBSOCKET" : method, path ?? url.pathname);
    return c.json(NOT_FOUND, 404);
  }
  if (!buckets.take(grant.id)) {
    c.header("retry-after", "1");
    return c.json(
      { type: "error", error: { type: "rate_limit_error", message: "Too many model requests from this run through Bento's model proxy." } },
      429,
    );
  }
  recordGrantUse(ctx, grant.id);
  if (upgrade) {
    return c.json(
      { type: "error", error: { type: "upgrade_not_supported", message: "Bento's model proxy speaks HTTP only." } },
      426,
    );
  }

  // The key, and the base URL the organization saved when the grant
  // says the run would have used it: from the cache, or read and
  // decrypted now and kept there for the rest of its life.
  let credentials = entry.credentials.get(provider.key);
  if (!credentials) {
    const generation = cache.generation;
    let read: ProviderCredentials | null;
    try {
      read = await readCredentials(ctx, grant, provider);
    } catch (err) {
      console.error(`model proxy could not read the ${provider.key} of grant ${grant.id}:`, err);
      await markModelProxyFailed(ctx, grant.id);
      grant.proxyFailed = true;
      return c.json(BENTO_FAILURE, 502);
    }
    // Deleted since the run started: the organization withdrew it, which
    // is a refusal like any other, not Bento failing.
    if (!read) return c.json(NOT_FOUND, 404);
    credentials = read;
    cache.putCredentials(entry, provider.key, read, generation);
  }

  const target = upstreamUrl(credentials.savedBase ?? provider.proxy.upstream, url, segment);
  if (!target) return c.json(NOT_FOUND, 404);
  const headers = upstreamHeaders(c.req.raw.headers, provider.proxy.auth, credentials.key);
  const body = method === "GET" || method === "HEAD" ? undefined : (c.req.raw.body ?? undefined);

  let upstream: UndiciResponse;
  try {
    upstream = credentials.savedBase
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
            message: `The base URL saved in ${provider.baseUrlKey ?? "this provider's base URL"} cannot be used: Bento's model proxy sends model requests only to public https addresses.`,
          },
        },
        502,
      );
    }
    // The agent went away; there is nobody to answer and nothing failed.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    if (upstreamUnreachable(err)) {
      // The provider's outage, or its silence past the timeout: billed
      // like any provider failure, and the client is told to try again.
      console.warn(`model proxy could not reach ${segment} for grant ${grant.id}: ${describe(err)}`);
      c.header("x-should-retry", "true");
      return c.json(PROVIDER_UNREACHABLE, 502);
    }
    throw err;
  }

  // The provider answered, so the proxy did its part: a stamp from an
  // earlier request no longer describes this run's model calls.
  if (grant.proxyFailed) {
    await clearModelProxyFailure(ctx, grant.id, request.started);
    grant.proxyFailed = false;
  }
  // A key the provider refuses may have been rotated since it was
  // cached; the next request reads it again.
  if (upstream.status === 401 || upstream.status === 403) entry.credentials.delete(provider.key);
  return passBack(upstream, method);
}

/**
 * The key and saved base URL for one provider, read and decrypted; null
 * when the key was deleted.
 *
 * From the grant's organization's stored secrets, and nowhere else,
 * with one exception: a local server's grant (local mode, no
 * organization) also reads this process's environment, because that is
 * where resolveAgentEnv found the local user's keys, and with the same
 * precedence it uses: a stored secret wins, and the environment's value
 * stands in when there is none (or it cannot be decrypted, which
 * resolveAgentEnv reads as missing too). A multi mode server never
 * reads its environment here, for any grant: those are the operator's
 * keys, and a tenant's run spending them is exactly what the proxy
 * exists to prevent.
 */
async function readCredentials(
  ctx: AppContext,
  grant: ResolvedGrant,
  provider: ProxiedModelProvider,
): Promise<ProviderCredentials | null> {
  const baseUrlKey = provider.baseUrlKey && grant.modelCredentials.includes(provider.baseUrlKey) ? provider.baseUrlKey : null;
  const rows = await ctx.db
    .select({ name: secrets.name, ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(
      and(
        grant.organizationId ? eq(secrets.organizationId, grant.organizationId) : isNull(secrets.organizationId),
        inArray(secrets.name, baseUrlKey ? [provider.key, baseUrlKey] : [provider.key]),
      ),
    );
  const fromEnvironment = localEnvironmentFor(ctx, grant);
  const read = (name: string): string | null => {
    const row = rows.find((candidate) => candidate.name === name);
    const slot = { kind: "org_secret", organizationId: grant.organizationId, name } as const;
    if (!fromEnvironment) return row ? ctx.secretBox.decrypt(row.ciphertext, slot) : null;
    if (row) {
      try {
        return ctx.secretBox.decrypt(row.ciphertext, slot);
      } catch (err) {
        // Missing to resolveAgentEnv as well, so the run started on the
        // environment's value; with none there, it is Bento's failure.
        if (!fromEnvironment[name]) throw err;
      }
    }
    return fromEnvironment[name] || null;
  };
  const key = read(provider.key);
  if (!key) return null;
  const savedBase = baseUrlKey ? read(baseUrlKey)?.trim() || null : null;
  return { key, savedBase };
}

/**
 * The process environment a grant may read its keys from: a local
 * server's own, for a grant with no organization. Null for every other
 * grant, and always null in multi mode.
 */
function localEnvironmentFor(ctx: AppContext, grant: ResolvedGrant): NodeJS.ProcessEnv | null {
  if (ctx.env.BENTO_MODE !== "local" || grant.organizationId !== null) return null;
  return process.env;
}

/**
 * Error tracking hears about every endpoint the proxy refused a live
 * token, so a CLI that starts calling a new one shows up rather than
 * failing quietly. Provider, method and path only, never a query, a
 * header or a body; at most once an hour per endpoint per process.
 */
const REFUSAL_REPORT_INTERVAL_MS = 60 * 60_000;
const reportedRefusals = new Map<string, number>();

class ModelProxyEndpointRefused extends Error {
  override name = "ModelProxyEndpointRefused";
}

function reportRefusedEndpoint(ctx: AppContext, grant: ResolvedGrant, provider: string, method: string, path: string): void {
  const shown = path.length > 200 ? `${path.slice(0, 200)}...` : path;
  const key = `${provider} ${method} ${shown}`;
  const now = Date.now();
  const last = reportedRefusals.get(key);
  if (last !== undefined && now - last < REFUSAL_REPORT_INTERVAL_MS) return;
  if (reportedRefusals.size > 1_000) reportedRefusals.clear();
  reportedRefusals.set(key, now);
  console.warn(`model proxy refused ${method} ${shown} on ${provider}: not an endpoint it calls`);
  ctx.analytics?.captureException(
    new ModelProxyEndpointRefused("The model proxy refused an endpoint outside its allowlist"),
    grant.actingUserId,
    grant.organizationId,
    { source: "model_proxy_endpoint", provider, method, path: shown, run_id: grant.runId },
  );
}

/** For tests: forget which refusals were already reported. */
export function resetRefusalReports(): void {
  reportedRefusals.clear();
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

/** The path the client asked for after the provider segment, as sent; null when it is not under it. */
export function pathAfterSegment(requested: URL, segment: string): string | null {
  const prefix = `${MODEL_PROXY_PATH}/${segment}`;
  if (!requested.pathname.startsWith(prefix)) return null;
  const path = requested.pathname.slice(prefix.length);
  if (path !== "" && !path.startsWith("/")) return null;
  return path;
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
  const path = pathAfterSegment(requested, segment);
  if (path === null) return null;
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
 * Whether fetch decoded this response's body, which it does for a body
 * in codings it knows. When it did, the encoding headers describe bytes
 * the agent never receives and are dropped; when it did not (a coding
 * it does not know, a response with no body), they are true and stay.
 */
export function decodedByFetch(method: string, status: number, contentEncoding: string | null): boolean {
  if (!contentEncoding?.trim() || method === "HEAD" || NULL_BODY_STATUSES.has(status)) return false;
  return contentEncoding
    .toLowerCase()
    .split(",")
    .every((coding) => DECODED_CODINGS.has(coding.trim()));
}

/**
 * The provider's answer as it came, errors included, streamed. Only
 * what belongs to the connection is dropped, and the encoding headers
 * when fetch already decoded the body.
 */
function passBack(upstream: UndiciResponse, method: string): Response {
  const headers = new Headers();
  const decoded = decodedByFetch(method, upstream.status, upstream.headers.get("content-encoding"));
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

/**
 * Whether a fetch failed on the network or the provider's timeouts
 * rather than in this code: undici's "fetch failed" with the socket's
 * error as its cause, or one of its own timeout and socket errors.
 */
function upstreamUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError && err.message === "fetch failed") return true;
  const codeOf = (value: unknown) => (value as { code?: unknown } | null)?.code;
  const code = codeOf(err) ?? codeOf((err as { cause?: unknown }).cause);
  return typeof code === "string" && (code.startsWith("UND_ERR_") || /^E[A-Z_]+$/.test(code));
}

/** An error's message and cause, never a body. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}
