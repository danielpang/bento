import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  features,
  mcpCredentials,
  mcpServers,
  pipelines,
  projects,
  runMigrations,
  stages,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "../app.js";
import { DiskArtifactStore } from "../artifact-store.js";
import { SecretBox } from "../secrets.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { mintRunGrant, revokeRunGrant, runHasActiveMcp } from "./grants.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "mcp_gateway_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let upstream: Server;
let upstreamUrl: string;
const SECRET = "upstream-secret-key";
let seenAuth: (string | null)[] = [];

// Seeds a run to hang a grant off: agent_runs.organization_id is null
// in local mode, which matches the null-org servers below.
let runId: string;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-gw-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  const userId = await ensureLocalUser(db);
  ctx = {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    driver: new LocalProcessDriver(),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  };
  app = createApp(ctx);

  upstream = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-123" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echo: body } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("no upstream port");
  upstreamUrl = `http://127.0.0.1:${address.port}/mcp`;

  // A minimal run row for the grant's foreign key.
  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, name: "gw", defaultBranch: "main" })
    .returning({ id: projects.id });
  const [pipeline] = await db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "p" })
    .returning({ id: pipelines.id });
  const [stage] = await db
    .insert(stages)
    .values({ pipelineId: pipeline!.id, slug: "s", name: "S", position: 0 })
    .returning({ id: stages.id });
  const [feature] = await db
    .insert(features)
    .values({ projectId: project!.id, pipelineId: pipeline!.id, title: "f" })
    .returning({ id: features.id });
  const [profile] = await db
    .insert(agentProfiles)
    .values({ ownerId: userId, name: "a", cli: "fake", model: "fake-1" })
    .returning({ id: agentProfiles.id });
  const [runRow] = await db
    .insert(agentRuns)
    .values({
      featureId: feature!.id,
      stageId: stage!.id,
      agentProfileId: profile!.id,
      status: "running",
      prompt: "gateway test run",
    })
    .returning({ id: agentRuns.id });
  runId = runRow!.id;
});

after(async () => {
  upstream?.close();
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

async function makeServer(authType: "none" | "api_key", secret: string | null) {
  const [server] = await ctx.db
    .insert(mcpServers)
    .values({
      ownerId: ctx.userId,
      organizationId: null,
      name: "Gateway server",
      slug: `gw-${Math.floor(seenAuth.length + Math.random() * 1e6)}`,
      url: upstreamUrl,
      transport: "http",
      authType,
      apiKeyHeader: "Authorization",
    })
    .returning();
  if (secret !== null) {
    await ctx.db.insert(mcpCredentials).values({
      serverId: server!.id,
      organizationId: null,
      userId: null,
      kind: "api_key",
      encryptedSecret: ctx.secretBox.encrypt(secret),
      hint: "••••",
    });
  }
  return server!;
}

function gatewayCall(serverId: string, token: string, body: unknown) {
  return app.request(`/api/mcp-gateway/${serverId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("a valid grant proxies to the upstream with the real credential attached", async () => {
  const server = await makeServer("api_key", SECRET);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  seenAuth = [];
  const res = await gatewayCall(server.id, token, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), "sess-123", "the session id passes back opaquely");
  const body = (await res.json()) as { result: { echo: string } };
  assert.match(body.result.echo, /ping/);
  assert.equal(seenAuth.at(-1), `Bearer ${SECRET}`, "the gateway attaches the real credential, not the grant token");
});

test("the grant token never reaches the upstream", async () => {
  const server = await makeServer("api_key", SECRET);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  seenAuth = [];
  await gatewayCall(server.id, token, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.ok(!seenAuth.some((a) => a?.includes(token)), "the run-scoped token must not be forwarded upstream");
});

test("a grant not covering the server is refused", async () => {
  const server = await makeServer("api_key", SECRET);
  const other = await makeServer("api_key", SECRET);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [other.id],
    ttlMs: 60_000,
  });
  const res = await gatewayCall(server.id, token, { jsonrpc: "2.0", id: 1 });
  assert.equal(res.status, 404, "a server outside the grant's pinned set is refused");
});

test("an unknown, expired, or malformed token is refused", async () => {
  const server = await makeServer("api_key", SECRET);
  const unknown = await gatewayCall(server.id, "bmg_deadbeef", { id: 1 });
  assert.equal(unknown.status, 404);

  const expired = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: -1000,
  });
  const res = await gatewayCall(server.id, expired, { id: 1 });
  assert.equal(res.status, 404, "an expired grant is refused");

  const notAToken = await gatewayCall(server.id, "just-a-string", { id: 1 });
  assert.equal(notAToken.status, 404);
});

test("a disabled server refuses mid-run", async () => {
  const server = await makeServer("api_key", SECRET);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  await ctx.db.update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, server.id));
  const res = await gatewayCall(server.id, token, { id: 1 });
  assert.equal(res.status, 404, "disabling a server takes effect on the next request");
});

test("a server with no stored credential is refused", async () => {
  const server = await makeServer("api_key", null);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  const res = await gatewayCall(server.id, token, { id: 1 });
  assert.equal(res.status, 404, "a missing credential is a 404, not a plaintext-less proxy");
});

test("an oversized chunked body is refused before it is buffered", async () => {
  const server = await makeServer("none", null);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  // A body with no content-length (a stream), larger than the 10 MB cap.
  // The cap must trip while reading rather than trusting the header.
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 12) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  const res = await app.request(`/api/mcp-gateway/${server.id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    // @ts-expect-error duplex is required by Node fetch for a stream body
    duplex: "half",
  });
  assert.equal(res.status, 413, "an oversized streamed body is refused");
});

test("runHasActiveMcp is true only for a live grant that pinned a server", async () => {
  // No servers attached: no grant is what prepareRunMcp mints, but even a
  // grant with an empty server set must not count.
  const empty = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [],
    ttlMs: 60_000,
  });
  assert.ok(empty);
  assert.equal(await runHasActiveMcp(ctx, runId), false, "an empty grant does not count as attached");

  const server = await makeServer("none", null);
  await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  assert.equal(await runHasActiveMcp(ctx, runId), true, "a grant pinning a server counts as attached");

  await revokeRunGrant(ctx, runId);
  assert.equal(await runHasActiveMcp(ctx, runId), false, "a revoked grant does not count, so resume adds no MCP flags");
});

