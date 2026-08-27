import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, createPool, mcpCredentials, mcpServers, runMigrations } from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "mcp_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;

/**
 * A real MCP server, not a stub: it listens on a loopback port, answers
 * the initialize handshake, and rejects any request without the right
 * key. The api-key route's validate-before-store either survives
 * contact with it or fails honestly.
 */
let upstream: Server;
let upstreamUrl: string;
const GOOD_KEY = "mcp-key-correct";
let upstreamRequests: { authorization: string | null; header: Record<string, string | undefined> }[] = [];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-mcp-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    // The OAuth flow tests below sign a state blob with this.
    BENTO_SECRET_KEY: "mcp-test-state-signing-key-32-chars-min",
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
    upstreamRequests.push({
      authorization: req.headers.authorization ?? null,
      header: { "x-api-key": req.headers["x-api-key"] as string | undefined },
    });
    const authorized =
      req.headers.authorization === `Bearer ${GOOD_KEY}` || req.headers["x-api-key"] === GOOD_KEY;
    if (!authorized) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let id: unknown = 1;
      try {
        id = (JSON.parse(body) as { id?: unknown }).id ?? 1;
      } catch {
        // The handshake test sends valid JSON; anything else still
        // answers so a broken client sees a response, not a hang.
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fixture-mcp", version: "1.0" },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("no upstream port");
  upstreamUrl = `http://127.0.0.1:${address.port}/mcp`;
});

after(async () => {
  upstream?.close();
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

function jsonRequest(pathname: string, method: string, body?: unknown) {
  return app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("a server can be defined, listed, and slugs stay unique", async () => {
  const created = await jsonRequest("/api/mcp", "POST", {
    name: "Fixture",
    slug: "fixture",
    url: upstreamUrl,
    authType: "api_key",
  });
  assert.equal(created.status, 201);

  const duplicate = await jsonRequest("/api/mcp", "POST", {
    name: "Fixture again",
    slug: "fixture",
    url: upstreamUrl,
    authType: "none",
  });
  assert.equal(duplicate.status, 409);

  const status = await app.request("/api/mcp/status");
  const body = (await status.json()) as {
    canManage: boolean;
    servers: { slug: string; authType: string; orgCredential: null | { connected: boolean } }[];
    userConnectionsNeeded: number;
  };
  assert.equal(body.canManage, true);
  assert.deepEqual(
    body.servers.map((s) => s.slug),
    ["fixture"],
  );
  assert.equal(body.servers[0]!.orgCredential, null, "no credential is stored yet");
  assert.equal(body.userConnectionsNeeded, 0);
});

test("the plain route lists servers as pipe-delimited lines for the TUI", async () => {
  const text = await (await app.request("/api/mcp/plain")).text();
  const line = text.split("\n").find((l) => l.includes("|fixture|"));
  assert.ok(line, "the fixture server appears in the plain listing");
  const [tag, , slug, authType, scope, enabled] = line!.split("|");
  assert.equal(tag, "mcp");
  assert.equal(slug, "fixture");
  assert.equal(authType, "api_key");
  assert.equal(scope, "org");
  assert.equal(enabled, "true");
});

test("a reserved API key header is refused at write time", async () => {
  const res = await jsonRequest("/api/mcp", "POST", {
    name: "Bad header",
    slug: "bad-header",
    url: upstreamUrl,
    authType: "api_key",
    apiKeyHeader: "Mcp-Session-Id",
  });
  assert.equal(res.status, 400);
});

test("an API key the upstream rejects is never stored", async () => {
  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.slug, "fixture"));
  const res = await jsonRequest(`/api/mcp/${server!.id}/api-key`, "POST", { value: "wrong-key" });
  assert.equal(res.status, 400);
  const rows = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, server!.id));
  assert.equal(rows.length, 0, "a rejected key must leave no credential row");
});

test("a working API key is validated upstream and stored encrypted", async () => {
  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.slug, "fixture"));
  const res = await jsonRequest(`/api/mcp/${server!.id}/api-key`, "POST", { value: GOOD_KEY });
  assert.equal(res.status, 201);

  const [row] = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, server!.id));
  assert.ok(row, "the credential row must exist");
  assert.equal(row!.userId, null, "an API key is the organization's credential");
  assert.notEqual(row!.encryptedSecret, GOOD_KEY, "the key must not be stored in plaintext");
  assert.ok(!row!.encryptedSecret.includes(GOOD_KEY), "the ciphertext must not contain the key");
  assert.equal(ctx.secretBox.decrypt(row!.encryptedSecret), GOOD_KEY, "the ciphertext must round-trip");
  assert.ok(row!.hint.endsWith(GOOD_KEY.slice(-4)), "the hint shows only the masked tail");

  const status = (await (await app.request("/api/mcp/status")).json()) as {
    servers: { orgCredential: null | { connected: boolean; hint: string } }[];
  };
  assert.equal(status.servers[0]!.orgCredential?.connected, true);
  assert.ok(!JSON.stringify(status).includes(GOOD_KEY), "no route may return the plaintext key");
});

