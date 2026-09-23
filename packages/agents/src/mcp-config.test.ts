import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "./claude-code.js";
import { cursorAdapter } from "./cursor.js";
import { fxAdapter } from "./fx.js";
import { museAdapter } from "./muse.js";
import { opencodeAdapter } from "./opencode.js";
import { codexAdapter } from "./codex.js";
import { resolveSandboxPath, sandboxPathExpression, writeFileCommand, type McpRemoteServer } from "./adapter.js";

const servers: McpRemoteServer[] = [
  {
    slug: "docs",
    url: "https://bento.test/api/mcp-gateway/abc",
    transport: "http",
    headers: { Authorization: "Bearer bmg_token" },
  },
  {
    slug: "issues",
    url: "https://bento.test/api/mcp-gateway/def",
    transport: "sse",
    headers: { Authorization: "Bearer bmg_token" },
  },
];

test("claude-code writes a typed mcpServers map and adds the strict flags", () => {
  const files = claudeCodeAdapter.mcp!.renderConfig(servers);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "/opt/bento/mcp/claude.json");
  const parsed = JSON.parse(files[0]!.content) as {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
  };
  assert.deepEqual(Object.keys(parsed.mcpServers), ["docs", "issues"]);
  assert.equal(parsed.mcpServers.docs!.type, "http");
  assert.equal(parsed.mcpServers.issues!.type, "sse");
  assert.equal(parsed.mcpServers.docs!.headers.Authorization, "Bearer bmg_token");
  assert.deepEqual(claudeCodeAdapter.mcp!.extraArgs!(), [
    "--mcp-config",
    "/opt/bento/mcp/claude.json",
    "--strict-mcp-config",
  ]);
});

test("cursor writes the global mcp.json under the sandbox home", () => {
  const files = cursorAdapter.mcp!.renderConfig(servers);
  assert.equal(files[0]!.path, "~/.cursor/mcp.json");
  const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, { url: string }> };
  assert.equal(parsed.mcpServers.docs!.url, servers[0]!.url);
  // Cursor autoruns MCP tools with the sandbox flags, so no extra argv.
  assert.equal(cursorAdapter.mcp!.extraArgs, undefined);
});

test("opencode marks servers remote and enabled", () => {
  const files = opencodeAdapter.mcp!.renderConfig(servers);
  assert.equal(files[0]!.path, "~/.config/opencode/opencode.json");
  const parsed = JSON.parse(files[0]!.content) as {
    mcp: Record<string, { type: string; enabled: boolean; headers: Record<string, string> }>;
  };
  assert.equal(parsed.mcp.docs!.type, "remote");
  assert.equal(parsed.mcp.docs!.enabled, true);
  assert.equal(parsed.mcp.issues!.headers.Authorization, "Bearer bmg_token");
});

