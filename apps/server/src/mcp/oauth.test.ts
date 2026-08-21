import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  buildAuthorizeUrl,
  exchangeCode,
  makePkce,
  OAuthError,
  refreshTokens,
  signState,
  stateExpiry,
  verifyState,
  type OAuthState,
} from "./oauth.js";

const SECRET = "a-signing-secret-key-32-chars-minimum!";
const localPolicy = { mode: "local" as const, ownHosts: [] };

function sampleState(overrides: Partial<OAuthState> = {}): OAuthState {
  return {
    userId: "u1",
    organizationId: "org-a",
    serverId: "srv-1",
    scope: "user",
    verifierEnc: "enc-verifier",
    expiresAt: stateExpiry(),
    ...overrides,
  };
}

test("PKCE challenge is the base64url sha256 of the verifier", () => {
  const { verifier, challenge } = makePkce();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(verifier, challenge);
});

test("a signed state round-trips and rejects tampering", () => {
  const state = sampleState();
  const signed = signState(state, SECRET);
  assert.deepEqual(verifyState(signed, SECRET), state);

  // Wrong key.
  assert.equal(verifyState(signed, "different-secret-key-32-chars-minimum!"), null);
  // Tampered body.
  const [body, sig] = signed.split(".");
  const forged = Buffer.from(JSON.stringify(sampleState({ scope: "org" }))).toString("base64url");
  assert.equal(verifyState(`${forged}.${sig}`, SECRET), null);
  // Missing signature and garbage.
  assert.equal(verifyState(body, SECRET), null);
  assert.equal(verifyState("not-a-state", SECRET), null);
  assert.equal(verifyState(undefined, SECRET), null);
});

test("the authorize URL carries PKCE, the resource, and the state", () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: "https://auth.example.com/authorize",
      clientId: "client-123",
      redirectUri: "https://bento.example.com/api/mcp/callback/srv-1",
      state: "state-blob",
      codeChallenge: "challenge-value",
      resource: "https://mcp.example.com/mcp",
      scope: "files:read",
    }),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.example.com/mcp");
  assert.equal(url.searchParams.get("state"), "state-blob");
  assert.equal(url.searchParams.get("scope"), "files:read");
});

test("token exchange and refresh are form encoded, and invalid_grant is flagged", async () => {
  let lastContentType: string | undefined;
  let lastBody = "";
  let mode: "ok" | "invalid" = "ok";
  const server: Server = createServer((req, res) => {
    lastContentType = req.headers["content-type"];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = body;
      if (mode === "invalid") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "access-abc",
          refresh_token: "refresh-xyz",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "files:read",
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const tokenEndpoint = `http://127.0.0.1:${port}/token`;

  try {
    const exchanged = await exchangeCode(
      {
        tokenEndpoint,
        clientId: "client-123",
        redirectUri: "http://127.0.0.1/cb",
        code: "the-code",
        codeVerifier: "the-verifier",
        resource: "http://mcp.local/mcp",
      },
      localPolicy,
    );
    assert.equal(lastContentType, "application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(lastBody);
    assert.equal(parsed.get("grant_type"), "authorization_code");
    assert.equal(parsed.get("code_verifier"), "the-verifier");
    assert.equal(parsed.get("resource"), "http://mcp.local/mcp");
    assert.equal(exchanged.accessToken, "access-abc");
    assert.equal(exchanged.refreshToken, "refresh-xyz");
    assert.ok(exchanged.expiresAt instanceof Date);

    const refreshed = await refreshTokens(
      { tokenEndpoint, clientId: "client-123", refreshToken: "refresh-xyz", resource: "http://mcp.local/mcp" },
      localPolicy,
    );
    assert.equal(new URLSearchParams(lastBody).get("grant_type"), "refresh_token");
    assert.equal(refreshed.accessToken, "access-abc");

    mode = "invalid";
    await assert.rejects(
      refreshTokens(
        { tokenEndpoint, clientId: "client-123", refreshToken: "dead", resource: "http://mcp.local/mcp" },
        localPolicy,
      ),
      (err: unknown) => err instanceof OAuthError && err.invalidGrant,
    );
  } finally {
    server.close();
  }
});
