import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import pg from "pg";
import PgBoss from "pg-boss";
import { claudeCodeAdapter, piAdapter } from "@bento/agents";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  features,
  mcpRunGrants,
  pipelines,
  projects,
  runMigrations,
  secrets,
  stages,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import {
  extendRunGrant,
  mintRunGrant,
  resolveGrant,
  revokeRunGrant,
  runGrantUses,
  runHadModelProxyFailure,
  setRunGrantServers,
} from "./mcp/grants.js";
import { resolveAgentEnv } from "./orchestrator/agent-env.js";
import { proxyModelCredentials } from "./orchestrator/model-proxy-env.js";
import { executeRun } from "./orchestrator/run-executor.js";
import { singleDriver } from "./orchestrator/sandbox-driver.js";
import { upstreamUrl } from "./routes/model-proxy.js";
import { SecretBox } from "./secrets.js";

/**
 * The model proxy, against a real database, a real HTTP server for
 * Bento and a stand-in provider on loopback.
 *
 * The route is mode blind (it serves whatever a grant names), so it is
 * exercised from a local mode context, where the stand-in's plain http
 * loopback address is a base URL safeFetch allows. The substitution and
 * the run that bills by it are multi mode only, and switch the mode for
 * their own duration.
 */

const exec = promisify(execFile);
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "model_proxy_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let bento: ReturnType<typeof serve>;
let bentoUrl: string;
let upstream: Server;
let upstreamBase: string;
let userId: string;
let repoDir: string;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
const seen: Seen[] = [];
/** Released by the streaming test once its client has the first chunk. */
let releaseSecondChunk: () => void = () => {};

/** Every run row hangs off a project in org-a, org-b, or no organization. */
const projectsByOrg: Record<string, { feature: string; stage: string; profile: string }> = {};

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  repoDir = await mkdtemp(path.join(tmpdir(), "bento-proxy-repo-"));
  await exec("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n");
  await exec("git", ["-C", repoDir, "add", "-A"]);
  await exec("git", ["-C", repoDir, "-c", "user.email=t@bento.dev", "-c", "user.name=t", "commit", "-qm", "init"]);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-proxy-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    BENTO_LIVE_IDLE_SEC: "0",
  } as NodeJS.ProcessEnv);
  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  userId = await ensureLocalUser(db);
  ctx = {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    drivers: singleDriver(new LocalProcessDriver()),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  };

  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url?.includes("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "stream" });
      res.write("data: first\n\n");
      await new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      res.end("data: second\n\n");
      return;
    }
    if (req.url?.includes("/limited")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "x-upstream": "limited" });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down, upstream says" } }));
      return;
    }
    res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  const app = createApp(ctx);
  bentoUrl = await new Promise<string>((resolve) => {
    bento = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });
  // Where a sandbox reaches Bento: this server, on loopback.
  ctx.env.BETTER_AUTH_URL = bentoUrl;

  await pool.query(`insert into identity.organization (id,name,slug) values ('org-a','A','org-a'), ('org-b','B','org-b')`);
  for (const org of ["org-a", "org-b", null]) {
    const [project] = await db
      .insert(projects)
      .values({ ownerId: userId, organizationId: org, name: `p-${org}`, defaultBranch: "main" })
      .returning({ id: projects.id });
    const [pipeline] = await db.insert(pipelines).values({ projectId: project!.id, name: "p" }).returning({ id: pipelines.id });
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
      .values({ ownerId: userId, organizationId: org, name: "a", cli: "claude-code", model: "claude-sonnet-5" })
      .returning({ id: agentProfiles.id });
    projectsByOrg[org ?? "none"] = { feature: feature!.id, stage: stage!.id, profile: profile!.id };
  }

  await saveSecret("org-a", "ANTHROPIC_API_KEY", "sk-ant-real-a");
  await saveSecret("org-a", "ANTHROPIC_BASE_URL", `${upstreamBase}/anthropic-root`);
  await saveSecret("org-a", "OPENAI_API_KEY", "sk-openai-real-a");
  await saveSecret("org-a", "OPENAI_BASE_URL", `${upstreamBase}/openai-root/v1`);
  await saveSecret("org-a", "GEMINI_API_KEY", "AIza-real-a");
  await saveSecret("org-a", "GOOGLE_GEMINI_BASE_URL", `${upstreamBase}/gemini-root`);
});

