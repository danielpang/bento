import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRedirectUri, pkceChallenge, pkceMatches, resourceAllowed } from "./oauth-as.js";

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
