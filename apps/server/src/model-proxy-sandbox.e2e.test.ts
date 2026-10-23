import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pg from "pg";
import { claudeCodeAdapter, opencodeAdapter, runAgent, type BuildCommandInput } from "@bento/agents";
import { MODEL_PROVIDERS, type ModelProxyRoute } from "@bento/core";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  features,
  organizationPolicies,
  pipelines,
  projects,
  runMigrations,
  secrets,
  stages,
} from "@bento/db";
import {
  collectExec,
  LocalProcessDriver,
  ModalDriver,
  modalOutboundAllowlist,
  modalSandboxName,
  SpriteDriver,
  spriteName,
  type SandboxDriver,
  type SandboxHandle,
} from "@bento/sandbox";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { hashGrantToken, revokeRunGrant } from "./mcp/grants.js";
import { attachPgBus, type PgBus } from "./pg-bus.js";
import { resolveAgentEnv } from "./orchestrator/agent-env.js";
import { proxyModelCredentials } from "./orchestrator/model-proxy-env.js";
import { singleDriver } from "./orchestrator/sandbox-driver.js";
import { modalNetworkForProject } from "./orchestrator/sandbox-network.js";
import { modelProxyCacheFor, modelProxyRoutes, resetRefusalReports } from "./routes/model-proxy.js";
import { SecretBox } from "./secrets.js";

/**
 * Bento's model proxy, called from inside a real sandbox.
 *
 * model-proxy.e2e.test.ts proves the route on loopback, and
 * model-proxy-cli.e2e.test.ts the real CLIs on this machine. Neither
 * sends a request from where an agent actually is: a Fly Sprite or a
 * Modal sandbox, across the internet, through whatever network that
 * machine was given. This does. The proxy runs here, with a real
 * database, the organization's keys stored encrypted as in production,
 * and the run tokens minted by the real proxyModelCredentials path; the
 * sandbox gets exactly the environment that path built, and curl in the
 * sandbox makes every call. The provider is a stand-in on this machine's
 * loopback, which the proxy reaches by pointing each vendor's default
 * upstream at it (the way the local e2e does; a saved base URL would be
 * refused by safeFetch as a private address in multi mode, which is
 * right). So only the proxy is public, and only for as long as this
 * process runs.
 *
 * Reachability. A sprite or a Modal box cannot reach a GitHub runner, so
 * the proxy is put behind a Cloudflare quick tunnel: `cloudflared tunnel
 * --url` against the proxy's local port, which needs no account and
 * prints a public https address. The process serving it mounts the
 * model proxy and one readiness route, nothing else of Bento's. The
 * tunnel is this process's child and ends with it (and the runner ends
 * every process with the job). To use a tunnel you started yourself,
 * set BENTO_PROXY_E2E_PUBLIC_URL to its address and point it at
 * BENTO_PROXY_E2E_PORT (4499 by default). cloudflared is found as
 * BENTO_CLOUDFLARED or on PATH. The tunnel's address becomes
 * BENTO_MCP_GATEWAY_URL, so the sandbox's base URLs and the Modal
 * allowlist are built from it by Bento's own code.
 *
 * Three suites, one case list:
 *
 *   local   always on, part of `pnpm test`. The "sandbox" is the local
 *           process driver running the same shell script against the
 *           proxy on loopback, so the case list and its assertions run
 *           on every push.
 *   sprite  BENTO_PROXY_SPRITE_E2E=1 and SPRITES_TOKEN. Sprites cannot
 *           restrict egress (a locked network never goes to one), so the
 *           network allowlist is not checked there.
 *   modal   BENTO_PROXY_MODAL_E2E=1, MODAL_TOKEN_ID and
 *           MODAL_TOKEN_SECRET. The box is provisioned with the
 *           restricted network modalNetworkForProject computes for a
 *           locked team with one allowed site, so every proxy call also
 *           proves the gateway is on the list, and the box is then shown
 *           to reach the allowed site and not the proxied provider's own
 *           host or a host nobody listed.
 *
 * Each remote suite also drives Claude Code, as installed by the
 * toolchain, through the proxy for one turn against the stand-in.
 *
 * One machine per suite, the smallest size, reused for every case, and
 * destroyed in the test's own teardown; the workflow deletes it by name
 * afterwards for a job that was cancelled first. See
 * .github/workflows/model-proxy-e2e.yml.
 */

const spritesToken = process.env.SPRITES_TOKEN;
const spriteSkip = !process.env.BENTO_PROXY_SPRITE_E2E
  ? "set BENTO_PROXY_SPRITE_E2E=1 (and SPRITES_TOKEN) to call the proxy from a real sprite"
  : !spritesToken
    ? "SPRITES_TOKEN is not set"
    : false;

const modalTokenId = process.env.MODAL_TOKEN_ID;
// The product name is MODAL_TOKEN_SECRET; modal.e2e.test.ts keeps the
// same local fallback.
const modalTokenSecret = process.env.MODAL_TOKEN_SECRET || process.env.MODAL_SECRET_TOKEN;
const modalSkip = !process.env.BENTO_PROXY_MODAL_E2E
  ? "set BENTO_PROXY_MODAL_E2E=1 (and MODAL_TOKEN_ID, MODAL_TOKEN_SECRET) to call the proxy from a real Modal sandbox"
  : !modalTokenId || !modalTokenSecret
    ? "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set"
    : false;

/**
 * The machines' names, derived from the run the way the workflow
 * derives them, so its cleanup step can delete a machine whose test was
 * killed. Pinned by the test at the bottom of this file.
 */