after(async () => {
  releaseSecondChunk();
  bento?.close();
  upstream?.close();
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

async function saveSecret(org: string | null, name: string, value: string) {
  await ctx.db.insert(secrets).values({
    ownerId: userId,
    organizationId: org,
    name,
    ciphertext: ctx.secretBox.encrypt(value),
    hint: "",
  });
}

async function newRun(org: "org-a" | "org-b" | "none" = "org-a", status = "running"): Promise<string> {
  const ids = projectsByOrg[org]!;
  const [row] = await ctx.db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: ids.feature,
      stageId: ids.stage,
      agentProfileId: ids.profile,
      status: status as "running",
      prompt: "model proxy test",
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

async function grant(modelCredentials: string[], org: "org-a" | "org-b" = "org-a", ttlMs = 60_000) {
  const runId = await newRun(org);
  const token = await mintRunGrant(ctx, {
    runId,
    organizationId: org,
    actingUserId: null,
    serverIds: [],
    modelCredentials,
    ttlMs,
  });
  return { runId, token };
}

function proxied(pathAndQuery: string, init: RequestInit = {}) {
  return fetch(`${bentoUrl}/api/model-proxy/${pathAndQuery}`, init);
}

/** A WebSocket upgrade, which fetch will not send: Codex opens each turn with one. */
function upgradeRequest(pathAndQuery: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${bentoUrl}/api/model-proxy/${pathAndQuery}`, {
      headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    req.on("response", async (res) => {
      let body = "";
      for await (const chunk of res) body += chunk;
      resolve({ status: res.statusCode ?? 0, body });
    });
    req.on("upgrade", () => reject(new Error("the proxy accepted a WebSocket upgrade")));
    req.on("error", reject);
    req.end();
  });
}

const ANTHROPIC = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];

test("the organization's key reaches the provider and the run token does not", async () => {
  const { token } = await grant(ANTHROPIC);
  seen.length = 0;
  const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
  const res = await proxied("anthropic/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      cookie: "session=from-the-sandbox",
      "x-forwarded-for": "10.0.0.7",
    },
    body,
  });
  assert.equal(res.status, 201, "the provider's status, as it gave it");
  assert.equal(res.headers.get("x-upstream"), "yes", "and its headers");
  assert.deepEqual(await res.json(), { ok: true }, "and its body");

  assert.equal(seen.length, 1);
  const call = seen[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/anthropic-root/v1/messages?beta=true", "the saved base URL, then the path and query asked for");
  assert.equal(call.headers["x-api-key"], "sk-ant-real-a", "the real key, where Anthropic reads it");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers["x-forwarded-for"], undefined);
  assert.ok(!JSON.stringify(call.headers).includes(token), "the token never leaves Bento");
  assert.equal(call.body.toString(), body, "the body as sent");
});

test("a bearer provider gets a bearer key, and Gemini's key is taken from the query and moved to its header", async () => {
  const openai = await grant(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  seen.length = 0;
  const res = await proxied("openai/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${openai.token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 201);
  assert.equal(seen[0]!.url, "/openai-root/v1/responses");
  assert.equal(seen[0]!.headers.authorization, "Bearer sk-openai-real-a");

  const gemini = await grant(["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]);
  seen.length = 0;
  const answer = await proxied(`gemini/v1beta/models/m:streamGenerateContent?alt=sse&key=${gemini.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(answer.status, 201);
  assert.equal(seen[0]!.url, "/gemini-root/v1beta/models/m:streamGenerateContent?alt=sse", "the token's query parameter is gone");
  assert.equal(seen[0]!.headers["x-goog-api-key"], "AIza-real-a");
});

test("the provider's own errors pass through as they are", async () => {
  const { token } = await grant(ANTHROPIC);
  const res = await proxied("anthropic/limited", { method: "POST", headers: { "x-api-key": token }, body: "{}" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.deepEqual(await res.json(), { error: { type: "rate_limit_error", message: "slow down, upstream says" } });
});

test("every refusal is the same 404, and nothing reaches the provider", async () => {
  const live = await grant(ANTHROPIC);
  const revoked = await grant(ANTHROPIC);
  await revokeRunGrant(ctx, revoked.runId);
  const expired = await grant(ANTHROPIC, "org-a", -1_000);
  const otherProvider = await grant(["OPENAI_API_KEY"]);
  // org-b holds no Anthropic key of its own: a grant can only spend its
  // own organization's.
  const foreign = await grant(ANTHROPIC, "org-b");

  seen.length = 0;
  const attempts: [string, RequestInit][] = [
    ["anthropic/v1/messages", { method: "POST", body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": "sk-ant-not-a-token" }, body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": "bmg_never-minted" }, body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": revoked.token }, body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": expired.token }, body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": otherProvider.token }, body: "{}" }],
    ["anthropic/v1/messages", { method: "POST", headers: { "x-api-key": foreign.token }, body: "{}" }],
    ["nowhere/v1/messages", { method: "POST", headers: { "x-api-key": live.token }, body: "{}" }],
  ];
  for (const [where, init] of attempts) {
    const res = await proxied(where, init);
    assert.equal(res.status, 404, `${where} with ${JSON.stringify(init.headers ?? {})}`);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  // A WebSocket upgrade without a token is a refusal like any other.
  const upgrade = await upgradeRequest("openai/responses", {});
  assert.equal(upgrade.status, 404);
  assert.deepEqual(JSON.parse(upgrade.body), { error: "not found" });
  assert.equal(seen.length, 0, "no refused request reached the provider");
});

test("the upstream host never comes from the request", async () => {
  const { token } = await grant(ANTHROPIC);
  seen.length = 0;
  for (const where of ["anthropic//evil.example/v1/messages", "anthropic/@evil.example/v1", "anthropic/v1/messages?host=evil.example"]) {
    const res = await proxied(where, {
      method: "POST",
      headers: { "x-api-key": token, "x-forwarded-host": "evil.example", forwarded: "host=evil.example" },
      body: "{}",
    });
    // Either it went to the stand-in under the saved base, or it was
    // refused; it never went anywhere else.
    assert.ok(res.status === 201 || res.status === 404, `${where}: ${res.status}`);
  }
  for (const call of seen) {
    assert.ok(call.url.startsWith("/anthropic-root/"), `stayed under the saved base: ${call.url}`);
    assert.equal(call.headers["x-forwarded-host"], undefined);
    assert.equal(call.headers.forwarded, undefined);
    assert.equal(call.headers.host, new URL(upstreamBase).host);
  }

  const asked = (p: string) => new URL(`https://bento.example/api/model-proxy/openai${p}`);
  assert.equal(upstreamUrl("https://api.openai.com/v1", asked("/responses"), "openai"), "https://api.openai.com/v1/responses");
  assert.equal(
    upstreamUrl("https://api.openai.com/v1", asked("//evil.example/responses"), "openai"),
    "https://api.openai.com/v1//evil.example/responses",
    "a doubled slash is a path on the provider, not a host",
  );
  assert.equal(upstreamUrl("https://api.openai.com/v1", asked("?key=bmg_x&alt=sse"), "openai"), "https://api.openai.com/v1?alt=sse");
  assert.equal(
    upstreamUrl("https://api.openai.com/v1", new URL("https://bento.example/api/model-proxy/openaix/responses"), "openai"),
    null,
    "a path that is not this provider's",
  );
});

test("a streamed answer reaches the agent chunk by chunk", async () => {
  const { token } = await grant(ANTHROPIC);
  const res = await proxied("anthropic/stream", { method: "POST", headers: { "x-api-key": token }, body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // The provider holds its second chunk until the first has arrived
  // here, so a proxy that buffered would never finish this read.
  let first = "";
  while (!first.includes("first")) {
    const { value, done } = await reader.read();
    assert.ok(!done, "the stream ended before its first chunk");
    first += decoder.decode(value, { stream: true });
  }
  assert.ok(!first.includes("second"), "the second chunk was not sent yet");
  releaseSecondChunk();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  assert.match(rest, /data: second/);
});

test("a WebSocket upgrade with a live token is told to use HTTP", async () => {
  const { token } = await grant(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  seen.length = 0;
  const res = await upgradeRequest("openai/responses", { authorization: `Bearer ${token}` });
  assert.equal(res.status, 426);
  assert.equal(seen.length, 0);
});

test("a provider Bento cannot reach is Bento's failure, stamped on the grant", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadBase = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  // A provider of its own for this test, so the other tests keep theirs.
  await saveSecret("org-b", "DEEPSEEK_API_KEY", "sk-deepseek-b");
  await saveSecret("org-b", "DEEPSEEK_BASE_URL", deadBase);
  const failing = await grant(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"], "org-b");
  const healthy = await grant(ANTHROPIC);

  const res = await proxied("deepseek/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${failing.token}` },
    body: "{}",
  });
  assert.equal(res.status, 502);
  const answer = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(answer.error.type, "bento_model_proxy_error");
  assert.equal(await runHadModelProxyFailure(ctx, failing.runId), true);
  assert.equal(await runHadModelProxyFailure(ctx, healthy.runId), false);

  // A run started again gets a new grant, and the last life's failure is not its.
  await mintRunGrant(ctx, { runId: failing.runId, organizationId: "org-b", actingUserId: null, serverIds: [], modelCredentials: [], ttlMs: 60_000 });
  assert.equal(await runHadModelProxyFailure(ctx, failing.runId), false);
  assert.equal(await resolveGrant(ctx, failing.token), null, "and the old token is dead");
});

test("a key that cannot be decrypted is Bento's failure too", async () => {
  const runId = await newRun("org-b");
  await saveSecret("org-b", "OPENAI_API_KEY", "sk-openai-b");
  await ctx.db.update(secrets).set({ ciphertext: "not-a-ciphertext" }).where(eq(secrets.name, "OPENAI_API_KEY"));
  const token = await mintRunGrant(ctx, { runId, organizationId: "org-b", actingUserId: null, serverIds: [], modelCredentials: ["OPENAI_API_KEY"], ttlMs: 60_000 });
  const res = await proxied("openai/responses", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(res.status, 502);
  assert.equal(await runHadModelProxyFailure(ctx, runId), true);
  // Put org-a's key back the way it was saved, for the tests after this.
  await ctx.db.delete(secrets).where(eq(secrets.organizationId, "org-b"));
  await ctx.db.delete(secrets).where(eq(secrets.name, "OPENAI_API_KEY"));
  await saveSecret("org-a", "OPENAI_API_KEY", "sk-openai-real-a");
});

/** A context in multi mode, for as long as `fn` runs. */
async function inMulti<T>(fn: () => Promise<T>): Promise<T> {
  const was = ctx.env.BENTO_MODE;
  ctx.env.BENTO_MODE = "multi";
  try {
    return await fn();
  } finally {
    ctx.env.BENTO_MODE = was;
  }
}

function proxyInput(runId: string, env: Record<string, string>, extra: Partial<Parameters<typeof proxyModelCredentials>[1]> = {}) {
  const notes: string[] = [];
  return {
    notes,
    input: {
      runId,
      organizationId: "org-a",
      actingUserId: null,
      adapter: claudeCodeAdapter,
      driver: ctx.drivers.default,
      env,
      say: async (text: string) => {
        notes.push(text);
      },
      ...extra,
    },
  };
}

test("in multi mode a run's keys become its token, and its base URLs the proxy", async () => {
  const runId = await newRun();
  const resolved = await inMulti(() => resolveAgentEnv(ctx, "org-a", claudeCodeAdapter, "claude-sonnet-5"));
  assert.equal(resolved.env.ANTHROPIC_API_KEY, "sk-ant-real-a", "resolved from the organization's secrets");
  const { input } = proxyInput(runId, resolved.env);
  const { env, grantToken } = await inMulti(() => proxyModelCredentials(ctx, input));

  assert.ok(grantToken?.startsWith("bmg_"));
  assert.equal(env.ANTHROPIC_API_KEY, grantToken, "the key's own variable holds the token");
  assert.equal(env.ANTHROPIC_BASE_URL, `${bentoUrl}/api/model-proxy/anthropic`);
  assert.ok(!Object.values(env).some((value) => value.includes("sk-ant-real-a")), "the key is nowhere in the sandbox");

  const resolvedGrant = await resolveGrant(ctx, grantToken!);
  assert.deepEqual(resolvedGrant?.modelCredentials.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  assert.deepEqual(resolvedGrant?.serverIds, []);

  // And the token works at the address it was given.
  seen.length = 0;
  const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY! },
    body: "{}",
  });
  assert.equal(res.status, 201);
  assert.equal(seen[0]!.headers["x-api-key"], "sk-ant-real-a");
});

test("local mode, a login token, and a sandbox with no gateway keep what they had", async () => {
  const keyed = { ANTHROPIC_API_KEY: "sk-ant-real-a" };

  const local = proxyInput(await newRun(), keyed);
  const inLocal = await proxyModelCredentials(ctx, local.input);
  assert.deepEqual(inLocal, { env: keyed, grantToken: null }, "local mode is one trusted user's");

  const login = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-login" };
  const loginRun = await newRun();
  const withLogin = await inMulti(() => proxyModelCredentials(ctx, proxyInput(loginRun, login).input));
  assert.deepEqual(withLogin, { env: login, grantToken: null }, "a login is not a key, and no base URL is set for it");
  assert.equal(await runGrantUses(ctx, loginRun), null, "and no grant was minted");

  const remote = { provider: "sprite", workspace: "clone" } as SandboxDriver;
  const unreachable = proxyInput(await newRun(), keyed, { driver: remote });
  const withoutGateway = await inMulti(() => proxyModelCredentials(ctx, unreachable.input));
  assert.deepEqual(withoutGateway, { env: keyed, grantToken: null }, "a sprite cannot reach a loopback Bento");
  assert.match(unreachable.notes.join("\n"), /no gateway URL a sandbox can reach/);

  const pi = proxyInput(await newRun(), keyed, { adapter: piAdapter });
  const piLocal = await inMulti(() => proxyModelCredentials(ctx, pi.input));
  assert.equal(piLocal.grantToken, null, "pi's addresses travel in a home file, which the local process driver never writes");
});

test("the resolver's login rule is unchanged under the proxy", async () => {
  await saveSecret("org-b", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-org-b");
  try {
    const resolved = await inMulti(() => resolveAgentEnv(ctx, "org-b", claudeCodeAdapter, "claude-sonnet-5"));
    assert.deepEqual(resolved.missing, []);
    const runId = await newRun("org-b");
    const proxiedEnv = await inMulti(() => proxyModelCredentials(ctx, proxyInput(runId, resolved.env, { organizationId: "org-b" }).input));
    assert.deepEqual(proxiedEnv.env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-org-b" });
  } finally {
    await ctx.db.delete(secrets).where(eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"));
  }
});

test("MCP joins the proxy's grant, and a reattach extends it for either", async () => {
  const runId = await newRun();
  const { env, grantToken } = await inMulti(() => proxyModelCredentials(ctx, proxyInput(runId, { ANTHROPIC_API_KEY: "sk-ant-real-a" }).input));
  assert.ok(grantToken);

  // What prepareRunMcp does with a token in hand: the servers join the
  // row, and the token the environment holds still works.
  await setRunGrantServers(ctx, runId, ["bento"]);
  const joined = await resolveGrant(ctx, grantToken);
  assert.deepEqual(joined?.serverIds, ["bento"]);
  assert.deepEqual(joined?.modelCredentials, ["ANTHROPIC_API_KEY"]);
  // A config that could not be written detaches the servers, not the model.
  await setRunGrantServers(ctx, runId, []);
  assert.ok(await resolveGrant(ctx, grantToken), "the proxy's token survives a failed MCP write");
  assert.deepEqual(await runGrantUses(ctx, runId), { serverIds: [], modelCredentials: ["ANTHROPIC_API_KEY"] });

  // A reattach extends the grant the sandbox's environment still holds.
  await ctx.db.update(mcpRunGrants).set({ expiresAt: new Date(Date.now() + 1_000) }).where(eq(mcpRunGrants.runId, runId));
  await extendRunGrant(ctx, runId, 60 * 60_000);
  const [row] = await ctx.db.select().from(mcpRunGrants).where(eq(mcpRunGrants.runId, runId));
  assert.ok(row!.expiresAt.getTime() > Date.now() + 30 * 60_000);
  assert.equal(env.ANTHROPIC_API_KEY, grantToken);
});

/**
 * The whole path, through executeRun: a multi mode run's sandbox gets
 * the token and the proxy's address, the agent's call fails because the
 * proxy could not do its part, and the run is not billed for it. The
 * agent is a stand-in `claude` on PATH that records what it was given
 * and then makes one model call, once the test has broken the key.
 */
test("a run the model proxy failed under is not billed", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "bento-proxy-bin-"));
  const script = `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(bin)};
fs.writeFileSync(dir + "/env.json", JSON.stringify({ key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL }));
(async () => {
  while (!fs.existsSync(dir + "/go")) await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json" },
    body: "{}",
  });
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "stub-1", model: "claude-sonnet-5" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: " + res.status, session_id: "stub-1" }));
  process.exit(1);
})();
`;
  await writeFile(path.join(bin, "claude"), script);
  await chmod(path.join(bin, "claude"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;

  // A project of its own with the repository the local driver works in.
  await ctx.pool.query(`insert into repositories (project_id, name, local_path, default_branch)
    select id, 'repo', $1, 'main' from projects where organization_id is null`, [repoDir]);
  const ids = projectsByOrg.none!;
  await ctx.db.update(features).set({ currentStageId: ids.stage, status: "active" }).where(eq(features.id, ids.feature));
  await saveSecret(null, "ANTHROPIC_API_KEY", "sk-ant-local-org");
  const runId = await newRun("none", "queued");

  try {
    const finished = inMulti(() => executeRun(ctx, runId));
    const envFile = path.join(bin, "env.json");
    const deadline = Date.now() + 60_000;
    while (!existsSync(envFile)) {
      if (Date.now() > deadline) assert.fail("the agent never started");
      await new Promise((r) => setTimeout(r, 100));
    }
    const given = JSON.parse(readFileSync(envFile, "utf8")) as { key: string; base: string };
    assert.ok(given.key.startsWith("bmg_"), "the sandbox got the token");
    assert.equal(given.base, `${bentoUrl}/api/model-proxy/anthropic`, "and the proxy's address");

    // Now the proxy cannot read the key it is meant to swap in.
    await ctx.db.update(secrets).set({ ciphertext: "broken" }).where(eq(secrets.name, "ANTHROPIC_API_KEY"));
    writeFileSync(path.join(bin, "go"), "");
    await finished;

    const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal(run!.status, "failed");
    assert.equal(run!.billable, false, "Bento failed it, so it is not billed");
    const [row] = await ctx.db.select().from(mcpRunGrants).where(eq(mcpRunGrants.runId, runId));
    assert.ok(row!.proxyFailedAt, "the proxy recorded its own failure");
    assert.ok(row!.revokedAt, "and the token died with the run");
  } finally {
    process.env.PATH = savedPath;
  }
});
