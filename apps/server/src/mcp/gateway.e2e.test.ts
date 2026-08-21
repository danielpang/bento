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
import { mintRunGrant } from "./grants.js";

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