const runTag = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `local-${Date.now()}`;
const WORKSPACE_PREFIX = "proxy-e2e-";
const workspaceKey = `${WORKSPACE_PREFIX}${runTag}`;

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "model_proxy_sandbox_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const ORG = "org-proxy-sandbox";
const MODEL = "claude-sonnet-5";
/** The organization's stored keys. Stand-ins: nothing here reaches a vendor. */
const KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-org-key-proxy-sandbox",
  OPENAI_API_KEY: "sk-openai-org-key-proxy-sandbox",
  GEMINI_API_KEY: "AIza-org-key-proxy-sandbox",
} as const;
/** The site the locked team allowed itself (#286), as a wildcard. */
const ALLOWED_SITE = "*.wikipedia.org";
const ALLOWED_SITE_URL = "https://www.wikipedia.org/";
/**
 * Public hosts the restricted box must not reach: the proxied provider's
 * own host, which is off the list because the proxy carries its key, and
 * a host nobody listed.
 */
const UNLISTED_URLS = ["https://api.anthropic.com/v1/models", "https://example.com/"];

let ctx: AppContext;
let pgBus: PgBus | undefined;
let proxyServer: ReturnType<typeof serve> | undefined;
let proxyLocalUrl = "";
let provider: Server | undefined;
let projectId = "";
let featureId = "";
let stageId = "";
let profileId = "";
const readyNonce = randomBytes(12).toString("hex");
/** Every proxied provider's default upstream, before it was pointed at the stand-in. */
const vendorUpstreams = new Map<ModelProxyRoute, string>();

interface ProviderCall {
  caseId: string | undefined;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
/** What the stand-in provider was sent. */
const providerCalls: ProviderCall[] = [];
/** The endpoints the proxy refused a live token, from its reports to error tracking. */
const refusalReports: Record<string, unknown>[] = [];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const userId = await ensureLocalUser(db);
  const env = loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl, BENTO_SANDBOX_DRIVER: "local-process" } as NodeJS.ProcessEnv);
  // The substitution is multi mode's (local mode hands a sandbox its
  // keys), and this context serves nothing else.
  env.BENTO_MODE = "multi";
  ctx = {
    env,
    db,
    pool,
    bus: new EventBus(),
    drivers: singleDriver(new LocalProcessDriver()),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  } as unknown as AppContext;
  ctx.analytics = {
    capture() {},
    captureException(_error, _userId, _organizationId, properties) {
      if (properties?.source === "model_proxy_endpoint") refusalReports.push(properties);
    },
    async shutdown() {},
  };
  // Replicated through Postgres as in production: the database's
  // announcement of a run's end (migration 0068) is what evicts the
  // proxy's cached grant.
  pgBus = await attachPgBus({ bus: ctx.bus, pool, connectionString: testUrl, loadRunEvent: async () => null });

  provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const tag = req.headers["x-bento-e2e-case"];
    providerCalls.push({ caseId: typeof tag === "string" ? tag : undefined, method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const url = req.url ?? "";
    if (req.method === "POST" && url.includes("/v1/messages/count_tokens")) return replyJson(res, { input_tokens: 10 });
    if (req.method === "POST" && url.includes("/v1/messages")) return anthropicReply(res, parseJson(body));
    replyJson(res, req.method === "GET" ? { data: [], models: [] } : { ok: true });
  });
  await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  for (const entry of MODEL_PROVIDERS) {
    if (!entry.proxy) continue;
    vendorUpstreams.set(entry.proxy, entry.proxy.upstream);
    (entry.proxy as { upstream: string }).upstream = `${providerUrl}/vendor/${entry.proxy.segment}`;
  }

  // The proxy and a readiness route, and nothing else of Bento's: this
  // is what the tunnel makes public.
  const app = new Hono();
  app.get("/proxy-e2e/ready", (c) => c.text(readyNonce));
  app.route("/api/model-proxy", modelProxyRoutes(ctx));
  const port = process.env.BENTO_PROXY_E2E_PUBLIC_URL ? Number(process.env.BENTO_PROXY_E2E_PORT || 4499) : 0;
  proxyLocalUrl = await new Promise<string>((resolve) => {
    proxyServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });

  await pool.query(`insert into identity.organization (id, name, slug) values ($1, 'Proxy sandbox', $1)`, [ORG]);
  const [project] = await db.insert(projects).values({ ownerId: userId, organizationId: ORG, name: "proxy", defaultBranch: "main" }).returning({ id: projects.id });
  const [pipeline] = await db.insert(pipelines).values({ projectId: project!.id, name: "p" }).returning({ id: pipelines.id });
  const [stage] = await db.insert(stages).values({ pipelineId: pipeline!.id, slug: "s", name: "S", position: 0 }).returning({ id: stages.id });
  const [feature] = await db.insert(features).values({ projectId: project!.id, pipelineId: pipeline!.id, title: "f" }).returning({ id: features.id });
  const [profile] = await db
    .insert(agentProfiles)
    .values({ ownerId: userId, organizationId: ORG, name: "a", cli: "claude-code", model: MODEL })
    .returning({ id: agentProfiles.id });
  projectId = project!.id;
  featureId = feature!.id;
  stageId = stage!.id;
  profileId = profile!.id;
  // A locked team that allowed itself one site.
  await db.insert(organizationPolicies).values({ organizationId: ORG, restrictNetwork: true, allowedHosts: [ALLOWED_SITE] });
  for (const [name, value] of Object.entries(KEYS)) {
    await db.insert(secrets).values({ ownerId: userId, organizationId: ORG, name, ciphertext: ctx.secretBox.encrypt(value), hint: "" });
  }
});

after(async () => {
  for (const [route, upstream] of vendorUpstreams) (route as { upstream: string }).upstream = upstream;
  stopTunnel();
  proxyServer?.close();
  provider?.close();
  await pgBus?.stop();
  await ctx?.pool.end();
});

