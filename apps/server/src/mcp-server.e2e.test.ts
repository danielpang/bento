import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  createPool,
  features,
  mcpConnections,
  mcpOAuthClients,
  mcpOAuthCodes,
  mcpOAuthRequests,
  pipelines,
  runMigrations,
} from "@bento/db";
import { sweepExpiredOAuth } from "./mcp/oauth-sweep.js";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { createAuth } from "./auth.js";
import type { AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { FeatureFlags } from "./feature-flags.js";

/**
 * Bento's own MCP server, end to end: a member authorizes a connection
 * in the console routes, an outside agent presents its token to
 * /mcp, and the scope chosen at authorization is what the
 * agent can reach. Cross-tenant refusals for the management routes also
 * live in auth.e2e.test.ts's matrix; this file owns the token-auth
 * endpoint, which that matrix (built on sessions) cannot probe.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "mcp_server_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-mcp-server-"));
  const env = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    BENTO_RATE_LIMIT: "false",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();

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
    userId: "",
    // Everyone is a beta tester here; the beta refusal has its own test
    // below, which swaps this out and back.
    featureFlags: new FeatureFlags(null, true),
  };
  const auth = createAuth(env, db);
  assert.ok(auth, "multi mode must construct an auth instance");
  ctx.auth = auth;
  app = createApp(ctx);
});

after(async () => {
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

function jsonPost(path_: string, body: unknown, token?: string) {
  return app.request(path_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await jsonPost("/api/auth/sign-up/email", {
    email,
    password: "correct-horse-battery",
    name,
  });
  const token = res.headers.get("set-auth-token");
  assert.ok(token, `sign-up for ${email} must hand back a session token`);
  return token;
}

async function makeOrg(token: string, name: string, slug: string): Promise<string> {
  const org = (await (await jsonPost("/api/auth/organization/create", { name, slug }, token)).json()) as {
    id: string;
  };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);
  return org.id;
}

async function makeProject(token: string, name: string): Promise<string> {
  const res = await jsonPost("/api/projects", { name, localPath: "/tmp" }, token);
  assert.equal(res.status, 201, `project ${name} must be created`);
  return ((await res.json()) as { id: string }).id;
}

const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

let rpcId = 0;

/** One JSON-RPC message to the MCP endpoint, the stateless shape. */
function rpc(token: string, method: string, params?: unknown) {
  return app.request("/api/mcp-server", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined ? { params } : {}) }),
  });
}