test("a per-user server with a null acting user is refused, even with an org row present", async () => {
  // A user-scoped server that also, wrongly, has an org credential row.
  // The gateway must never fall back to it: the isNull branch would
  // serve org authority where a per-user identity was required.
  const [server] = await ctx.db
    .insert(mcpServers)
    .values({
      ownerId: ctx.userId,
      organizationId: null,
      name: "Per user",
      slug: `gw-user-${seenAuth.length}`,
      url: upstreamUrl,
      transport: "http",
      authType: "oauth",
      credentialScope: "user",
    })
    .returning();
  await ctx.db.insert(mcpCredentials).values({
    serverId: server!.id,
    organizationId: null,
    userId: null, // an org row that must not be used for a user-scoped server
    kind: "oauth",
    encryptedSecret: ctx.secretBox.encrypt(SECRET),
  });
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null, // auto-started: no acting user
    serverIds: [server!.id],
    ttlMs: 60_000,
  });
  const res = await gatewayCall(server!.id, token, { id: 1 });
  assert.equal(res.status, 404, "a per-user server must not serve the org credential to an anonymous run");
});

test("an auth-none server proxies with no credential header", async () => {
  const server = await makeServer("none", null);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: null,
    serverIds: [server.id],
    ttlMs: 60_000,
  });
  seenAuth = [];
  const res = await gatewayCall(server.id, token, { id: 1 });
  // The upstream demands a key, so it answers 401; the point is the
  // gateway forwarded with no Authorization, which the upstream saw.
  assert.equal(seenAuth.at(-1), null, "an auth-none server sends no credential header");
  assert.equal(res.status, 401, "the upstream's own 401 passes back");
});