function replyJson(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseJson(body: string): { stream?: boolean; model?: string } {
  try {
    return JSON.parse(body || "{}") as { stream?: boolean; model?: string };
  } catch {
    return {};
  }
}

/** Just enough of the Messages API for Claude Code to finish a turn. */
function anthropicReply(res: ServerResponse, request: { stream?: boolean; model?: string }) {
  const text = "Hello from the stand-in provider.";
  if (!request.stream) {
    replyJson(res, {
      id: "msg_standin",
      type: "message",
      role: "assistant",
      model: request.model ?? MODEL,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: { id: "msg_1", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  event("message_stop", {});
  res.end();
}

// ---------------------------------------------------------------------------
// Reaching the proxy from outside

let tunnel: ChildProcess | undefined;
let publicUrl: Promise<string> | undefined;

function stopTunnel() {
  if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGTERM");
  tunnel = undefined;
}
process.on("exit", stopTunnel);

/** The proxy's public address: a tunnel opened here, or the one BENTO_PROXY_E2E_PUBLIC_URL names. */
function publicProxyUrl(): Promise<string> {
  publicUrl ??= (async () => {
    const given = process.env.BENTO_PROXY_E2E_PUBLIC_URL?.trim();
    const url = given ? given.replace(/\/+$/, "") : await openQuickTunnel();
    await reachable(url);
    return url;
  })();
  return publicUrl;
}

async function openQuickTunnel(): Promise<string> {
  const bin = process.env.BENTO_CLOUDFLARED || "cloudflared";
  // http2 rather than the QUIC default: TCP to the edge, which every
  // runner allows.
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", proxyLocalUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  tunnel = child;
  let log = "";
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cloudflared opened no quick tunnel within 90s:\n${log.slice(-2000)}`)), 90_000);
    const read = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-20_000);
      // The banner names the tunnel; api.trycloudflare.com is the
      // service it asks, which an error line can name too.
      const found = log.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${bin} (${err.message}). Install cloudflared, set BENTO_CLOUDFLARED, or set BENTO_PROXY_E2E_PUBLIC_URL to a tunnel of your own.`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with ${code} before it opened a tunnel:\n${log.slice(-2000)}`));
    });
  });
}

/** Waits until the public address answers with this process's nonce, so it is this proxy and not an edge error page. */
async function reachable(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  // A quick tunnel's name can take a few seconds to resolve, and a
  // lookup made too early may be cached as missing.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/proxy-e2e/ready`, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      if (res.status === 200 && text === readyNonce) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  assert.fail(`the proxy never answered at its public address (${last})`);
}

// ---------------------------------------------------------------------------
// Run tokens, made the way a multi mode run makes them

interface Fixture {
  /** The sandbox's environment: what proxyModelCredentials gave each run, plus the tokens the refusals need. */
  env: Record<string, string>;
  /** Every credential the provider must never see. */
  tokens: string[];
  endedRunId: string;
  endedToken: string;
}

async function newRun(): Promise<string> {
  const [row] = await ctx.db
    .insert(agentRuns)
    .values({ type: "pipeline", featureId, stageId, agentProfileId: profileId, status: "running", prompt: "model proxy sandbox e2e" })
    .returning({ id: agentRuns.id });
  return row!.id;
}

/** The address the sandbox reaches Bento on, as an operator would set it. */
function useGateway(base: string) {
  ctx.env.BENTO_MCP_GATEWAY_URL = base;
}

async function mintFixture(gatewayBase: string, driver: SandboxDriver): Promise<Fixture> {
  useGateway(gatewayBase);
  const notes: string[] = [];
  const viaProxy = async (adapter: typeof claudeCodeAdapter, env: Record<string, string>) => {
    const runId = await newRun();
    const out = await proxyModelCredentials(ctx, {
      runId,
      organizationId: ORG,
      actingUserId: null,
      adapter,
      driver,
      env,
      say: async (text) => {
        notes.push(text);
      },
    });
    assert.ok(out.grantToken, `no token was minted: ${notes.join(" ")}`);
    return { runId, env: out.env, token: out.grantToken };
  };
  // Claude Code's run, from the organization's secrets exactly as the
  // executor resolves them; then a run on a tool that proxies OpenAI
  // and Gemini, for the bearer and query parameter styles.
  const resolved = await resolveAgentEnv(ctx, ORG, claudeCodeAdapter, MODEL, driver);
  assert.deepEqual(resolved.env, { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY });
  const claude = await viaProxy(claudeCodeAdapter, resolved.env);
  const multi = await viaProxy(opencodeAdapter, { OPENAI_API_KEY: KEYS.OPENAI_API_KEY, GEMINI_API_KEY: KEYS.GEMINI_API_KEY });
  const revoked = await viaProxy(claudeCodeAdapter, resolved.env);
  await revokeRunGrant(ctx, revoked.runId);
  const ended = await viaProxy(claudeCodeAdapter, resolved.env);
  assert.deepEqual(notes, [], "every key went behind the proxy");
  // The live token with its prefix swapped: refused before any lookup.
  const wrongPrefix = `sk-${claude.token.slice(4)}`;
  return {
    env: {
      ...claude.env,
      ...multi.env,
      BENTO_E2E_REVOKED_TOKEN: revoked.token,
      BENTO_E2E_ENDED_TOKEN: ended.token,
      BENTO_E2E_WRONG_PREFIX_TOKEN: wrongPrefix,
    },
    tokens: [claude.token, multi.token, revoked.token, ended.token, wrongPrefix],
    endedRunId: ended.runId,
    endedToken: ended.token,
  };
}

/**
 * On Actions, the tokens are masked in the job's log. Nothing here
 * prints one; this is for an assertion that would. Only for the remote
 * suites, run with the spec reporter: under TAP the line would be
 * printed as a comment and the command never read.
 */
function maskInActions(values: readonly string[]) {
  if (!process.env.GITHUB_ACTIONS) return;
  for (const value of values) console.log(`::add-mask::${value}`);
}

// ---------------------------------------------------------------------------
// The case list

/**
 * One curl from inside the sandbox. `url` and `headers` are written
 * inside double quotes, so `$NAME` is the sandbox's own variable (the
 * tokens never appear in the script); `body` inside single quotes.
 */
interface SandboxRequest {
  id: string;
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: string[];
  body?: string;
  maxTimeSec?: number;
  extraArgs?: string[];
}

interface CurlResult {
  /** curl's own exit code. */
  rc: number;
  /** The HTTP status, or 000 when no response came back. */
  status: string;
  body: string;
  error: string;
}

type Expectation =
  | { kind: "provider"; path: string; header: "x-api-key" | "authorization" | "x-goog-api-key"; key: string }
  | { kind: "refused"; endpoint?: { provider: string; method: string; path: string } };

interface ProxyCase {
  name: string;
  request: SandboxRequest;
  expect: Expectation;
}

const MESSAGE_BODY = JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const ANTHROPIC_HEADERS = ["anthropic-version: 2023-06-01", "content-type: application/json"];
const anthropicMessages = (credential: string | null): SandboxRequest => ({
  id: "",
  method: "POST",
  url: "$ANTHROPIC_BASE_URL/v1/messages",
  headers: [...ANTHROPIC_HEADERS, ...(credential ? [`x-api-key: ${credential}`] : [])],
  body: MESSAGE_BODY,
});
const GEMINI_GENERATE = "$GOOGLE_GEMINI_BASE_URL/v1beta/models/gemini-2.5-flash:generateContent";

/** Valid tokens, for what their grants name: each reaches the provider once, with the organization's key. */
const PASSING_CASES: ProxyCase[] = [
  {
    name: "Anthropic's x-api-key carries the token, and the provider gets the organization's key",
    request: { ...anthropicMessages("$ANTHROPIC_API_KEY"), id: "anthropic-x-api-key" },
    expect: { kind: "provider", path: "/vendor/anthropic/v1/messages", header: "x-api-key", key: KEYS.ANTHROPIC_API_KEY },
  },
  {
    name: "an allowed GET endpoint passes",
    request: { id: "anthropic-models", method: "GET", url: "$ANTHROPIC_BASE_URL/v1/models", headers: ["x-api-key: $ANTHROPIC_API_KEY", "anthropic-version: 2023-06-01"] },
    expect: { kind: "provider", path: "/vendor/anthropic/v1/models", header: "x-api-key", key: KEYS.ANTHROPIC_API_KEY },
  },
  {
    name: "OpenAI's Authorization Bearer carries the token, and the provider gets a bearer key",
    request: {
      id: "openai-bearer",
      method: "POST",
      url: "$OPENAI_BASE_URL/responses",
      headers: ["authorization: Bearer $OPENAI_API_KEY", "content-type: application/json"],
      body: "{}",
    },
    expect: { kind: "provider", path: "/vendor/openai/responses", header: "authorization", key: KEYS.OPENAI_API_KEY },
  },
  {
    name: "Gemini's key query parameter carries the token, and the provider gets the key in its header and no key in the query",
    request: {
      id: "gemini-query-key",
      method: "POST",
      url: `${GEMINI_GENERATE}?key=$GEMINI_API_KEY`,
      headers: ["content-type: application/json"],
      body: "{}",
    },
    expect: { kind: "provider", path: "/vendor/gemini/v1beta/models/gemini-2.5-flash:generateContent", header: "x-goog-api-key", key: KEYS.GEMINI_API_KEY },
  },
  {
    name: "the token of a run about to be cancelled still works while the run is running",
    request: { ...anthropicMessages("$BENTO_E2E_ENDED_TOKEN"), id: "ended-run-while-running" },
    expect: { kind: "provider", path: "/vendor/anthropic/v1/messages", header: "x-api-key", key: KEYS.ANTHROPIC_API_KEY },
  },
];

const refused: Expectation = { kind: "refused" };

/** Every one the same 404, and none reaches the provider. */
const REFUSED_TOKEN_CASES: ProxyCase[] = [
  { name: "no token", request: { ...anthropicMessages(null), id: "no-token" }, expect: refused },
  { name: "a garbage token", request: { ...anthropicMessages("not-a-run-token"), id: "garbage-token" }, expect: refused },
  { name: "a token never minted", request: { ...anthropicMessages("bmg_never-minted-token"), id: "unknown-token" }, expect: refused },
  { name: "a live token with the wrong prefix", request: { ...anthropicMessages("$BENTO_E2E_WRONG_PREFIX_TOKEN"), id: "wrong-prefix" }, expect: refused },
  {
    name: "a garbage bearer token",
    request: { id: "garbage-bearer", method: "POST", url: "$OPENAI_BASE_URL/responses", headers: ["authorization: Bearer bmg_never-minted-token"], body: "{}" },
    expect: refused,
  },
  { name: "a garbage key query parameter", request: { id: "garbage-query", method: "POST", url: `${GEMINI_GENERATE}?key=bmg_never-minted-token`, body: "{}" }, expect: refused },
  {
    name: "a valid token for a provider its grant does not name, as a bearer",
    request: { id: "wrong-provider-bearer", method: "POST", url: "$OPENAI_BASE_URL/responses", headers: ["authorization: Bearer $ANTHROPIC_API_KEY"], body: "{}" },
    expect: refused,
  },
  {
    name: "a valid token for a provider its grant does not name, as a query parameter",
    request: { id: "wrong-provider-query", method: "POST", url: `${GEMINI_GENERATE}?key=$ANTHROPIC_API_KEY`, body: "{}" },
    expect: refused,
  },
  { name: "a revoked grant", request: { ...anthropicMessages("$BENTO_E2E_REVOKED_TOKEN"), id: "revoked" }, expect: refused },
  { name: "a run cancelled by a bare update, with no revoke", request: { ...anthropicMessages("$BENTO_E2E_ENDED_TOKEN"), id: "ended-run" }, expect: refused },
];

/** Live tokens on endpoints outside the provider's list: refused, reported, never sent on. */
const REFUSED_ENDPOINT_CASES: ProxyCase[] = [
  {
    name: "Anthropic's files API",
    request: { id: "anthropic-files", method: "POST", url: "$ANTHROPIC_BASE_URL/v1/files", headers: ["x-api-key: $ANTHROPIC_API_KEY"], body: "{}" },
    expect: { kind: "refused", endpoint: { provider: "anthropic", method: "POST", path: "/v1/files" } },
  },
  {
    name: "a DELETE on Anthropic's messages endpoint",
    request: { id: "anthropic-delete", method: "DELETE", url: "$ANTHROPIC_BASE_URL/v1/messages", headers: ["x-api-key: $ANTHROPIC_API_KEY"] },
    expect: { kind: "refused", endpoint: { provider: "anthropic", method: "DELETE", path: "/v1/messages" } },
  },
  {
    name: "Anthropic's admin API",
    request: { id: "anthropic-admin", method: "GET", url: "$ANTHROPIC_BASE_URL/v1/organizations/api_keys", headers: ["x-api-key: $ANTHROPIC_API_KEY"] },
    expect: { kind: "refused", endpoint: { provider: "anthropic", method: "GET", path: "/v1/organizations/api_keys" } },
  },
  {
    name: "OpenAI's files API",
    request: { id: "openai-files", method: "POST", url: "$OPENAI_BASE_URL/files", headers: ["authorization: Bearer $OPENAI_API_KEY"], body: "{}" },
    expect: { kind: "refused", endpoint: { provider: "openai", method: "POST", path: "/files" } },
  },
  {
    name: "OpenAI's fine tuning API",
    request: { id: "openai-fine-tuning", method: "POST", url: "$OPENAI_BASE_URL/fine_tuning/jobs", headers: ["authorization: Bearer $OPENAI_API_KEY"], body: "{}" },
    expect: { kind: "refused", endpoint: { provider: "openai", method: "POST", path: "/fine_tuning/jobs" } },
  },
  {
    name: "a DELETE of an OpenAI model",
    request: { id: "openai-delete-model", method: "DELETE", url: "$OPENAI_BASE_URL/models/ft-model", headers: ["authorization: Bearer $OPENAI_API_KEY"] },
    expect: { kind: "refused", endpoint: { provider: "openai", method: "DELETE", path: "/models/ft-model" } },
  },
  {
    name: "Gemini's files API",
    request: { id: "gemini-files", method: "POST", url: "$GOOGLE_GEMINI_BASE_URL/v1beta/files?key=$GEMINI_API_KEY", body: "{}" },
    expect: { kind: "refused", endpoint: { provider: "gemini", method: "POST", path: "/v1beta/files" } },
  },
];

const DOUBLE_QUOTE_SAFE = /^[^"`\\]*$/;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * One shell script for a batch: each request's id, curl's exit code,
 * the status, and the body and curl's error (base64), one line apiece.
 * A batch is one exec, which is what keeps a remote machine's round
 * trips to a handful.
 */
function curlScript(requests: readonly SandboxRequest[]): string {
  const lines = ["d=$(mktemp -d)"];
  for (const request of requests) {
    assert.match(request.id, /^[a-z0-9-]+$/, `a request id is a word: ${request.id}`);
    for (const word of [request.url, ...(request.headers ?? []), ...(request.extraArgs ?? [])]) {
      assert.match(word, DOUBLE_QUOTE_SAFE, `${request.id}: written inside double quotes, so no quote, backtick or backslash`);
    }
    const args = [
      "curl",
      "-sS",
      "--max-time",
      String(request.maxTimeSec ?? 30),
      ...(request.extraArgs ?? []).map((arg) => `"${arg}"`),
      "-X",
      request.method,
      "-o",
      `"$d/${request.id}"`,
      "-w",
      "'%{http_code}'",
      "-H",
      `"x-bento-e2e-case: ${request.id}"`,
    ];
    for (const header of request.headers ?? []) args.push("-H", `"${header}"`);
    if (request.body !== undefined) args.push("--data-binary", shellQuote(request.body));
    args.push(`"${request.url}"`);
    lines.push(`code=$(${args.join(" ")} 2>"$d/${request.id}.err"); rc=$?`);
    lines.push(
      `printf '@@ %s %s %s %s %s\\n' '${request.id}' "$rc" "\${code:-000}" ` +
        `"$( [ -f "$d/${request.id}" ] && base64 < "$d/${request.id}" | tr -d '\\n')" ` +
        `"$( [ -f "$d/${request.id}.err" ] && head -c 400 "$d/${request.id}.err" | base64 | tr -d '\\n')"`,
    );
  }
  lines.push(`rm -rf "$d"`);
  return lines.join("\n");
}

function parseCurlOutput(stdout: string): Map<string, CurlResult> {
  const results = new Map<string, CurlResult>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("@@ ")) continue;
    const [, id, rc, status, body, error] = line.split(" ");
    if (!id) continue;
    results.set(id, {
      rc: Number(rc),
      status: status || "000",
      body: Buffer.from(body ?? "", "base64").toString("utf8"),
      error: Buffer.from(error ?? "", "base64").toString("utf8").trim(),
    });
  }
  return results;
}

/** Where a suite runs its requests. */
interface Target {
  label: string;
  driver: SandboxDriver;
  handle: SandboxHandle;
  /** How the sandbox reaches the proxy: loopback here, the tunnel for a real machine. */
  gatewayBase: string;
  /** Variables of the sandbox itself, under the run's. */
  baseEnv?: Record<string, string>;
  /** A real machine: its tokens are masked, and Claude Code takes a turn in it. */
  remote: boolean;
}

/** Runs a batch inside the sandbox, through the driver's own exec. */
async function inSandbox(target: Target, requests: readonly SandboxRequest[], env: Record<string, string>): Promise<Map<string, CurlResult>> {
  const result = await collectExec(
    target.driver.exec(target.handle, ["sh", "-c", curlScript(requests)], {
      cwd: target.handle.workdir,
      env: { ...target.baseEnv, ...env },
      timeoutMs: 5 * 60_000,
    }),
  );
  const out = parseCurlOutput(result.stdout);
  for (const request of requests) {
    if (!out.has(request.id)) {
      assert.fail(`${target.label}: the sandbox reported nothing for ${request.id} (exit ${result.exitCode}): ${result.stderr.slice(-600)}`);
    }
  }
  return out;
}

const NOT_FOUND_BODY = { error: "not found" };

function describeSent(sent: string | string[] | undefined, tokens: readonly string[]): string {
  if (sent === undefined) return "nothing";
  const value = Array.isArray(sent) ? sent.join(",") : sent;
  return tokens.some((token) => value.includes(token)) ? "a run token" : "some other value";
}

function carriesToken(call: ProviderCall, tokens: readonly string[]): boolean {
  const seen = `${call.url} ${JSON.stringify(call.headers)}`;
  return tokens.some((token) => seen.includes(token));
}

async function assertPassed(t: TestContext, cases: readonly ProxyCase[], results: Map<string, CurlResult>, fixture: Fixture) {
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const result = results.get(entry.request.id)!;
      assert.equal(result.status, "200", `${entry.request.id}: status ${result.status}, curl ${result.rc} ${result.error}`);
      assert.equal(entry.expect.kind, "provider");
      if (entry.expect.kind !== "provider") return;
      const calls = providerCalls.filter((call) => call.caseId === entry.request.id);
      assert.equal(calls.length, 1, `${entry.request.id} reached the provider ${calls.length} times`);
      const call = calls[0]!;
      assert.equal(call.method, entry.request.method);
      const reached = new URL(call.url, "http://provider.invalid");
      assert.equal(reached.pathname, entry.expect.path, "the vendor's own path, under its default upstream");
      assert.equal(reached.searchParams.has("key"), false, "no key in the query the provider saw");
      const sent = call.headers[entry.expect.header];
      const wanted = entry.expect.header === "authorization" ? `Bearer ${entry.expect.key}` : entry.expect.key;
      assert.ok(sent === wanted, `the provider got ${describeSent(sent, fixture.tokens)} in ${entry.expect.header}, not the organization's key`);
      assert.ok(!carriesToken(call, fixture.tokens), "a run token reached the provider");
      const callerHeaders = Object.keys(call.headers).filter((name) => /^(cf-|x-forwarded-|forwarded$|x-real-ip$)/.test(name));
      assert.deepEqual(callerHeaders, [], "nothing about the sandbox's connection reached the provider");
    });
  }
}

async function assertRefused(t: TestContext, cases: readonly ProxyCase[], results: Map<string, CurlResult>, fixture: Fixture) {
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const result = results.get(entry.request.id)!;
      assert.equal(result.status, "404", `${entry.request.id}: status ${result.status}, curl ${result.rc} ${result.error}`);
      assert.deepEqual(parseJson(result.body), NOT_FOUND_BODY, "the same body as every refusal");
      assert.equal(providerCalls.filter((call) => call.caseId === entry.request.id).length, 0, "it never reached the provider");
      const endpoint = entry.expect.kind === "refused" ? entry.expect.endpoint : undefined;
      if (endpoint) {
        const reported = refusalReports.filter(
          (report) => report.provider === endpoint.provider && report.method === endpoint.method && report.path === endpoint.path,
        );
        assert.equal(reported.length, 1, "the refused endpoint went to error tracking once");
        assert.ok(!fixture.tokens.some((token) => JSON.stringify(reported).includes(token)), "and the report carries no token");
      }
    });
  }
}