/** Calls a tool and unwraps the JSON its text content carries. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; data: Record<string, unknown> | null }> {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  assert.equal(res.status, 200, `tools/call ${name} must answer 200`);
  const body = (await res.json()) as {
    result?: { isError?: boolean; content: { type: string; text: string }[] };
    error?: { message: string };
  };
  assert.ok(body.result, `tools/call ${name} must answer a result, got ${JSON.stringify(body.error)}`);
  const text = body.result.content[0]?.text ?? "";
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Refusals are sentences, not JSON.
  }
  return { isError: Boolean(body.result.isError), text, data };
}

test("a team-scoped connection creates a card and follows it", async () => {
  const token = await signUp("mcp-inbound-admin@bento.test", "Admin");
  await makeOrg(token, "Inbound", "mcp-inbound");
  const projectA = await makeProject(token, "Console");
  const projectB = await makeProject(token, "Server");

  const created = await jsonPost("/api/mcp-connections", { name: "Claude Code", scope: "organization" }, token);
  assert.equal(created.status, 201);
  const connection = (await created.json()) as { id: string; token: string; tokenHint: string };
  assert.match(connection.token, /^bmcp_/, "the raw token is handed back once");
  assert.ok(!connection.tokenHint.includes(connection.token.slice(5, 20)), "the hint must not carry the token");

  // The Streamable HTTP handshake, stateless shape.
  const init = await rpc(connection.token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.status, 200);
  const initBody = (await init.json()) as {
    result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
  };
  assert.equal(initBody.result.protocolVersion, "2025-03-26", "a known protocol version is echoed");
  assert.equal(initBody.result.serverInfo.name, "bento");
  assert.ok(initBody.result.capabilities.tools, "tools are advertised");

  const note = await app.request("/api/mcp-server", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202, "a notification is accepted with no body");

  const tools = await rpc(connection.token, "tools/list");
  const toolsBody = (await tools.json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    toolsBody.result.tools.map((t) => t.name).sort(),
    ["create_feature", "get_feature_status", "list_features", "list_projects", "search_features"],
  );

  const projects_ = await callTool(connection.token, "list_projects", {});
  assert.equal(projects_.isError, false);
  const listed = (projects_.data!.projects as { id: string }[]).map((p) => p.id).sort();
  assert.deepEqual(listed, [projectA, projectB].sort(), "team scope reaches every project");

  const card = await callTool(connection.token, "create_feature", {
    projectId: projectA,
    title: "Add a settings export",
    description: "One JSON file with every setting.",
  });
  assert.equal(card.isError, false, `create_feature refused: ${card.text}`);
  const featureId = card.data!.featureId as string;
  assert.ok(featureId, "the new card's id comes back");
  assert.equal(card.data!.status, "backlog");

  // The row is the organization's, filled by the insert trigger.
  const [row] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  assert.ok(row, "the card exists");
  assert.ok(row!.organizationId, "the trigger must stamp the organization");
  assert.equal(row!.title, "Add a settings export");

  const status = await callTool(connection.token, "get_feature_status", { featureId });
  assert.equal(status.isError, false);
  assert.equal(status.data!.status, "backlog");
  assert.equal(status.data!.inBacklog, true);
  assert.equal(status.data!.stage, null);

  const board = await callTool(connection.token, "list_features", { projectId: projectA });
  assert.equal(board.isError, false);
  const cards = board.data!.features as { id: string }[];
  assert.ok(cards.some((c) => c.id === featureId), "the board lists the new card");

  // The console side sees the connection, masked.
  const listRes = await app.request("/api/mcp-connections", {
    headers: { authorization: `Bearer ${token}` },
  });
  const list = (await listRes.json()) as { connections: { name: string; tokenHint: string }[] };
  assert.equal(list.connections[0]?.name, "Claude Code");
  assert.doesNotMatch(JSON.stringify(list), /bmcp_/, "no route returns a raw token after the create");
});

test("a project-scoped connection reaches only its pinned projects", async () => {
  const token = await signUp("mcp-inbound-scoped@bento.test", "Scoped");
  await makeOrg(token, "Scoped", "mcp-scoped");
  const projectA = await makeProject(token, "Allowed");
  const projectB = await makeProject(token, "Withheld");

  const created = await jsonPost(
    "/api/mcp-connections",
    { name: "One project", scope: "projects", projectIds: [projectA] },
    token,
  );
  assert.equal(created.status, 201);
  const connection = (await created.json()) as { token: string };

  const projects_ = await callTool(connection.token, "list_projects", {});
  const listed = (projects_.data!.projects as { id: string }[]).map((p) => p.id);
  assert.deepEqual(listed, [projectA], "only the pinned project is visible");

  const refused = await callTool(connection.token, "create_feature", {
    projectId: projectB,
    title: "Should not land",
  });
  assert.equal(refused.isError, true, "a project outside the pin is refused");
  assert.match(refused.text, /not found/, "the refusal does not confirm the project exists");
  const stray = await ctx.db.select().from(features).where(eq(features.projectId, projectB));
  assert.equal(stray.length, 0, "the refused create must not have landed");

  const foreign = await callTool(connection.token, "list_features", { projectId: projectB });
  assert.equal(foreign.isError, true, "the other project's board is out of reach");

  // A feature in the withheld project is unreadable through this
  // connection, even with its real id in hand.
  const direct = await jsonPost("/api/features", { projectId: projectB, title: "Private" }, token);
  const hidden = (await direct.json()) as { id: string };
  const peek = await callTool(connection.token, "get_feature_status", { featureId: hidden.id });
  assert.equal(peek.isError, true, "a feature outside the pin reads as not found");
});

test("search finds cards by words, across projects and inside the scope", async () => {
  const token = await signUp("mcp-inbound-search@bento.test", "Searcher");
  await makeOrg(token, "Search", "mcp-search");
  const alpha = await makeProject(token, "Alpha");
  const beta = await makeProject(token, "Beta");

  const wide = (await (
    await jsonPost("/api/mcp-connections", { name: "Wide", scope: "organization" }, token)
  ).json()) as { token: string };
  const narrow = (await (
    await jsonPost("/api/mcp-connections", { name: "Narrow", scope: "projects", projectIds: [alpha] }, token)
  ).json()) as { token: string };

  const made = async (projectId: string, title: string, description: string) => {
    const res = await callTool(wide.token, "create_feature", { projectId, title, description });
    assert.equal(res.isError, false, `create_feature refused: ${res.text}`);
    return res.data!.featureId as string;
  };
  const rateLimit = await made(alpha, "Add a rate limit to the public API", "Token bucket per key.");
  await made(alpha, "Rewrite the onboarding email", "Nothing to do with limits.");
  const betaLimit = await made(beta, "Rate limit the webhook intake", "Same shape, other service.");

  // A word in the title, across every project the connection reaches.
  const wideHits = await callTool(wide.token, "search_features", { query: "rate limit" });
  assert.equal(wideHits.isError, false);
  const wideIds = (wideHits.data!.features as { id: string }[]).map((f) => f.id).sort();
  assert.deepEqual(wideIds, [rateLimit, betaLimit].sort(), "both projects' matching cards come back");
  assert.equal(wideHits.data!.truncated, false);
  const one = (wideHits.data!.features as { projectName: string; status: string; stage: unknown }[])[0]!;
  assert.ok(one.projectName, "a result names its project, since results span projects");
  assert.equal(one.status, "backlog");

  // A word only in the description still matches.
  const byBody = await callTool(wide.token, "search_features", { query: "token bucket" });
  assert.deepEqual(
    (byBody.data!.features as { id: string }[]).map((f) => f.id),
    [rateLimit],
    "the description is searched too",
  );

  // Narrowing by project, and by status.
  const inAlpha = await callTool(wide.token, "search_features", { query: "rate limit", projectId: alpha });
  assert.deepEqual((inAlpha.data!.features as { id: string }[]).map((f) => f.id), [rateLimit]);
  const gatedOnly = await callTool(wide.token, "search_features", { query: "rate limit", status: "gated" });
  assert.equal((gatedOnly.data!.features as unknown[]).length, 0, "no backlog card is gated");

  // The scope is the join, not a filter over results: a project-scoped
  // connection cannot see the other project's match at all.
  const narrowHits = await callTool(narrow.token, "search_features", { query: "rate limit" });
  assert.deepEqual(
    (narrowHits.data!.features as { id: string }[]).map((f) => f.id),
    [rateLimit],
    "a project-scoped connection searches only its own projects",
  );
  const reachOut = await callTool(narrow.token, "search_features", { query: "rate limit", projectId: beta });
  assert.equal(reachOut.isError, true, "naming a project out of scope reads as not found");
  assert.match(reachOut.text, /not found/);

  // A wildcard typed into the query is a literal, not pattern syntax.
  const wildcard = await callTool(wide.token, "search_features", { query: "%" });
  assert.equal((wildcard.data!.features as unknown[]).length, 0, "a bare % must not match every card");

  const capped = await callTool(wide.token, "search_features", { query: "e", limit: 1 });
  assert.equal((capped.data!.features as unknown[]).length, 1);
  assert.equal(capped.data!.truncated, true, "a full page says so");

  const empty = await callTool(wide.token, "search_features", { query: "" });
  assert.equal(empty.isError, true, "an empty query is refused rather than listing everything");
});

test("authorization refuses projects the caller's organization does not hold", async () => {
  const insider = await signUp("mcp-inbound-insider@bento.test", "Insider");
  await makeOrg(insider, "Held", "mcp-held");
  const heldProject = await makeProject(insider, "Held project");

  const outsider = await signUp("mcp-inbound-outsider@bento.test", "Outsider");
  await makeOrg(outsider, "Elsewhere", "mcp-elsewhere");
  const refused = await jsonPost(
    "/api/mcp-connections",
    { name: "Reach", scope: "projects", projectIds: [heldProject] },
    outsider,
  );
  assert.equal(refused.status, 404, "a foreign project id must read as not existing");

  const empty = await jsonPost("/api/mcp-connections", { name: "Reach", scope: "projects", projectIds: [] }, outsider);
  assert.equal(empty.status, 400, "project scope with no projects is a mistake worth naming");
});

test("a connection stays authorized until it is disconnected", async () => {
  const token = await signUp("mcp-inbound-persist@bento.test", "Persister");
  await makeOrg(token, "Persist", "mcp-persist");
  await makeProject(token, "Board");

  const created = await jsonPost("/api/mcp-connections", { name: "Laptop", scope: "organization" }, token);
  assert.equal(created.status, 201);
  const connection = (await created.json()) as { id: string; token: string };

  const cols = await ctx.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'mcp_connections'`,
  );
  assert.equal(
    cols.rows.some((row) => row.column_name === "expires_at"),
    false,
    "inbound connections must not expire; disconnect is what ends them",
  );

  const first = await rpc(connection.token, "ping");
  assert.equal(first.status, 200);
  const later = await rpc(connection.token, "tools/list");
  assert.equal(later.status, 200, "a later call with the same token must still be authorized");

  // Spec-following MCP clients treat 401 as a cue to start OAuth.
  const anon = await app.request("http://localhost:4400/api/mcp-server", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /resource_metadata=/);

  const gone = await app.request(`/api/mcp-connections/${connection.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(gone.status, 200);
  const dead = await rpc(connection.token, "ping");
  assert.equal(dead.status, 401, "disconnect is what ends the token");
});

test("a revoked connection stops serving immediately", async () => {
  const token = await signUp("mcp-inbound-revoke@bento.test", "Revoker");
  await makeOrg(token, "Revoke", "mcp-revoke");
  await makeProject(token, "Board");

  const created = await jsonPost("/api/mcp-connections", { name: "Doomed", scope: "organization" }, token);
  const connection = (await created.json()) as { id: string; token: string };
  assert.equal((await callTool(connection.token, "list_projects", {})).isError, false);

  const revoked = await app.request(`/api/mcp-connections/${connection.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(revoked.status, 200);

  const dead = await rpc(connection.token, "tools/list");
  assert.equal(dead.status, 401, "a revoked token reads the same as one that never existed");

  const garbage = await rpc("bmcp_not-a-real-token", "tools/list");
  assert.equal(garbage.status, 401);
});

test("a departed member's connections stop serving and are deleted", async () => {
  const admin = await signUp("mcp-inbound-owner@bento.test", "Owner");
  const orgId = await makeOrg(admin, "Departures", "mcp-departures");
  await makeProject(admin, "Shared");

  const leaver = await signUp("mcp-inbound-leaver@bento.test", "Leaver");
  const invite = (await (
    await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "mcp-inbound-leaver@bento.test", role: "member", organizationId: orgId },
      admin,
    )
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, leaver);
  await jsonPost("/api/auth/organization/set-active", { organizationId: orgId }, leaver);

  const created = await jsonPost("/api/mcp-connections", { name: "Leaver's", scope: "organization" }, leaver);
  assert.equal(created.status, 201);
  const connection = (await created.json()) as { id: string; token: string };
  assert.equal((await callTool(connection.token, "list_projects", {})).isError, false);

  await jsonPost(
    "/api/auth/organization/remove-member",
    { memberIdOrEmail: "mcp-inbound-leaver@bento.test", organizationId: orgId },
    admin,
  );

  const dead = await rpc(connection.token, "tools/list");
  assert.equal(dead.status, 401, "a removed member's token must stop resolving");
  const rows = await ctx.db.select().from(mcpConnections).where(eq(mcpConnections.id, connection.id));
  assert.equal(rows.length, 0, "the removal hook deletes the departed member's connections");
});

test("admins govern every connection; members manage only their own", async () => {
  const admin = await signUp("mcp-inbound-gov-admin@bento.test", "Gov Admin");
  const orgId = await makeOrg(admin, "Governance", "mcp-governance");
  await makeProject(admin, "Board");
  const memberUser = await signUp("mcp-inbound-gov-member@bento.test", "Gov Member");
  const invite = (await (
    await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "mcp-inbound-gov-member@bento.test", role: "member", organizationId: orgId },
      admin,
    )
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, memberUser);
  await jsonPost("/api/auth/organization/set-active", { organizationId: orgId }, memberUser);

  const adminConn = (await (
    await jsonPost("/api/mcp-connections", { name: "Admin's", scope: "organization" }, admin)
  ).json()) as { id: string };
  const memberConn = (await (
    await jsonPost("/api/mcp-connections", { name: "Member's", scope: "organization" }, memberUser)
  ).json()) as { id: string };

  const memberView = (await (
    await app.request("/api/mcp-connections", { headers: { authorization: `Bearer ${memberUser}` } })
  ).json()) as { canManage: boolean; connections: { id: string }[] };
  assert.equal(memberView.canManage, false);
  assert.deepEqual(
    memberView.connections.map((c) => c.id),
    [memberConn.id],
    "a member sees only their own connections",
  );

  const adminView = (await (
    await app.request("/api/mcp-connections", { headers: { authorization: `Bearer ${admin}` } })
  ).json()) as { connections: { id: string; ownerName: string | null }[] };
  assert.equal(adminView.connections.length, 2, "an admin sees everyone's connections");
  const theirs = adminView.connections.find((c) => c.id === memberConn.id);
  assert.equal(theirs?.ownerName, "Gov Member", "a teammate's connection is named");

  const memberRevokesAdmins = await app.request(`/api/mcp-connections/${adminConn.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${memberUser}` },
  });
  assert.equal(memberRevokesAdmins.status, 404, "a member must not revoke someone else's connection");

  const adminRevokesMembers = await app.request(`/api/mcp-connections/${memberConn.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(adminRevokesMembers.status, 200, "an admin governs every connection");
});

test("non-testers hear 404 from the management routes", async () => {
  const token = await signUp("mcp-inbound-nonbeta@bento.test", "Nonbeta");
  await makeOrg(token, "Nonbeta", "mcp-nonbeta");
  const flags = ctx.featureFlags;
  ctx.featureFlags = new FeatureFlags(null, false);
  try {
    const listed = await app.request("/api/mcp-connections", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(listed.status, 404, "off the flag, the routes do not exist");
    const created = await jsonPost("/api/mcp-connections", { name: "X", scope: "organization" }, token);
    assert.equal(created.status, 404);
    const consent = await app.request(
      "/api/mcp-oauth/consent?request=00000000-0000-0000-0000-000000000000",
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(consent.status, 404, "consent is behind the same flag");
  } finally {
    ctx.featureFlags = flags;
  }
});

test("the endpoint speaks only stateless Streamable HTTP", async () => {
  const token = await signUp("mcp-inbound-transport@bento.test", "Transport");
  await makeOrg(token, "Transport", "mcp-transport");
  const created = await jsonPost("/api/mcp-connections", { name: "T", scope: "organization" }, token);
  const connection = (await created.json()) as { token: string };

  const get = await app.request("/api/mcp-server", {
    headers: { authorization: `Bearer ${connection.token}`, accept: "text/event-stream" },
  });
  assert.equal(get.status, 405, "there is no server-initiated stream");
  const getAnon = await app.request("/api/mcp-server", { headers: { accept: "text/event-stream" } });
  assert.equal(getAnon.status, 401, "no token starts OAuth discovery");

  const unknown = await rpc(connection.token, "resources/list");
  const unknownBody = (await unknown.json()) as { error: { code: number } };
  assert.equal(unknownBody.error.code, -32601, "an unknown method is a JSON-RPC error, not a crash");

  const batch = await app.request("/api/mcp-server", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
  });
  const batchBody = (await batch.json()) as { error: { code: number } };
  assert.equal(batchBody.error.code, -32600, "batches are refused in one message");
});

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

test("Claude and Cursor connect through OAuth on /mcp", async () => {
  const origin = "http://localhost:4400";
  const redirectUri = "http://127.0.0.1:9876/callback";
  const token = await signUp("mcp-oauth-host@bento.test", "OAuth Host");
  await makeOrg(token, "OAuth", "mcp-oauth");
  await makeProject(token, "Board");

  const resourceDoc = await app.request(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resourceDoc.status, 200);
  const resourceBody = (await resourceDoc.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  assert.equal(resourceBody.resource, `${origin}/mcp`);
  assert.deepEqual(resourceBody.authorization_servers, [origin]);

  const asDoc = await app.request(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(asDoc.status, 200);
  const asBody = (await asDoc.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    code_challenge_methods_supported: string[];
  };
  assert.equal(asBody.issuer, origin);
  assert.equal(asBody.authorization_endpoint, `${origin}/mcp-oauth/authorize`);
  assert.equal(asBody.token_endpoint, `${origin}/mcp-oauth/token`);
  assert.equal(asBody.registration_endpoint, `${origin}/mcp-oauth/register`);
  assert.deepEqual(asBody.code_challenge_methods_supported, ["S256"]);

  const unauth = await app.request(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "0" } },
    }),
  });
  assert.equal(unauth.status, 401);
  assert.equal(
    unauth.headers.get("www-authenticate"),
    `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  );

  const registered = await app.request(`${origin}/mcp-oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Cursor", redirect_uris: [redirectUri] }),
  });
  assert.equal(registered.status, 201);
  const client = (await registered.json()) as { client_id: string; token_endpoint_auth_method: string };
  assert.match(client.client_id, /^mcp_/);
  assert.equal(client.token_endpoint_auth_method, "none");

  const { challenge } = pkcePair();
  const authorize = await app.request(
    `${origin}/mcp-oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      state: "cursor-state",
    })}`,
  );
  assert.equal(authorize.status, 302, "Hono must not follow the consent redirect");
  const consentUrl = new URL(authorize.headers.get("location") ?? "", origin);
  assert.equal(consentUrl.pathname, "/connect-mcp");
  const requestId = consentUrl.searchParams.get("request");
  assert.ok(requestId, "authorize must hand the consent page a request id");

  const preview = await app.request(`${origin}/api/mcp-oauth/consent?request=${requestId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(preview.status, 200);
  const previewBody = (await preview.json()) as { clientName: string; redirectUri: string };
  assert.equal(previewBody.clientName, "Cursor");
  assert.equal(previewBody.redirectUri, redirectUri);

  const denied = await jsonPost("/api/mcp-oauth/deny", { request: requestId }, token);
  assert.equal(denied.status, 200);
  const deniedBody = (await denied.json()) as { redirect: string };
  const deniedRedirect = new URL(deniedBody.redirect);
  assert.equal(deniedRedirect.origin, "http://127.0.0.1:9876");
  assert.equal(deniedRedirect.searchParams.get("error"), "access_denied");
  assert.equal(deniedRedirect.searchParams.get("state"), "cursor-state");
  assert.equal(deniedRedirect.searchParams.get("iss"), origin);

  const { verifier: verifier2, challenge: challenge2 } = pkcePair();
  const authorize2 = await app.request(
    `${origin}/mcp-oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge2,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      state: "ok",
    })}`,
  );
  const requestId2 = new URL(authorize2.headers.get("location") ?? "", origin).searchParams.get("request");
  assert.ok(requestId2);

  const approved = await jsonPost(
    "/api/mcp-oauth/consent",
    { request: requestId2, scope: "organization" },
    token,
  );
  assert.equal(approved.status, 200);
  const approvedBody = (await approved.json()) as { redirect: string };
  const codeRedirect = new URL(approvedBody.redirect);
  assert.equal(codeRedirect.searchParams.get("state"), "ok");
  assert.equal(codeRedirect.searchParams.get("iss"), origin);
  const code = codeRedirect.searchParams.get("code");
  assert.match(code ?? "", /^bmcc_/);

  const badPkce = await app.request(`${origin}/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: "wrong-verifier-value-that-is-long-enough",
    }).toString(),
  });
  assert.equal(badPkce.status, 400);
  assert.equal(((await badPkce.json()) as { error: string }).error, "invalid_grant");

  const exchanged = await app.request(`${origin}/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier2,
    }).toString(),
  });
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.match(tokens.access_token, /^bmcp_/);
  assert.match(tokens.refresh_token, /^bmcr_/);
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.expires_in, 315_360_000);

  const replay = await app.request(`${origin}/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier2,
    }).toString(),
  });
  assert.equal(replay.status, 400, "an authorization code is single-use");

  const init = await app.request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "0" } },
    }),
  });
  assert.equal(init.status, 200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initBody.result.serverInfo.name, "bento");

  const refreshed = await app.request(`${origin}/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.match(next.access_token, /^bmcp_/);
  assert.notEqual(next.access_token, tokens.access_token);
  assert.notEqual(next.refresh_token, tokens.refresh_token);

  const oldAccess = await app.request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(oldAccess.status, 401, "refresh rotates the access token");

  const newAccess = await rpc(next.access_token, "tools/list");
  assert.equal(newAccess.status, 200, "the new access token serves /mcp");

  const oldRefresh = await app.request(`${origin}/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  assert.equal(oldRefresh.status, 400, "the previous refresh token is spent");
});

test("two concurrent exchanges of one code cannot both succeed", async () => {
  const token = await signUp("mcp-race@bento.test", "Racer");
  await makeOrg(token, "Race", "mcp-race");
  await makeProject(token, "Board");
  const origin = "http://localhost:4400";

  const registered = await app.request(`${origin}/mcp-oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Racer", redirect_uris: ["http://127.0.0.1:9911/cb"] }),
  });
  assert.equal(registered.status, 201);
  const client = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await app.request(
    `${origin}/mcp-oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:9911/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      state: "race",
    })}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(authorize.status, 302);
  const requestId = new URL(authorize.headers.get("location")!, origin).searchParams.get("request");
  assert.ok(requestId);

  const consented = await jsonPost("/api/mcp-oauth/consent", { request: requestId, scope: "organization" }, token);
  assert.equal(consented.status, 200);
  const code = new URL(((await consented.json()) as { redirect: string }).redirect).searchParams.get("code");
  assert.ok(code);

  // Both requests are in flight before either finishes, which is what
  // a select-then-delete could not survive: both read the row, both
  // validated, and both were handed the same token pair.
  const exchange = () =>
    app.request(`${origin}/mcp-oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1:9911/cb",
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    });
  const [a, b] = await Promise.all([exchange(), exchange()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400], "exactly one exchange may win the code");

  const bodies = await Promise.all([a.json(), b.json()]);
  const tokens = bodies.filter((body) => (body as { access_token?: string }).access_token);
  assert.equal(tokens.length, 1, "only one token pair is ever issued for a code");
  const left = await ctx.db.select().from(mcpOAuthCodes).where(eq(mcpOAuthCodes.codeHash, hashOf(code!)));
  assert.equal(left.length, 0, "the code is gone either way");
});

test("the sweep reclaims abandoned OAuth rows and leaves live ones alone", async () => {
  const token = await signUp("mcp-sweep@bento.test", "Sweeper");
  await makeOrg(token, "Sweep", "mcp-sweep");

  // An authorization nobody finished, expired well past the grace.
  const stale = new Date(Date.now() - 4 * 60 * 60_000);
  await ctx.db.insert(mcpOAuthRequests).values({
    clientId: "abandoned-client",
    redirectUri: "http://127.0.0.1:9912/cb",
    codeChallenge: "challenge",
    resource: "http://localhost:4400/mcp",
    expiresAt: stale,
  });
  // A live one, still inside its ten minutes.
  await ctx.db.insert(mcpOAuthRequests).values({
    clientId: "live-client",
    redirectUri: "http://127.0.0.1:9913/cb",
    codeChallenge: "challenge",
    resource: "http://localhost:4400/mcp",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  // A registration old enough to be abandoned, with nothing pointing at it.
  await ctx.db.insert(mcpOAuthClients).values({
    clientId: "never-used-client",
    clientName: "Never used",
    redirectUris: ["http://127.0.0.1:9914/cb"],
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
  });

  await sweepExpiredOAuth(ctx);

  const requests = await ctx.db.select().from(mcpOAuthRequests);
  const clientIds = requests.map((row) => row.clientId);
  assert.ok(!clientIds.includes("abandoned-client"), "an expired request is reclaimed");
  assert.ok(clientIds.includes("live-client"), "a request still inside its window is left alone");

  const clients = await ctx.db.select().from(mcpOAuthClients);
  const names = clients.map((row) => row.clientId);
  assert.ok(!names.includes("never-used-client"), "an old registration with no connection is reclaimed");
});

test("create_feature says backlog when the project has no stages to start", async () => {
  const token = await signUp("mcp-nostages@bento.test", "Stageless");
  await makeOrg(token, "Stageless", "mcp-stageless");
  const projectId = await makeProject(token, "Empty");

  // A project ships with a pipeline and stages; emptying it is the
  // condition advanceFeature answers null for.
  const [pipeline] = await ctx.db.select().from(pipelines).where(eq(pipelines.projectId, projectId));
  assert.ok(pipeline);
  await ctx.pool.query("delete from stages where pipeline_id = $1", [pipeline!.id]);

  const created = await jsonPost("/api/mcp-connections", { name: "Stageless", scope: "organization" }, token);
  const connection = (await created.json()) as { token: string };

  const card = await callTool(connection.token, "create_feature", {
    projectId,
    title: "Nowhere to go",
    start: true,
  });
  assert.equal(card.isError, false);
  assert.equal(card.data!.status, "backlog", "the card did not start, so it must not be reported as active");
  assert.equal(card.data!.inBacklog, true);
  assert.match(String(card.data!.note ?? ""), /no stages/, "and the agent is told why");

  const status = await callTool(connection.token, "get_feature_status", {
    featureId: card.data!.featureId as string,
  });
  assert.equal(status.data!.status, "backlog", "the card really is in the backlog");
});

test("list_features caps what it returns and says when it did", async () => {
  const token = await signUp("mcp-listcap@bento.test", "Capper");
  await makeOrg(token, "Cap", "mcp-cap");
  const projectId = await makeProject(token, "Busy");
  const created = await jsonPost("/api/mcp-connections", { name: "Cap", scope: "organization" }, token);
  const connection = (await created.json()) as { token: string };

  for (let i = 0; i < 5; i += 1) {
    const made = await callTool(connection.token, "create_feature", { projectId, title: `Card ${i}` });
    assert.equal(made.isError, false);
  }

  const capped = await callTool(connection.token, "list_features", { projectId, limit: 2 });
  assert.equal((capped.data!.features as unknown[]).length, 2);
  assert.equal(capped.data!.truncated, true, "a full page says so rather than looking complete");

  const all = await callTool(connection.token, "list_features", { projectId });
  assert.equal((all.data!.features as unknown[]).length, 5);
  assert.equal(all.data!.truncated, false);

  const tooMany = await callTool(connection.token, "list_features", { projectId, limit: 500 });
  assert.equal(tooMany.isError, true, "a limit beyond the cap is refused rather than honoured");
});
