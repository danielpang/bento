import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import pg from "pg";
import {
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  piAdapter,
  runAgent,
  type AgentAdapter,
  type BuildCommandInput,
} from "@bento/agents";
import { agentProfiles, agentRuns, createDb, createPool, features, pipelines, projects, runMigrations, secrets, stages } from "@bento/db";
import { LocalProcessDriver } from "@bento/sandbox";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { ensureLocalUser } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { mintRunGrant } from "./mcp/grants.js";
import { grantedModelCredentials, proxiedAgentEnv } from "./orchestrator/model-proxy-env.js";
import { SecretBox } from "./secrets.js";

/**
 * The real CLIs, through Bento's model proxy, to a stand-in provider.
 *
 * Each tool is given exactly what a multi mode run gives it: the run
 * token under its key's own name, the proxy's address in its base URL
 * variable, and whatever its adapter builds from those (argv, tool
 * environment, files). The proxy is the real route on a real server,
 * swapping the organization's key in; the provider is a stand-in on
 * loopback that speaks just enough of each API to finish a turn, and
 * says what it was sent. A pass means the CLI put the token where the
 * proxy looks and called a path the provider serves.
 *
 * The CLIs have to be on PATH, so this is off by default:
 *
 *   BENTO_LIVE_CLI_E2E=1 node --test --import tsx src/model-proxy-cli.e2e.test.ts
 *
 * Verified with Claude Code 2.1.308, codex-cli 0.163.0, pi 1.4.0 and
 * opencode 1.19.4.
 */
const skip = process.env.BENTO_LIVE_CLI_E2E ? false : "set BENTO_LIVE_CLI_E2E=1 with claude, codex, pi and opencode on PATH";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "model_proxy_cli_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const ANTHROPIC_KEY = "sk-ant-org-key";
const OPENAI_KEY = "sk-openai-org-key";

let ctx: AppContext | undefined;
let bento: ReturnType<typeof serve> | undefined;
let bentoUrl = "";
let provider: Server | undefined;
let providerUrl = "";
let runIds: string[] = [];
const calls: { url: string; method: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  if (skip) return;
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
  ctx = { env, db, pool, bus: new EventBus(), secretBox: new SecretBox("test-encryption-key-at-least-32-chars"), userId } as unknown as AppContext;

  provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers });
    const request = JSON.parse(body || "{}") as { stream?: boolean; model?: string };
    if (req.method === "POST" && req.url?.includes("/v1/messages")) return anthropicReply(res, request);
    if (req.method === "POST" && req.url?.includes("/responses")) return responsesReply(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;

  const app = createApp(ctx);
  bentoUrl = await new Promise<string>((resolve) => {
    bento = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });

  const save = (name: string, value: string) =>
    db.insert(secrets).values({ ownerId: userId, organizationId: null, name, ciphertext: ctx!.secretBox.encrypt(value), hint: "" });
  await save("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
  await save("ANTHROPIC_BASE_URL", providerUrl);
  await save("OPENAI_API_KEY", OPENAI_KEY);
  await save("OPENAI_BASE_URL", `${providerUrl}/v1`);

  const [project] = await db.insert(projects).values({ ownerId: userId, name: "p", defaultBranch: "main" }).returning();
  const [pipeline] = await db.insert(pipelines).values({ projectId: project!.id, name: "p" }).returning();
  const [stage] = await db.insert(stages).values({ pipelineId: pipeline!.id, slug: "s", name: "S", position: 0 }).returning();
  const [feature] = await db.insert(features).values({ projectId: project!.id, pipelineId: pipeline!.id, title: "f" }).returning();
  const [profile] = await db.insert(agentProfiles).values({ ownerId: userId, name: "a", cli: "fake", model: "m" }).returning();
  runIds = [];
  for (let i = 0; i < 8; i++) {
    const [run] = await db
      .insert(agentRuns)
      .values({ type: "pipeline", featureId: feature!.id, stageId: stage!.id, agentProfileId: profile!.id, status: "running", prompt: "" })
      .returning();
    runIds.push(run!.id);
  }
});

after(async () => {
  bento?.close();
  provider?.close();
  await ctx?.pool.end();
});