/** Waits until the database's announcement has emptied the proxy's cache of this token. */
async function evicted(token: string): Promise<void> {
  const cache = modelProxyCacheFor(ctx);
  const deadline = Date.now() + 15_000;
  while (cache.get(hashGrantToken(token))) {
    if (Date.now() > deadline) assert.fail("the ended run's grant was never evicted from the proxy's cache");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The network a locked team's Modal run gets, computed by Bento for the driver given. */
async function computedModalNetwork(driver: SandboxDriver) {
  const saved = ctx.drivers;
  ctx.drivers = singleDriver(driver);
  try {
    return await modalNetworkForProject(ctx, projectId, ORG, "claude-code", MODEL);
  } finally {
    ctx.drivers = saved;
  }
}

function assertModalNetwork(network: Awaited<ReturnType<typeof computedModalNetwork>>, gatewayBase: string) {
  assert.equal(network.network, "restricted");
  assert.deepEqual(
    modalOutboundAllowlist(network),
    [new URL(gatewayBase).hostname, ALLOWED_SITE],
    "the gateway and the team's allowed site, and no provider host: the proxy carries the key",
  );
}

/** The whole case list, run from inside one sandbox. */
async function proxySuite(t: TestContext, target: Target) {
  let fixture!: Fixture;
  await t.test("the sandbox's environment is the token and the proxy's address, built by proxyModelCredentials", async () => {
    fixture = await mintFixture(target.gatewayBase, target.driver);
    if (target.remote) maskInActions(fixture.tokens);
    const base = `${target.gatewayBase}/api/model-proxy`;
    assert.equal(fixture.env.ANTHROPIC_BASE_URL, `${base}/anthropic`);
    assert.equal(fixture.env.OPENAI_BASE_URL, `${base}/openai`);
    assert.equal(fixture.env.GOOGLE_GEMINI_BASE_URL, `${base}/gemini`);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
      assert.ok(fixture.env[name]?.startsWith("bmg_"), `${name} holds a run token`);
    }
    const leaked = Object.values(fixture.env).filter((value) => Object.values(KEYS).some((key) => value.includes(key)));
    assert.equal(leaked.length, 0, "no organization key is in the sandbox's environment");
  });

  await t.test("the sandbox reaches the proxy", async () => {
    const ready = await inSandbox(
      target,
      [
        {
          id: "ready",
          method: "GET",
          url: `${target.gatewayBase}/proxy-e2e/ready`,
          maxTimeSec: 15,
          // The tunnel's name may still be settling in the sandbox's resolver.
          extraArgs: ["--fail", "--retry", "12", "--retry-delay", "5", "--retry-all-errors"],
        },
      ],
      {},
    );
    const result = ready.get("ready")!;
    assert.equal(result.status, "200", `curl ${result.rc}: ${result.error}`);
    assert.equal(result.body, readyNonce, "this proxy, not an edge page");
  });

  await t.test("valid tokens reach the provider, which sees the organization's key and never the token", async (st) => {
    providerCalls.length = 0;
    const results = await inSandbox(target, PASSING_CASES.map((entry) => entry.request), fixture.env);
    await assertPassed(st, PASSING_CASES, results, fixture);
  });

  let refusals!: Map<string, CurlResult>;
  let refusedCalls = -1;
  await t.test("a run ended by a bare update loses its token once the database's announcement reaches the proxy", async () => {
    assert.ok(modelProxyCacheFor(ctx).get(hashGrantToken(fixture.endedToken)), "the proxy cached the grant while the run was running");
    // What a cancel route does: the status, and no revoke.
    await ctx.db.update(agentRuns).set({ status: "cancelled", endedAt: new Date() }).where(eq(agentRuns.id, fixture.endedRunId));
    await evicted(fixture.endedToken);
    providerCalls.length = 0;
    refusalReports.length = 0;
    resetRefusalReports();
    refusals = await inSandbox(target, [...REFUSED_TOKEN_CASES, ...REFUSED_ENDPOINT_CASES].map((entry) => entry.request), fixture.env);
    refusedCalls = providerCalls.length;
  });

  await t.test("every refused token is the same 404, and nothing reaches the provider", async (st) => {
    assert.equal(refusedCalls, 0, "no refused request reached the provider");
    await assertRefused(st, REFUSED_TOKEN_CASES, refusals, fixture);
  });

  await t.test("the endpoint allowlist holds from the sandbox: a live token off the list is a 404 that never reaches the provider", async (st) => {
    await assertRefused(st, REFUSED_ENDPOINT_CASES, refusals, fixture);
    assert.equal(refusalReports.length, REFUSED_ENDPOINT_CASES.length, "only the endpoint refusals were reported");
  });

  return { claudeEnv: () => ({ ANTHROPIC_API_KEY: fixture.env.ANTHROPIC_API_KEY!, ANTHROPIC_BASE_URL: fixture.env.ANTHROPIC_BASE_URL! }), tokens: () => fixture.tokens };
}

/** One turn of the Claude Code the toolchain installed, through the proxy, to the stand-in. */
async function claudeTurn(t: TestContext, target: Target, suite: Awaited<ReturnType<typeof proxySuite>>) {
  await t.test("Claude Code, as installed in the sandbox, finishes a turn through the proxy", { timeout: 5 * 60_000 }, async () => {
    const credentials = suite.claudeEnv();
    const input: BuildCommandInput = { prompt: "Say hello.", model: MODEL, cwd: target.handle.workdir, credentials };
    const argv = claudeCodeAdapter.buildCommand(input);
    // As mergeAgentExecEnv layers it: the tool's own variables, then the credentials.
    const env = { ...(claudeCodeAdapter.env?.(input) ?? {}), ...credentials };
    providerCalls.length = 0;
    refusalReports.length = 0;
    resetRefusalReports();
    const result = await runAgent({
      adapter: claudeCodeAdapter,
      argv,
      exec: () => target.driver.exec(target.handle, argv, { cwd: target.handle.workdir, env, timeoutMs: 4 * 60_000 }),
      onEvent: async () => {},
    });
    assert.equal(result.outcome.ok, true, `Claude Code's turn failed: ${result.outcome.error ?? "no error given"}`);
    assert.deepEqual(refusalReports, [], "the proxy refused none of Claude Code's requests");
    const modelCalls = providerCalls.filter((call) => call.method === "POST");
    assert.ok(modelCalls.length > 0, "Claude Code's model calls reached the provider");
    const tokens = suite.tokens();
    for (const call of modelCalls) {
      assert.match(call.url, /^\/vendor\/anthropic\/v1\/messages/);
      assert.ok(call.headers["x-api-key"] === KEYS.ANTHROPIC_API_KEY, `the provider got ${describeSent(call.headers["x-api-key"], tokens)}, not the organization's key`);
    }
    assert.ok(!providerCalls.some((call) => carriesToken(call, tokens)), "the run token never reached the provider");
  });
}

// ---------------------------------------------------------------------------
// The suites

test("from a local stand-in sandbox, the case list and the allowlist Bento computes", { timeout: 2 * 60_000 }, async (t) => {
  const driver = new LocalProcessDriver();
  const dir = await mkdtemp(path.join(tmpdir(), "bento-proxy-sandbox-"));
  const handle = await driver.provision({ projectId, workspaceKey: "proxy-sandbox-local", hostWorkspacePath: dir });
  const target: Target = {
    label: "local",
    driver,
    handle,
    gatewayBase: proxyLocalUrl,
    // A developer's shell may carry a proxy of its own.
    baseEnv: { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    remote: false,
  };
  await proxySuite(t, target);

  await t.test("a locked team's Modal allowlist names the gateway and its allowed site, and no proxied provider's host", async () => {
    useGateway("https://proxy-gateway.example");
    const network = await computedModalNetwork({ provider: "modal", workspace: "clone" } as SandboxDriver);
    assertModalNetwork(network, "https://proxy-gateway.example");
    assert.ok(network.allowedHosts?.includes("https://proxy-gateway.example"));
  });
});

test("from a real Fly Sprite", { skip: spriteSkip, timeout: 35 * 60_000 }, async (t) => {
  const gatewayBase = await publicProxyUrl();
  const driver = new SpriteDriver({ token: spritesToken!, cpus: 1, ramMB: 2048, timeoutMs: 25 * 60_000 });
  const named: SandboxHandle = { externalId: spriteName(workspaceKey), provider: "sprite", workdir: "/workspace" };
  t.after(async () => {
    await driver.destroy(named);
    assert.equal(await driver.exists(named), false, `the sprite ${named.externalId} outlived the test`);
  });
  const handle = await driver.provision({
    projectId: "proxy-sandbox-e2e",
    workspaceKey,
    hostWorkspacePath: "/unused",
    agentBinaries: ["claude"],
    onProgress: (message) => {
      console.log(`  ${message}`);
    },
  });
  const target: Target = { label: "sprite", driver, handle, gatewayBase, remote: true };
  const suite = await proxySuite(t, target);
  // No network allowlist here: a sprite cannot restrict egress, so a
  // locked team's runs never go to one (provisionWorkspace sends them
  // straight to Modal). The Modal suite checks the allowlist.
  await claudeTurn(t, target, suite);
});

test("from a real Modal sandbox on the restricted network Bento computes", { skip: modalSkip, timeout: 30 * 60_000 }, async (t) => {
  const gatewayBase = await publicProxyUrl();
  const driver = new ModalDriver({
    tokenId: modalTokenId!,
    tokenSecret: modalTokenSecret!,
    ...(process.env.MODAL_ENVIRONMENT ? { environment: process.env.MODAL_ENVIRONMENT } : {}),
    cpu: 1,
    memoryMiB: 2048,
  });
  const named: SandboxHandle = { externalId: modalSandboxName(workspaceKey), provider: "modal", workdir: "/workspace" };
  t.after(async () => {
    await driver.destroy(named);
    assert.equal(await driver.exists(named), false, `the Modal sandbox ${named.externalId} outlived the test`);
  });

  useGateway(gatewayBase);
  const network = await computedModalNetwork(driver);
  await t.test("the allowlist names the tunnel and the allowed site, and not the proxied provider's host", () => {
    assertModalNetwork(network, gatewayBase);
  });
  const handle = await driver.provision({
    projectId: "proxy-sandbox-e2e",
    workspaceKey,
    hostWorkspacePath: "/tmp/unused",
    agentBinaries: ["claude"],
    ...network,
    onProgress: (message) => {
      console.log(`  ${message}`);
    },
  });
  const target: Target = { label: "modal", driver, handle, gatewayBase, remote: true };
  // Every call in here goes out through the restricted network, so the
  // case list also proves the gateway is on it.
  const suite = await proxySuite(t, target);

  await t.test("the restricted network reaches the allowed site, and neither the proxied provider's host nor a host nobody listed", async () => {
    const results = await inSandbox(
      target,
      [
        { id: "allowed-site", method: "GET", url: ALLOWED_SITE_URL, maxTimeSec: 20 },
        ...UNLISTED_URLS.map((url, index): SandboxRequest => ({ id: `unlisted-${index}`, method: "GET", url, maxTimeSec: 15 })),
      ],
      {},
    );
    const allowed = results.get("allowed-site")!;
    assert.notEqual(allowed.status, "000", `${ALLOWED_SITE_URL} is on the list and did not answer: curl ${allowed.rc} ${allowed.error}`);
    UNLISTED_URLS.forEach((url, index) => {
      const result = results.get(`unlisted-${index}`)!;
      assert.equal(result.status, "000", `${url} answered ${result.status} from a box that does not list it`);
      assert.notEqual(result.rc, 0, `curl reached ${url}`);
    });
  });

  await claudeTurn(t, target, suite);
});

test("the workflow deletes by name the machines these suites create", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflow = await readFile(path.join(here, "../../../.github/workflows/model-proxy-e2e.yml"), "utf8");
  const fromRun = `${WORKSPACE_PREFIX}\${{ github.run_id }}-\${{ github.run_attempt }}`;
  for (const name of [spriteName(fromRun), modalSandboxName(fromRun)]) {
    assert.ok(workflow.includes(name), `the workflow does not delete ${name}, so a cancelled run would leak its machine`);
  }
  for (const script of ["scripts/delete-sprite.ts", "scripts/delete-modal-sandbox.ts"]) {
    assert.ok(workflow.includes(script), `the workflow no longer runs ${script}`);
    await readFile(path.join(here, "../../../packages/sandbox", script), "utf8");
  }
  assert.ok(workflow.includes("src/model-proxy-sandbox.e2e.test.ts"), "the workflow runs this file");
});
