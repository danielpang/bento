import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beginLogin, completeLogin, refreshLogin, type OAuthFetch } from "./oauth.js";
import { subscriptionRunToken } from "./run.js";
import { runToken } from "../routes/model-proxy.js";
import { personalProvider } from "./store.js";

const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;
test("Claude copy-code login binds state and PKCE to the original attempt", async () => {
  const login = await beginLogin("anthropic");
  const url = new URL(login.url);
  assert.notEqual(login.state.verifier, url.searchParams.get("state"));
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(login.state.verifier!).digest("base64url"));
  let called = false;
  const exchange: OAuthFetch = async (_url, init) => {
    called = true;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.code_verifier, login.state.verifier);
    assert.equal(body.state, login.state.state);
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  };
  await assert.rejects(completeLogin("anthropic", login.state, "code#foreign", exchange), /complete code/);
  assert.equal(called, false);
  const result = await completeLogin("anthropic", login.state, `code#${login.state.state}`, exchange);
  assert.equal(result?.access, "access");
});

test("Codex device flow uses JSON for device endpoints and form data for exchange", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: OAuthFetch = async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith("usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "5" });
    if (String(url).endsWith("deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
    return Response.json({ access_token: jwt, refresh_token: "refresh", expires_in: 3600 });
  };
  const login = await beginLogin("openai-codex", fetcher);
  const credential = await completeLogin("openai-codex", login.state, undefined, fetcher);
  assert.equal(credential?.accountId, "account-1");
  assert.equal(new Headers(calls[0]!.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { device_auth_id: "device", user_code: "ABCD" });
  assert.ok(calls[2]!.init?.body instanceof URLSearchParams);
  assert.equal((calls[2]!.init?.body as URLSearchParams).get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
});

test("pending and slow-down responses do not complete or disclose credentials", async () => {
  const state = { deviceId: "device", userCode: "ABCD", interval: 5 };
  assert.equal(await completeLogin("openai-codex", state, undefined, async () => new Response(null, { status: 403 })), null);
  assert.equal(await completeLogin("openai-codex", state, undefined, async () => Response.json({ error: "slow_down" }, { status: 429 })), null);
  assert.equal(state.interval, 10);
  await assert.rejects(refreshLogin("anthropic", "secret", async () => new Response("SECRET PROVIDER RESPONSE", { status: 400 })), (e: Error) => !e.message.includes("SECRET"));
});

test("native OAuth token shapes unwrap to the same opaque Bento grant", () => {
  for (const provider of ["anthropic", "openai-codex"] as const) {
    const token = subscriptionRunToken("bmg_opaque", provider);
    assert.equal(runToken(new Headers({ authorization: `Bearer ${token}` }), new URL("https://bento.test")), "bmg_opaque");
  }
  assert.equal(personalProvider("codex", "openai/gpt-5-mini"), null, "an OpenRouter model must never spend a ChatGPT subscription");
  assert.equal(personalProvider("pi", "openrouter/anthropic/claude-sonnet-5"), null);
  assert.equal(personalProvider("pi", "openai/gpt-5-codex"), "openai-codex");
});
