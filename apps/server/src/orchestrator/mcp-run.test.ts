import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGatewayBase } from "./mcp-run.js";
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