test("the key rides the configured header on the validation ping", async () => {
  const created = await jsonRequest("/api/mcp", "POST", {
    name: "Custom header",
    slug: "custom-header",
    url: upstreamUrl,
    authType: "api_key",
    apiKeyHeader: "X-Api-Key",
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  upstreamRequests = [];
  const res = await jsonRequest(`/api/mcp/${id}/api-key`, "POST", { value: GOOD_KEY });
  assert.equal(res.status, 201);
  assert.equal(upstreamRequests[0]?.header["x-api-key"], GOOD_KEY, "the raw key must ride the named header");
  assert.equal(upstreamRequests[0]?.authorization, null, "no Bearer header when another header is chosen");
  await jsonRequest(`/api/mcp/${id}`, "DELETE");
});

test("renaming keeps credentials, repointing the origin wipes them", async () => {
  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.slug, "fixture"));

  const rename = await jsonRequest(`/api/mcp/${server!.id}`, "PATCH", { name: "Fixture renamed" });
  assert.equal(rename.status, 200);
  assert.equal(((await rename.json()) as { reconnectRequired: boolean }).reconnectRequired, false);
  let rows = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, server!.id));
  assert.equal(rows.length, 1, "a rename must not lose the credential");

  // Same origin, different path: still no wipe.
  const samePath = await jsonRequest(`/api/mcp/${server!.id}`, "PATCH", {
    url: upstreamUrl.replace("/mcp", "/mcp/v2"),
  });
  assert.equal(((await samePath.json()) as { reconnectRequired: boolean }).reconnectRequired, false);
  rows = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, server!.id));
  assert.equal(rows.length, 1, "a path change within the origin must not lose the credential");

  const repoint = await jsonRequest(`/api/mcp/${server!.id}`, "PATCH", {
    url: "https://elsewhere.example.test/mcp",
  });
  assert.equal(repoint.status, 200);
  assert.equal(((await repoint.json()) as { reconnectRequired: boolean }).reconnectRequired, true);
  rows = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, server!.id));
  assert.equal(rows.length, 0, "a repointed server must not keep credentials minted for the old origin");

  const [after] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.id, server!.id));
  assert.equal(after!.tokenEndpoint, null, "discovery must be cleared with the credentials");
});

test("deleting a server takes its credentials with it", async () => {
  const created = await jsonRequest("/api/mcp", "POST", {
    name: "Short lived",
    slug: "short-lived",
    url: upstreamUrl,
    authType: "api_key",
  });
  const { id } = (await created.json()) as { id: string };
  await jsonRequest(`/api/mcp/${id}/api-key`, "POST", { value: GOOD_KEY });
  const del = await jsonRequest(`/api/mcp/${id}`, "DELETE");
  assert.equal(del.status, 200);
  const rows = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, id));
  assert.equal(rows.length, 0, "the cascade must remove the credential");
});

test("a personal server is owned by its creator and its key is stored under them", async () => {
  const created = await jsonRequest("/api/mcp", "POST", {
    name: "My docs",
    slug: "my-docs",
    url: upstreamUrl,
    authType: "api_key",
    personal: true,
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };

  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id));
  assert.equal(server!.userId, ctx.userId, "a personal server records its owner");

  const keyRes = await jsonRequest(`/api/mcp/${id}/api-key`, "POST", { value: GOOD_KEY });
  assert.equal(keyRes.status, 201);
  const [cred] = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, id));
  assert.equal(cred!.userId, ctx.userId, "a personal server's key is the owner's own credential row");

  const status = (await (await app.request("/api/mcp/status")).json()) as {
    servers: { id: string; personal: boolean; mine: boolean; userCredential: { connected: boolean } | null }[];
  };
  const row = status.servers.find((s) => s.id === id)!;
  assert.equal(row.personal, true);
  assert.equal(row.mine, true);
  assert.equal(row.userCredential?.connected, true, "the owner sees their personal server as connected");
});

// A fake authorization server: 401 challenge, protected resource
// metadata, RFC 8414 metadata, dynamic registration, and a token
// endpoint. Lets the OAuth flow run end to end with no real provider.
let authServer: Server;
let authBase: string;
let issuedCode = "the-auth-code";

before(async () => {
  authServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", authBase);
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    switch (url.pathname) {
      case "/oauth-mcp":
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${authBase}/.well-known/oauth-protected-resource/oauth-mcp"`,
        });
        res.end();
        return;
      case "/.well-known/oauth-protected-resource/oauth-mcp":
        json({ resource: `${authBase}/oauth-mcp`, authorization_servers: [authBase] });
        return;
      case "/.well-known/oauth-authorization-server":
        json({
          issuer: authBase,
          authorization_endpoint: `${authBase}/authorize`,
          token_endpoint: `${authBase}/token`,
          registration_endpoint: `${authBase}/register`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      case "/register":
        json({ client_id: "flow-client" }, 201);
        return;
      case "/token": {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const form = new URLSearchParams(body);
          if (form.get("code") !== issuedCode) return json({ error: "invalid_grant" }, 400);
          json({ access_token: "flow-access", refresh_token: "flow-refresh", expires_in: 3600, scope: "read" });
        });
        return;
      }
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", r));
  authBase = `http://127.0.0.1:${(authServer.address() as { port: number }).port}`;
});

