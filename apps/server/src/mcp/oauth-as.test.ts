import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRedirectUri, pkceChallenge, pkceMatches, requestOrigin, resourceAllowed } from "./oauth-as.js";

test("redirect URIs allow HTTPS, loopback HTTP, and desktop custom schemes", () => {
  assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:8734/callback"), true);
  assert.equal(isAllowedRedirectUri("http://localhost:3000/oauth"), true);
  assert.equal(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback"), true);
  assert.equal(isAllowedRedirectUri("http://evil.example/steal"), false);
  assert.equal(isAllowedRedirectUri("javascript:alert(1)"), false);
  assert.equal(isAllowedRedirectUri("https://user:pass@claude.ai/x"), false);
});

test("PKCE S256 matches the verifier and rejects a different one", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = pkceChallenge(verifier);
  assert.equal(pkceMatches(verifier, challenge), true);
  assert.equal(pkceMatches("other-verifier-value-that-is-long-enough", challenge), false);
});

test("the resource identifier accepts /mcp and the /api/mcp-server alias", () => {
  const origin = "https://app.usebento.ai";
  assert.equal(resourceAllowed(undefined, origin), true);
  assert.equal(resourceAllowed("https://app.usebento.ai/mcp", origin), true);
  assert.equal(resourceAllowed("https://app.usebento.ai/mcp/", origin), true);
  assert.equal(resourceAllowed("https://app.usebento.ai/api/mcp-server", origin), true);
  assert.equal(resourceAllowed("https://evil.example/mcp", origin), false);
});

test("requestOrigin keeps a non-default port that Host omitted", async () => {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.get("/", (c) => c.text(requestOrigin(c, "http://localhost:4400")));
  const res = await app.request("http://localhost:4400/", { headers: { host: "localhost" } });
  assert.equal(await res.text(), "http://localhost:4400");
  const relative = await app.request("/", { headers: { host: "localhost" } });
  assert.equal(await relative.text(), "http://localhost:4400");
  const forwarded = await app.request("http://127.0.0.1:4400/", {
    headers: { host: "127.0.0.1:4400", "x-forwarded-host": "app.usebento.ai", "x-forwarded-proto": "https" },
  });
  assert.equal(await forwarded.text(), "https://app.usebento.ai");
});
