import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "./claude-code.js";
import { cursorAdapter } from "./cursor.js";
import { opencodeAdapter } from "./opencode.js";
import type { McpRemoteServer } from "./adapter.js";

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
  assert.equal(files[0]!.path, "/root/.cursor/mcp.json");
  const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, { url: string }> };
  assert.equal(parsed.mcpServers.docs!.url, servers[0]!.url);
  // Cursor autoruns MCP tools with the sandbox flags, so no extra argv.
  assert.equal(cursorAdapter.mcp!.extraArgs, undefined);
});

test("opencode marks servers remote and enabled", () => {
  const files = opencodeAdapter.mcp!.renderConfig(servers);
  assert.equal(files[0]!.path, "/root/.config/opencode/opencode.json");
  const parsed = JSON.parse(files[0]!.content) as {
    mcp: Record<string, { type: string; enabled: boolean; headers: Record<string, string> }>;
  };
  assert.equal(parsed.mcp.docs!.type, "remote");
  assert.equal(parsed.mcp.docs!.enabled, true);
  assert.equal(parsed.mcp.issues!.headers.Authorization, "Bearer bmg_token");
});

test("an empty server set still renders a config, so a removed server is cleared", () => {
  for (const adapter of [claudeCodeAdapter, cursorAdapter, opencodeAdapter]) {
    const files = adapter.mcp!.renderConfig([]);
    assert.equal(files.length, 1, `${adapter.cli} must still write its config file`);
    // The file parses and holds no servers.
    const parsed = JSON.parse(files[0]!.content) as Record<string, Record<string, unknown>>;
    const bag = parsed.mcpServers ?? parsed.mcp ?? {};
    assert.equal(Object.keys(bag).length, 0, `${adapter.cli} must clear stale servers`);
  }
});