function anthropicReply(res: import("node:http").ServerResponse, request: { stream?: boolean; model?: string }) {
  const text = "Hello from the stand-in provider.";
  if (!request.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_side", type: "message", role: "assistant", model: request.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}

function responsesReply(res: import("node:http").ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (o: Record<string, unknown>) => res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`);
  const id = "resp_1";
  const text = "Hello from the stand-in provider.";
  ev({ type: "response.created", response: { id } });
  ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: `${id}_m`, content: [] } });
  ev({ type: "response.output_text.delta", item_id: `${id}_m`, output_index: 0, content_index: 0, delta: text });
  ev({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: `${id}_m`, content: [{ type: "output_text", text }] } });
  ev({ type: "response.completed", response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 4, output_tokens_details: null, total_tokens: 14 } } });
  res.end();
}

/** One one-shot run of a real CLI with the environment a proxied multi mode run gets. */
async function proxiedRun(adapter: AgentAdapter, model: string, keys: string[], runIndex: number) {
  const resolved: Record<string, string> = {
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    ANTHROPIC_BASE_URL: providerUrl,
    OPENAI_API_KEY: OPENAI_KEY,
    OPENAI_BASE_URL: `${providerUrl}/v1`,
  };
  const runEnv = Object.fromEntries(Object.entries(resolved).filter(([name]) => keys.some((key) => name.startsWith(key.split("_")[0]!))));
  const token = await mintRunGrant(ctx!, {
    runId: runIds[runIndex]!,
    organizationId: null,
    actingUserId: null,
    serverIds: [],
    modelCredentials: grantedModelCredentials(runEnv, keys),
    ttlMs: 10 * 60_000,
  });
  const credentials = proxiedAgentEnv(runEnv, keys, bentoUrl, token);
  const home = mkdtempSync(join(tmpdir(), `bento-proxy-${adapter.cli}-`));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  mkdirSync(join(home, ".codex"));
  const input: BuildCommandInput = { prompt: "Say hello.", model, cwd, credentials };
  for (const file of adapter.files?.(input) ?? []) {
    const target = file.path.startsWith("~/") ? join(home, file.path.slice(2)) : file.path;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  // As mergeAgentExecEnv layers it: the tool's own variables, then the credentials.
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    IS_SANDBOX: "1",
    ...(adapter.env?.(input) ?? {}),
    ...credentials,
  };
  const argv = adapter.buildCommand(input);
  const driver = new LocalProcessDriver();
  const handle = await driver.provision({ workspaceKey: `proxy-${adapter.cli}`, hostWorkspacePath: cwd } as never);
  calls.length = 0;
  // The local driver layers the run's environment over this process's,
  // and a test started from inside a Claude Code session carries that
  // session's own settings, which a sandbox never has. They are set
  // aside while the CLI runs.
  const inherited = Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC|OPENAI|CODEX)/.test(name));
  const saved = Object.fromEntries(inherited.map((name) => [name, process.env[name]]));
  for (const name of inherited) delete process.env[name];
  try {
    const result = await runAgent({
      adapter,
      argv,
      exec: () => driver.exec(handle, argv, { cwd, env, timeoutMs: 120_000 }),
      onEvent: async () => {},
    });
    return { result, token, credentials };
  } finally {
    Object.assign(process.env, saved);
  }
}

function assertReachedProvider(token: string, key: string, header: "x-api-key" | "authorization") {
  const modelCalls = calls.filter((call) => call.method === "POST");
  assert.ok(modelCalls.length > 0, "the CLI's model call reached the provider through the proxy");
  for (const call of modelCalls) {
    const sent = header === "authorization" ? call.headers.authorization : call.headers["x-api-key"];
    assert.equal(sent, header === "authorization" ? `Bearer ${key}` : key, `${call.url} carried the organization's key`);
  }
  assert.ok(!calls.some((call) => JSON.stringify(call.headers).includes(token)), "the run token never reached the provider");
}

test("Claude Code reaches Anthropic through the proxy", { skip, timeout: 180_000 }, async () => {
  const { result, token, credentials } = await proxiedRun(claudeCodeAdapter, "claude-sonnet-5", ["ANTHROPIC_API_KEY"], 0);
  assert.equal(credentials.ANTHROPIC_API_KEY, token);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assert.ok(calls.some((call) => call.url.startsWith("/v1/messages")));
  assertReachedProvider(token, ANTHROPIC_KEY, "x-api-key");
});

test("Codex reaches OpenAI through the proxy, after the proxy turns down its WebSocket", { skip, timeout: 180_000 }, async () => {
  const { result, token } = await proxiedRun(codexAdapter, "gpt-5-codex", ["OPENAI_API_KEY"], 1);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assert.ok(calls.some((call) => call.url === "/v1/responses"), JSON.stringify(calls.map((c) => c.url)));
  assertReachedProvider(token, OPENAI_KEY, "authorization");
});

test("pi reaches Anthropic through the proxy", { skip, timeout: 180_000 }, async () => {
  const { result, token } = await proxiedRun(piAdapter, "anthropic/claude-sonnet-5", ["ANTHROPIC_API_KEY"], 2);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assertReachedProvider(token, ANTHROPIC_KEY, "x-api-key");
});

test("pi reaches OpenAI through the proxy", { skip, timeout: 180_000 }, async () => {
  const { result, token } = await proxiedRun(piAdapter, "openai/gpt-5-mini", ["OPENAI_API_KEY"], 3);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assert.ok(calls.some((call) => call.url === "/v1/responses"));
  assertReachedProvider(token, OPENAI_KEY, "authorization");
});

test("opencode reaches Anthropic through the proxy", { skip, timeout: 180_000 }, async () => {
  const { result, token } = await proxiedRun(opencodeAdapter, "anthropic/claude-sonnet-4-5", ["ANTHROPIC_API_KEY"], 4);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assertReachedProvider(token, ANTHROPIC_KEY, "x-api-key");
});

test("opencode reaches OpenAI through the proxy", { skip, timeout: 180_000 }, async () => {
  const { result, token } = await proxiedRun(opencodeAdapter, "openai/gpt-5-mini", ["OPENAI_API_KEY"], 5);
  assert.equal(result.outcome.ok, true, result.outcome.error);
  assertReachedProvider(token, OPENAI_KEY, "authorization");
});
