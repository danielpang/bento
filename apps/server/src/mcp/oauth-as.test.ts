import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRedirectUri, pkceChallenge, pkceMatches, requestOrigin, resourceAllowed } from "./oauth-as.js";
import type { Context } from "hono";

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
  const env = {
    BETTER_AUTH_URL: "http://localhost:4400",
    // The proxy in front of a hosted deployment terminates TLS on this
    // name, so the operator names it; that is what makes it trusted.
    BENTO_TRUSTED_ORIGINS: ["http://localhost:4400", "https://app.usebento.ai"],
  };
  app.get("/", (c) => c.text(requestOrigin(c, env)));
  const res = await app.request("http://localhost:4400/", { headers: { host: "localhost" } });
  assert.equal(await res.text(), "http://localhost:4400");
  const relative = await app.request("/", { headers: { host: "localhost" } });
  assert.equal(await relative.text(), "http://localhost:4400");

  // A forwarded host is still honoured, but only because the operator
  // configured it. This assertion used to pass for any host at all,
  // which let a forged header pick the issuer clients discover.
  const forwarded = await app.request("http://127.0.0.1:4400/", {
    headers: { host: "127.0.0.1:4400", "x-forwarded-host": "app.usebento.ai", "x-forwarded-proto": "https" },
  });
  assert.equal(await forwarded.text(), "https://app.usebento.ai");

  const forged = await app.request("http://127.0.0.1:4400/", {
    headers: { host: "127.0.0.1:4400", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
  });
  assert.equal(await forged.text(), "http://localhost:4400", "an unconfigured forwarded host is ignored");
});


/**
 * requestOrigin decides the OAuth issuer, the resource identifier and
 * the resource-metadata pointer a client discovers. It used to prefer
 * the Host header over configuration, so a forged header put an
 * attacker's hostname into all three. These pin that shut.
 */
const ENV = {
  BETTER_AUTH_URL: "https://app.usebento.ai",
  BENTO_TRUSTED_ORIGINS: ["https://app.usebento.ai", "https://alt.usebento.ai"],
};

/** The slice of Hono's Context requestOrigin actually reads. */
function fakeRequest(url: string, headers: Record<string, string> = {}): Context {
  return {
    req: {
      url,
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context;
}

test("a forged Host header cannot choose the OAuth issuer", () => {
  const origin = requestOrigin(fakeRequest("https://app.usebento.ai/mcp", { host: "evil.example" }), ENV);
  assert.equal(origin, "https://app.usebento.ai", "an unknown host falls back to the configured URL");
});

test("a forged X-Forwarded-Host cannot either", () => {
  const origin = requestOrigin(
    fakeRequest("https://app.usebento.ai/mcp", { "x-forwarded-host": "evil.example", host: "app.usebento.ai" }),
    ENV,
  );
  assert.equal(origin, "https://app.usebento.ai");
});

test("a host the operator configured is honoured", () => {
  const origin = requestOrigin(
    fakeRequest("https://alt.usebento.ai/mcp", { host: "alt.usebento.ai", "x-forwarded-proto": "https" }),
    ENV,
  );
  assert.equal(origin, "https://alt.usebento.ai", "a second name the deployment answers on still works");
});

test("a downgraded scheme cannot be claimed for a configured host", () => {
  const origin = requestOrigin(
    fakeRequest("https://app.usebento.ai/mcp", { host: "app.usebento.ai", "x-forwarded-proto": "http" }),
    ENV,
  );
  assert.equal(origin, "https://app.usebento.ai", "http://app.usebento.ai is not a configured origin");
});

test("local development keeps the listen port the Host header drops", () => {
  const local = { BETTER_AUTH_URL: "http://localhost:4400", BENTO_TRUSTED_ORIGINS: ["http://localhost:4400"] };
  assert.equal(requestOrigin(fakeRequest("http://localhost:4400/mcp", { host: "localhost" }), local), "http://localhost:4400");
  assert.equal(requestOrigin(fakeRequest("http://localhost/mcp", {}), local), "http://localhost:4400");
});
