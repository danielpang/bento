import { and, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { mcpCredentials, mcpServers, member } from "@bento/db";
import type { AppContext } from "../context.js";
import { BENTO_SERVER_ID, handleBentoRpc } from "../mcp/bento-tools.js";
import { credentialHeader } from "../mcp/client.js";
import { resolveGrant, recordGrantUse, type ResolvedGrant } from "../mcp/grants.js";
import { refreshCredential } from "../mcp/refresh.js";
import { safeFetch, SafeFetchRefused, safeFetchPolicy } from "../mcp/safe-fetch.js";

/**
 * The MCP gateway: what agents talk to instead of the real servers.
 *
 * A sandbox holds one run-scoped bearer token and a per-server gateway
 * URL. This route authenticates the token, attaches the organization's
 * (or the acting member's) decrypted credential, and pipes MCP traffic
 * through to the upstream. Real credentials never cross into the
 * sandbox, mid-run disablement takes effect on the next request, and
 * the token dies with the run.
 *
 * Mounted outside the actor and tenant middleware: the caller is an
 * agent process, not a session. Every query filters by hand on the
 * owner pool, and every refusal is the same 404 so a probe learns
 * nothing. Queries happen at setup only; once piping starts no
 * database connection is held (the streams rule).
 */

const BODY_LIMIT = 10 * 1024 * 1024;
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;

/** Request headers that cross to the upstream. Everything else stops here. */
const FORWARD_HEADERS = ["content-type", "accept", "mcp-session-id", "last-event-id", "mcp-protocol-version"];
/** Response headers that cross back to the agent. */
const RETURN_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

/** 30 requests per 10 seconds per grant; an agent's tool calls fit, a loop does not. */
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_MS = 3 / 1000;
const MAX_STREAMS_PER_GRANT = 3;

const buckets = new Map<string, { tokens: number; at: number }>();
const openStreams = new Map<string, number>();

function takeToken(grantId: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(grantId) ?? { tokens: BUCKET_CAPACITY, at: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (now - bucket.at) * BUCKET_REFILL_PER_MS);
  bucket.at = now;
  if (bucket.tokens < 1) {
    buckets.set(grantId, bucket);
    return false;
  }
  bucket.tokens -= 1;
  // A bucket that has refilled to full is indistinguishable from a fresh
  // one, so drop it rather than retain an entry per grant that ever ran.
  // Only a grant still under rate pressure (tokens below full) is kept.
  if (bucket.tokens >= BUCKET_CAPACITY - 1) buckets.delete(grantId);
  else buckets.set(grantId, bucket);
  return true;
}

interface GatewayTarget {
  grant: ResolvedGrant;
  server: typeof mcpServers.$inferSelect;
  /** The stored credential row, or null for auth_type none. */
  credentialRow: typeof mcpCredentials.$inferSelect | null;
  /** The decrypted secret actually attached, so a 401 refresh knows which token failed. */
  attachedSecret: string | null;
  /** Header attached upstream, or null for auth_type none. */
  credential: { name: string; value: string } | null;
}

export function mcpGatewayRoutes(ctx: AppContext) {
  const routes = new Hono();
  const notFound = (c: Context) => c.json({ error: "not found" }, 404);

  /** The run behind the bearer token, or null. Every refusal is a 404. */
  async function grantFor(c: Context): Promise<ResolvedGrant | null> {
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    return resolveGrant(ctx, auth.slice("Bearer ".length).trim());
  }

  /**
   * Bento's own server, answered here rather than proxied anywhere.
   *
   * It reaches this function only when the grant pins it, so a token
   * minted for a run that never attached the card tools cannot call it.
   * Everything else about a gateway request still applies: the rate
   * bucket, the body cap, and the usage counter.
   */
  async function bentoRequest(c: Context): Promise<Response> {
    const grant = await grantFor(c);
    if (!grant || !grant.serverIds.includes(BENTO_SERVER_ID)) return notFound(c);
    if (!takeToken(grant.id)) return c.json({ error: "slow down" }, 429);
    recordGrantUse(ctx, grant.id);
    const body = await readBody(c);
    if (body === null) return c.json({ error: "body too large" }, 413);
    const answer = await handleBentoRpc(ctx, grant, body);
    // 202 with no body is how the transport acknowledges a
    // notification; a JSON body on it would be a protocol error.
    if (answer.body === null) return new Response(null, { status: 202 });
    return c.json(answer.body as Record<string, unknown>, answer.status as 200);
  }

  /**
   * Setup for every gateway request: token, server, credential. All
   * refusals are 404. The per-user branch never falls back to the org
   * row: the codebase's habitual `userId ? eq : isNull` shape would
   * quietly serve org-scoped authority on a grant with no acting user,
   * which is exactly the confusion the credential scope exists to
   * prevent.
   */
  async function resolveTarget(c: Context): Promise<GatewayTarget | null> {
    const grant = await grantFor(c);
    if (!grant) return null;
    const serverId = c.req.param("serverId");
    if (!serverId || !grant.serverIds.includes(serverId)) return null;
    // Bento's own id is in the grant like any other, but it names no
    // row: the routes that serve it answer before this, and the ones
    // that do not (the SSE transport's paths) must refuse rather than
    // ask Postgres to read "bento" as a uuid.
    if (serverId === BENTO_SERVER_ID) return null;

    const [server] = await ctx.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    // Org equality includes local mode's null on both sides.
    if (!server || !server.enabled) return null;
    if ((server.organizationId ?? null) !== (grant.organizationId ?? null)) return null;

    // A personal server belongs to one member: only their runs may
    // reach it, and only their own credential is ever attached. The
    // grant's acting user must be that owner.
    if (server.userId) {
      if (server.userId !== grant.actingUserId) return null;
    }

    if (server.authType === "none") {
      return { grant, server, credentialRow: null, attachedSecret: null, credential: null };
    }

    // Whose credential rides upstream: the owner of a personal server,
    // the acting member for a per-user team server, or the org's shared
    // row. A server that needs a member's credential never falls back to
    // the org row: that would serve org authority where an identity was
    // required.
    const requiresUser =
      server.userId !== null || (server.authType === "oauth" && server.credentialScope === "user");
    const credentialUserId = server.userId ?? grant.actingUserId;
    if (requiresUser && !credentialUserId) return null;
    let row: typeof mcpCredentials.$inferSelect | undefined;
    if (requiresUser && credentialUserId) {
      // Removal from the organization ends the member's credentials
      // serving runs immediately, the same live re-read every route does.
      if (grant.organizationId) {
        const [membership] = await ctx.db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, grant.organizationId), eq(member.userId, credentialUserId)))
          .limit(1);
        if (!membership) return null;
      }
      [row] = await ctx.db
        .select()
        .from(mcpCredentials)
        .where(and(eq(mcpCredentials.serverId, server.id), eq(mcpCredentials.userId, credentialUserId)))
        .limit(1);
    } else {
      [row] = await ctx.db
        .select()
        .from(mcpCredentials)
        .where(and(eq(mcpCredentials.serverId, server.id), isNull(mcpCredentials.userId)))
        .limit(1);
    }
    if (!row) return null;
    let secret: string;
    try {
      secret = ctx.secretBox.decrypt(row.encryptedSecret);
    } catch {
      // A rotated master key reads as "not connected" everywhere else;
      // here that is a 404 like any other missing credential.
      return null;
    }
    // An OAuth access token already past its expiry is refreshed before
    // the request goes out, so a long-lived SSE stream or a GET (which
    // have no after-the-fact 401 retry) start with a live token. A
    // refresh that cannot proceed leaves the stale token in place; the
    // upstream's own 401 then surfaces honestly.
    if (row.kind === "oauth" && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      const fresh = await refreshCredential(ctx, server, row.id, secret, c.req.raw.signal);
      if (fresh) secret = fresh;
    }
    return { grant, server, credentialRow: row, attachedSecret: secret, credential: headerFor(server, secret) };
  }

  function headerFor(server: typeof mcpServers.$inferSelect, secret: string): { name: string; value: string } {
    const headerName = server.authType === "api_key" ? server.apiKeyHeader : "Authorization";
    return credentialHeader(headerName, secret);
  }

  /**
   * On an upstream 401 for an OAuth credential, refresh once and retry.
   * The refresh is serialized across processes by an advisory lock, so
   * concurrent 401s do not each rotate the refresh token. Returns the
   * refreshed target, or null when there is nothing to refresh or the
   * grant is dead (the 401 then passes through).
   */
  async function refreshedTarget(c: Context, target: GatewayTarget): Promise<GatewayTarget | null> {
    const row = target.credentialRow;
    if (!row || row.kind !== "oauth" || !row.encryptedRefreshToken || target.attachedSecret === null) return null;
    const fresh = await refreshCredential(ctx, target.server, row.id, target.attachedSecret, c.req.raw.signal);
    if (!fresh || fresh === target.attachedSecret) return null;
    return { ...target, attachedSecret: fresh, credential: headerFor(target.server, fresh) };
  }

  function upstreamHeaders(c: Context, target: GatewayTarget): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of FORWARD_HEADERS) {
      const value = c.req.header(name);
      if (value) headers[name] = value;
    }
    if (target.credential) headers[target.credential.name] = target.credential.value;
    return headers;
  }

  function passBack(c: Context, upstream: Awaited<ReturnType<typeof safeFetch>>) {
    for (const name of RETURN_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) c.header(name, value);
    }
    c.status(upstream.status as 200);
    return c.body((upstream.body as unknown as ReadableStream) ?? null);
  }

  async function fetchUpstream(c: Context, target: GatewayTarget, url: string, init: { method: string; body?: string }) {
    return safeFetch(
      url,
      {
        method: init.method,
        headers: upstreamHeaders(c, target),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: c.req.raw.signal,
        headersTimeoutMs: UPSTREAM_HEADER_TIMEOUT_MS,
      },
      safeFetchPolicy(ctx.env),
    );
  }

  async function forward(
    c: Context,
    target: GatewayTarget,
    url: string,
    init: { method: string; body?: string },
  ) {
    let upstream;
    try {
      upstream = await fetchUpstream(c, target, url, init);
      // An OAuth access token the upstream rejects gets one refresh and
      // one retry. The body was buffered by the caller, so replaying it
      // is safe. Anything but 401 (including a refreshed-then-still-401)
      // passes straight back.
      if (upstream.status === 401 && init.body !== undefined) {
        const refreshed = await refreshedTarget(c, target);
        if (refreshed) {
          upstream.body?.cancel().catch(() => {});
          upstream = await fetchUpstream(c, refreshed, url, init);
        }
      }
    } catch (err) {
      if (err instanceof SafeFetchRefused) return notFound(c);
      return c.json({ error: "the MCP server did not answer" }, 502);
    }
    return passBack(c, upstream);
  }

  /**
   * Reads the JSON-RPC body, capped while reading. A tool call is small,
   * and content-length is attacker controlled: a chunked request carries
   * none, so trusting it and only checking length after buffering would
   * let an agent stream an unbounded body and OOM the shared process.
   * The cap is enforced against the bytes as they arrive.
   */
  async function readBody(c: Context): Promise<string | null> {
    const body = c.req.raw.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > BODY_LIMIT) {
          reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  // Streamable HTTP: POST carries JSON-RPC, GET opens the
  // server-initiated stream, DELETE ends the session.
  routes.post("/:serverId", async (c) => {
    if (c.req.param("serverId") === BENTO_SERVER_ID) return bentoRequest(c);
    const target = await resolveTarget(c);
    if (!target) return notFound(c);
    if (!takeToken(target.grant.id)) return c.json({ error: "slow down" }, 429);
    recordGrantUse(ctx, target.grant.id);
    const body = await readBody(c);
    if (body === null) return c.json({ error: "body too large" }, 413);
    return forward(c, target, target.server.url, { method: "POST", body });
  });

  routes.get("/:serverId", async (c) => {
    // Bento's own server initiates nothing, so it has no stream to
    // open. 405 is the spec's answer, and a client that hangs waiting
    // for a stream that will never speak is the thing it prevents.
    if (c.req.param("serverId") === BENTO_SERVER_ID) {
      const grant = await grantFor(c);
      if (!grant || !grant.serverIds.includes(BENTO_SERVER_ID)) return notFound(c);
      return c.json({ error: "this server does not open a stream" }, 405);
    }
    const target = await resolveTarget(c);
    if (!target) return notFound(c);
    return withStreamSlot(c, target, () => forward(c, target, target.server.url, { method: "GET" }));
  });

  routes.delete("/:serverId", async (c) => {
    // Nothing to end: the virtual server holds no session, its whole
    // state being the grant, which the run's finish revokes.
    if (c.req.param("serverId") === BENTO_SERVER_ID) {
      const grant = await grantFor(c);
      if (!grant || !grant.serverIds.includes(BENTO_SERVER_ID)) return notFound(c);
      return new Response(null, { status: 204 });
    }
    const target = await resolveTarget(c);
    if (!target) return notFound(c);
    recordGrantUse(ctx, target.grant.id);
    return forward(c, target, target.server.url, { method: "DELETE" });
  });

  /**
   * The older SSE transport: one long stream whose `endpoint` event
   * names where messages POST. The event is rewritten to a relative
   * gateway path (clients resolve it against the stream's own origin,
   * so whatever host the sandbox used keeps working), and it is pinned
   * to the upstream's origin: an upstream answering with an absolute
   * URL somewhere else is trying to steer credentialed POSTs off its
   * own origin, and the stream ends there.
   */
  routes.get("/:serverId/sse", async (c) => {
    const target = await resolveTarget(c);
    if (!target) return notFound(c);
    return withStreamSlot(c, target, async () => {
      let upstream;
      try {
        upstream = await safeFetch(
          target.server.url,
          {
            headers: { ...upstreamHeaders(c, target), accept: "text/event-stream" },
            signal: c.req.raw.signal,
            headersTimeoutMs: UPSTREAM_HEADER_TIMEOUT_MS,
          },
          safeFetchPolicy(ctx.env),
        );
      } catch (err) {
        if (err instanceof SafeFetchRefused) return notFound(c);
        return c.json({ error: "the MCP server did not answer" }, 502);
      }
      if (!upstream.body) return passBack(c, upstream);
      const rewritten = (upstream.body as unknown as ReadableStream<Uint8Array>).pipeThrough(
        endpointRewriter(target.server.id, target.server.url),
      );
      c.header("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
      c.status(upstream.status as 200);
      return c.body(rewritten);
    });
  });

  // The SSE transport's message endpoint: whatever path the upstream
  // named, reconstructed against its own origin and nothing else.
  routes.post("/:serverId/*", async (c) => {
    const target = await resolveTarget(c);
    if (!target) return notFound(c);
    if (!takeToken(target.grant.id)) return c.json({ error: "slow down" }, 429);
    recordGrantUse(ctx, target.grant.id);
    const body = await readBody(c);
    if (body === null) return c.json({ error: "body too large" }, 413);
    const prefix = `/${target.server.id}/`;
    const requestPath = new URL(c.req.url).pathname;
    const inner = requestPath.slice(requestPath.indexOf(prefix) + prefix.length);
    const upstreamOrigin = new URL(target.server.url).origin;
    const search = new URL(c.req.url).search;
    return forward(c, target, `${upstreamOrigin}/${inner}${search}`, { method: "POST", body });
  });

  async function withStreamSlot(
    c: Context,
    target: GatewayTarget,
    open: () => Promise<Response>,
  ): Promise<Response> {
    const open_ = openStreams.get(target.grant.id) ?? 0;
    if (open_ >= MAX_STREAMS_PER_GRANT) return c.json({ error: "too many open streams" }, 429);
    openStreams.set(target.grant.id, open_ + 1);
    recordGrantUse(ctx, target.grant.id);
    const release = () => {
      const now = openStreams.get(target.grant.id) ?? 1;
      if (now <= 1) openStreams.delete(target.grant.id);
      else openStreams.set(target.grant.id, now - 1);
    };
    c.req.raw.signal.addEventListener("abort", release, { once: true });
    try {
      const response = await open();
      // Non-stream answers release now; streams release on disconnect.
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) release();
      return response;
    } catch (err) {
      release();
      throw err;
    }
  }

  return routes;
}