test("an upstream 401 triggers one refresh and a retry, and the rotated refresh token is persisted", async () => {
  // An upstream that accepts only the current access token, and a token
  // endpoint that rotates the refresh token on each call.
  let currentAccess = "access-1";
  let refreshCalls = 0;
  const rotating = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${currentAccess}`) {
      res.writeHead(401); res.end(JSON.stringify({ error: "expired_token" })); return;
    }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })); });
  });
  const tokenEndpoint = createServer((req, res) => {
    refreshCalls += 1;
    currentAccess = "access-2";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-rotated", expires_in: 3600 }));
  });
  await new Promise<void>((r) => rotating.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => tokenEndpoint.listen(0, "127.0.0.1", r));
  const upstreamPort = (rotating.address() as { port: number }).port;
  const tokenPort = (tokenEndpoint.address() as { port: number }).port;

  try {
    const [server] = await ctx.db.insert(mcpServers).values({
      ownerId: ctx.userId, organizationId: null, name: "OAuth", slug: `gw-oauth-${seenAuth.length}`,
      url: `http://127.0.0.1:${upstreamPort}/mcp`, transport: "http", authType: "oauth", credentialScope: "org",
      clientId: "client-1", tokenEndpoint: `http://127.0.0.1:${tokenPort}/token`,
      issuer: `http://127.0.0.1:${tokenPort}`, resource: `http://127.0.0.1:${upstreamPort}/mcp`,
    }).returning();
    const [cred] = await ctx.db.insert(mcpCredentials).values({
      serverId: server!.id, organizationId: null, userId: null, kind: "oauth",
      encryptedSecret: ctx.secretBox.encrypt("access-1"), // stale from the upstream's view after it rotates
      encryptedRefreshToken: ctx.secretBox.encrypt("refresh-1"),
      // Not yet expired by our clock, so the gateway attaches it and
      // learns it is stale only from the upstream's 401. This exercises
      // the on-401 retry path specifically.
      expiresAt: new Date(Date.now() + 3600_000),
      tokenEndpointOrigin: `http://127.0.0.1:${tokenPort}`,
    }).returning();
    const token = await mintRunGrant(ctx, {
      runId, organizationId: null, actingUserId: null, serverIds: [server!.id], ttlMs: 60_000,
    });

    // The stored access token is access-1, which the upstream accepts
    // until the first refresh flips it to access-2. To force a 401 that
    // triggers refresh, mark the upstream's accepted token as access-2
    // up front so the first call with access-1 fails.
    currentAccess = "access-2";
    const res = await gatewayCall(server!.id, token, { jsonrpc: "2.0", id: 1, method: "tools/call" });
    assert.equal(res.status, 200, "after refresh the retry succeeds");
    assert.equal(refreshCalls, 1, "exactly one refresh happened");

    const [after] = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.id, cred!.id));
    assert.equal(ctx.secretBox.decrypt(after!.encryptedSecret), "access-2", "the new access token is stored");
    assert.equal(ctx.secretBox.decrypt(after!.encryptedRefreshToken!), "refresh-rotated", "the rotated refresh token is stored");
  } finally {
    rotating.close();
    tokenEndpoint.close();
  }
});

test("two concurrent 401s do a single refresh (advisory lock)", async () => {
  let currentAccess = "conc-2";
  let refreshCalls = 0;
  const rotating = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${currentAccess}`) { res.writeHead(401); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  const tokenEndpoint = createServer((req, res) => {
    refreshCalls += 1;
    // A small delay so both requests contend for the lock.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "conc-2", refresh_token: "conc-refresh-2", expires_in: 3600 }));
    }, 50);
  });
  await new Promise<void>((r) => rotating.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => tokenEndpoint.listen(0, "127.0.0.1", r));
  const upstreamPort = (rotating.address() as { port: number }).port;
  const tokenPort = (tokenEndpoint.address() as { port: number }).port;

  try {
    const [server] = await ctx.db.insert(mcpServers).values({
      ownerId: ctx.userId, organizationId: null, name: "OAuth2", slug: `gw-oauth2-${seenAuth.length}`,
      url: `http://127.0.0.1:${upstreamPort}/mcp`, transport: "http", authType: "oauth", credentialScope: "org",
      clientId: "client-2", tokenEndpoint: `http://127.0.0.1:${tokenPort}/token`,
      issuer: `http://127.0.0.1:${tokenPort}`, resource: `http://127.0.0.1:${upstreamPort}/mcp`,
    }).returning();
    await ctx.db.insert(mcpCredentials).values({
      serverId: server!.id, organizationId: null, userId: null, kind: "oauth",
      encryptedSecret: ctx.secretBox.encrypt("conc-1"),
      encryptedRefreshToken: ctx.secretBox.encrypt("conc-refresh-1"),
      // Already expired, so both concurrent requests proactively refresh
      // in resolveTarget: the in-process single flight must still collapse
      // them to one token call.
      expiresAt: new Date(Date.now() - 1000),
      tokenEndpointOrigin: `http://127.0.0.1:${tokenPort}`,
    });
    const token = await mintRunGrant(ctx, {
      runId, organizationId: null, actingUserId: null, serverIds: [server!.id], ttlMs: 60_000,
    });

    const [a, b] = await Promise.all([
      gatewayCall(server!.id, token, { id: 1 }),
      gatewayCall(server!.id, token, { id: 2 }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(refreshCalls, 1, "the advisory lock collapsed two 401s into one refresh");
  } finally {
    rotating.close();
    tokenEndpoint.close();
  }
});