test("codex renders TOML tables with a static Authorization header", () => {
  const files = codexAdapter.mcp!.renderConfig(servers);
  assert.equal(files[0]!.path, "~/.codex/config.toml");
  const toml = files[0]!.content;
  assert.match(toml, /\[model_providers\.openrouter\]/);
  assert.match(toml, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(toml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(toml, /\[model_providers\.vercel\]/);
  assert.match(toml, /env_key = "AI_GATEWAY_API_KEY"/);
  assert.match(toml, /base_url = "https:\/\/ai-gateway\.vercel\.sh\/codex\/v1"/);
  assert.match(toml, /\[mcp_servers\.docs\]/);
  assert.match(toml, /url = "https:\/\/bento\.test\/api\/mcp-gateway\/abc"/);
  assert.match(toml, /http_headers = \{ "Authorization" = "Bearer bmg_token" \}/);
  assert.match(toml, /\[mcp_servers\.issues\]/);
});

test("codex escapes a slug that is not a bare TOML key", () => {
  const toml = codexAdapter.mcp!.renderConfig([
    { slug: "has space", url: "https://x/y", transport: "http", headers: {} },
  ])[0]!.content;
  assert.match(toml, /\[mcp_servers\."has space"\]/);
});

test("fx names the grant through bearer_token_env, never a literal Authorization header", () => {
  const files = fxAdapter.mcp!.renderConfig(servers);
  assert.equal(files[0]!.path, "~/.fx/mcp.json");
  const parsed = JSON.parse(files[0]!.content) as {
    mcp: Record<string, { type: string; bearer_token_env?: string; headers?: unknown }>;
  };
  assert.equal(parsed.mcp.docs!.type, "http");
  assert.equal(parsed.mcp.issues!.type, "sse");
  assert.equal(parsed.mcp.docs!.bearer_token_env, "BENTO_MCP_GRANT");
  assert.equal(parsed.mcp.docs!.headers, undefined);
  assert.doesNotMatch(files[0]!.content, /Authorization/);
  assert.deepEqual(fxAdapter.mcp!.env?.(servers), { BENTO_MCP_GRANT: "bmg_token" });
});

test("an empty server set still renders a config, so a removed server is cleared", () => {
  for (const adapter of [claudeCodeAdapter, cursorAdapter, opencodeAdapter, museAdapter, fxAdapter]) {
    const files = adapter.mcp!.renderConfig([]);
    assert.equal(files.length, 1, `${adapter.cli} must still write its config file`);
    const parsed = JSON.parse(files[0]!.content) as Record<string, Record<string, unknown>>;
    const bag = parsed.mcpServers ?? parsed.mcp ?? parsed.mcp_servers ?? {};
    assert.equal(Object.keys(bag).length, 0, `${adapter.cli} must clear stale servers`);
  }
  // Codex keeps the OpenRouter provider so a removed MCP server does
  // not drop the route, and writes no mcp_servers tables.
  const emptyCodex = codexAdapter.mcp!.renderConfig([])[0]!.content;
  assert.match(emptyCodex, /\[model_providers\.openrouter\]/);
  assert.match(emptyCodex, /\[model_providers\.vercel\]/);
  assert.doesNotMatch(emptyCodex, /\[mcp_servers\./);
});

/**
 * The sandbox's home is not always root's: a Fly Sprite runs the agent
 * as a user whose HOME is /home/sprite, and every config once written
 * under /root sat where no harness looked. So a config path names the
 * home as `~`, and the write expands it where the command runs.
 */
test("a home-relative config path is expanded against the sandbox's own HOME", () => {
  assert.equal(sandboxPathExpression("~/.cursor/mcp.json"), `"\${HOME:-/root}"'/.cursor/mcp.json'`);
  assert.equal(sandboxPathExpression("/opt/bento/mcp/claude.json"), "'/opt/bento/mcp/claude.json'");
  assert.equal(sandboxPathExpression("~/it's"), `"\${HOME:-/root}"'/it'\\''s'`);

  const [sh, flag, script] = writeFileCommand({ path: "~/.codex/config.toml", content: "x = 1" });
  assert.deepEqual([sh, flag], ["sh", "-c"]);
  assert.match(script!, /mkdir -p "\$\{HOME:-\/root\}"'\/\.codex'/);
  assert.match(script!, /> "\$\{HOME:-\/root\}"'\/\.codex\/config\.toml'/);
  assert.doesNotMatch(script!, /\/root\/\.codex/, "the home is read in the sandbox, never assumed here");
});

test("resolveSandboxPath substitutes a known home for comparisons", () => {
  assert.equal(resolveSandboxPath("~/.codex/config.toml", "/root"), "/root/.codex/config.toml");
  assert.equal(resolveSandboxPath("~", "/home/sprite"), "/home/sprite");
  assert.equal(resolveSandboxPath("/opt/bento/mcp/claude.json", "/root"), "/opt/bento/mcp/claude.json");
});

test("every harness config path is home-relative or absolute, never root's home spelled out", () => {
  for (const adapter of [cursorAdapter, codexAdapter, opencodeAdapter, fxAdapter, museAdapter, claudeCodeAdapter]) {
    for (const file of adapter.mcp!.renderConfig(servers)) {
      assert.ok(file.path.startsWith("~/") || file.path.startsWith("/opt/"), `${adapter.cli}: ${file.path}`);
      assert.doesNotMatch(file.path, /^\/root\//);
    }
  }
});