/**
 * Rewrites only the data of `endpoint` events; every other byte passes
 * through untouched. Emits a relative path so the client resolves it
 * against whichever host it reached the gateway on. Exported for tests.
 */
export function endpointRewriter(serverId: string, upstreamUrl: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let inEndpointEvent = false;
  const upstreamOrigin = new URL(upstreamUrl).origin;

  const rewriteLine = (line: string): string | null => {
    // A blank line terminates an SSE event, after which the type resets
    // to the default. Without this reset an endpoint event with no
    // trailing type line would leave inEndpointEvent stuck on, and the
    // next message frame's data (which defaults to a "message" event
    // and carries no event: line) would be rewritten as if it were an
    // endpoint, corrupting the stream.
    if (line === "") {
      inEndpointEvent = false;
      return line;
    }
    if (line.startsWith("event:")) {
      inEndpointEvent = line.slice("event:".length).trim() === "endpoint";
      return line;
    }
    if (!line.startsWith("data:") || !inEndpointEvent) return line;
    const value = line.slice("data:".length).trim();
    let resolved: URL;
    try {
      resolved = new URL(value, upstreamUrl);
    } catch {
      return null; // Unparseable endpoint: drop the event, not the stream.
    }
    if (resolved.origin !== upstreamOrigin) return null;
    const path = resolved.pathname.replace(/^\//, "");
    return `data: /api/mcp-gateway/${serverId}/${path}${resolved.search}`;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const out = rewriteLine(line.replace(/\r$/, ""));
        if (out !== null) controller.enqueue(encoder.encode(`${out}\n`));
      }
    },
    flush(controller) {
      if (buffered) {
        const out = rewriteLine(buffered);
        if (out !== null) controller.enqueue(encoder.encode(out));
      }
    },
  });
}