after(() => authServer?.close());

let oauthSeq = 0;
async function makeOAuthServer(scope: "org" | "user") {
  oauthSeq += 1;
  const created = await jsonRequest("/api/mcp", "POST", {
    name: "OAuth flow",
    slug: `oauth-${scope}-${oauthSeq}`,
    url: `${authBase}/oauth-mcp`,
    authType: "oauth",
    credentialScope: scope,
  });
  assert.equal(created.status, 201, "the oauth server must be created");
  return ((await created.json()) as { id: string }).id;
}

test("connect discovers the authorization server and returns an authorize URL", async () => {
  const id = await makeOAuthServer("org");
  const res = await jsonRequest(`/api/mcp/${id}/connect`, "POST");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string; authorizationHost: string };
  const url = new URL(body.url);
  assert.equal(url.origin + url.pathname, `${authBase}/authorize`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_id"), "flow-client");
  assert.equal(url.searchParams.get("resource"), `${authBase}/oauth-mcp`);
  assert.ok(url.searchParams.get("state"), "the authorize URL carries a signed state");

  // The discovered endpoints and the registered client are cached.
  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id));
  assert.equal(server!.tokenEndpoint, `${authBase}/token`);
  assert.equal(server!.clientId, "flow-client");
  assert.equal(server!.clientRegistration, "dynamic");
});

test("the callback exchanges the code and stores the tokens encrypted", async () => {
  const id = await makeOAuthServer("user");
  const connect = await jsonRequest(`/api/mcp/${id}/connect`, "POST");
  const { url } = (await connect.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;

  issuedCode = "the-auth-code";
  const cb = await app.request(
    `/api/mcp/callback/${id}?state=${encodeURIComponent(state)}&code=the-auth-code&iss=${encodeURIComponent(authBase)}`,
  );
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get("location") ?? "", /mcp=connected/);

  const [cred] = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, id));
  assert.ok(cred, "the credential row exists");
  assert.equal(cred!.kind, "oauth");
  assert.equal(cred!.userId, ctx.userId, "a per-user server stores the credential under the member");
  assert.equal(ctx.secretBox.decrypt(cred!.encryptedSecret), "flow-access");
  assert.equal(ctx.secretBox.decrypt(cred!.encryptedRefreshToken!), "flow-refresh");
  assert.equal(cred!.tokenEndpointOrigin, authBase, "the credential is pinned to its token endpoint");

  const status = (await (await app.request("/api/mcp/status")).json()) as unknown;
  assert.ok(!JSON.stringify(status).includes("flow-access"), "no route returns the access token");
});

test("the callback rejects a tampered state, a wrong issuer, and a mismatched server id", async () => {
  const id = await makeOAuthServer("org");
  const connect = await jsonRequest(`/api/mcp/${id}/connect`, "POST");
  const { url } = (await connect.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;

  const tampered = await app.request(`/api/mcp/callback/${id}?state=${encodeURIComponent(state)}x&code=c`);
  assert.match(tampered.headers.get("location") ?? "", /mcp=invalid/, "a tampered state is rejected");

  const wrongIss = await app.request(
    `/api/mcp/callback/${id}?state=${encodeURIComponent(state)}&code=the-auth-code&iss=https://evil.example.test`,
  );
  assert.match(wrongIss.headers.get("location") ?? "", /mcp=invalid/, "a mismatched issuer is rejected");

  // The state was minted for `id`; arriving at another server's callback
  // path must fail the serverId cross-check (mix-up defense).
  const otherId = await makeOAuthServer("user");
  const wrongPath = await app.request(
    `/api/mcp/callback/${otherId}?state=${encodeURIComponent(state)}&code=the-auth-code&iss=${encodeURIComponent(authBase)}`,
  );
  assert.match(wrongPath.headers.get("location") ?? "", /mcp=invalid/, "a code cannot be redeemed via another server's callback");
});

test("the callback rejects a missing iss when the authorization server advertises support", async () => {
  const id = await makeOAuthServer("org");
  const connect = await jsonRequest(`/api/mcp/${id}/connect`, "POST");
  const { url } = (await connect.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;

  // The fake AS advertises authorization_response_iss_parameter_supported,
  // so a response with no iss must be refused (RFC 9207).
  const [server] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.id, id));
  assert.equal(server!.issParamSupported, true, "discovery persisted the iss support flag");
  const noIss = await app.request(`/api/mcp/callback/${id}?state=${encodeURIComponent(state)}&code=the-auth-code`);
  assert.match(noIss.headers.get("location") ?? "", /mcp=invalid/, "an omitted iss is refused when advertised");
});
