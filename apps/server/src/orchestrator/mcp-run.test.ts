import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter } from "@bento/agents";
import { BENTO_SERVER_ID } from "../mcp/bento-tools.js";
import { prepareRunMcp, resolveGatewayBase } from "./mcp-run.js";
import type { AppContext } from "../context.js";

// resolveGatewayBase is the pure host-resolution rule; the full attach
// flow (credential resolution, per-user omission, config writes) runs
// against a real sandbox and database in the e2e suites.

function fakeCtx(env: Partial<AppContext["env"]>, provider: string): AppContext {
  return {
    env: { BETTER_AUTH_URL: "http://localhost:4400", ...env },
    driver: { provider },
  } as unknown as AppContext;
}

test("a publicly routable base is used as given", () => {
  const ctx = fakeCtx({ BETTER_AUTH_URL: "https://bento.example.com" }, "sprite");
  assert.equal(resolveGatewayBase(ctx), "https://bento.example.com");
});

test("docker rewrites a localhost base to host.docker.internal", () => {
  const ctx = fakeCtx({ BETTER_AUTH_URL: "http://localhost:4400" }, "docker");
  assert.equal(resolveGatewayBase(ctx), "http://host.docker.internal:4400");
});

test("an explicit gateway URL is always honored, even on loopback", () => {
  const ctx = fakeCtx(
    { BETTER_AUTH_URL: "http://localhost:4400", BENTO_MCP_GATEWAY_URL: "http://127.0.0.1:9000" },
    "docker",
  );
  assert.equal(resolveGatewayBase(ctx), "http://127.0.0.1:9000");
});

test("a sprite on a loopback base has no reachable gateway", () => {
  const ctx = fakeCtx({ BETTER_AUTH_URL: "http://localhost:4400" }, "sprite");
  assert.equal(resolveGatewayBase(ctx), null);
});

test("a trailing slash on the base is normalized away", () => {
  const ctx = fakeCtx({ BETTER_AUTH_URL: "https://bento.example.com/" }, "docker");
  assert.equal(resolveGatewayBase(ctx), "https://bento.example.com");
});

/**
 * The config write is the first command after provision. When the
 * sprites info endpoint answers "sprite not found", exec throws before
 * it yields. That throw used to escape prepareRunMcp, skip finishRun,
 * and leave the run stuck in "starting". Attaching MCP never fails the
 * run: the grant is revoked and the transcript says the servers were
 * left off.
 */
test("prepareRunMcp keeps going when writing the config throws", async () => {
  let writes = 0;
  let revokes = 0;
  const notes: string[] = [];
  const ctx = {
    env: { BETTER_AUTH_URL: "https://bento.example.com", BENTO_RUN_TIMEOUT_MIN: 30 },
    driver: {
      provider: "sprite",
      async *exec() {
        writes += 1;
        throw new Error("sprite not found");
      },
    },
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          },
        };
      },
      insert() {
        return {
          values() {
            return {
              onConflictDoUpdate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      update() {
        return {
          set() {
            return {
              where() {
                revokes += 1;
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
  } as unknown as AppContext;
  const adapter = {
    cli: "claude",
    mcp: {
      renderConfig() {
        return [{ path: "/opt/bento/mcp/claude.json", content: "{}" }];
      },
      extraArgs() {
        return ["--mcp-config", "/opt/bento/mcp/claude.json"];
      },
    },
  } as unknown as AgentAdapter;

  const result = await prepareRunMcp(ctx, {
    runId: "run-1",
    organizationId: "org-1",
    actingUserId: null,
    adapter,
    handle: { externalId: "bento-feature", provider: "sprite", workdir: "/workspace" },
    restrictNetwork: false,
    mountedConfigPaths: [],
    // Bento's own server, which is what this run has to attach: phase 1
    // made that an explicit list rather than a cardTools boolean, and
    // without one there is nothing to write and nothing to revoke.
    ownServers: [{ id: BENTO_SERVER_ID, slug: BENTO_SERVER_ID }],
    say: async (text) => {
      notes.push(text);
    },
  });

  assert.equal(writes, 1);
  assert.equal(revokes, 1);
  assert.deepEqual(result, { extraArgs: [], cardTools: false, env: {} });
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /Could not write the MCP configuration/);
  assert.doesNotMatch(notes[0] ?? "", /[—–]/);
});
