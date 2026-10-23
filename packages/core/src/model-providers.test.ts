import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PROVIDERS, modelEndpointAllowed, modelProviderForSegment, type ModelProxyRoute } from "./model-providers.js";

function route(segment: string): ModelProxyRoute {
  const provider = modelProviderForSegment(segment);
  assert.ok(provider, segment);
  return provider.proxy;
}

test("every endpoint a CLI was seen to call is allowed", () => {
  const seen: [string, string, string][] = [
    // Claude Code, pi and opencode on Anthropic.
    ["anthropic", "POST", "/v1/messages"],
    ["anthropic", "POST", "/v1/messages/count_tokens"],
    ["anthropic", "GET", "/v1/models"],
    ["anthropic", "GET", "/v1/models/claude-sonnet-5"],
    // Codex (upgrade, then POST), pi and opencode on OpenAI.
    ["openai", "WEBSOCKET", "/responses"],
    ["openai", "POST", "/responses"],
    ["openai", "POST", "/chat/completions"],
    ["openai", "GET", "/models"],
    // OpenRouter: Codex, then pi and opencode, then pi's anthropic/ models.
    ["openrouter", "POST", "/api/v1/responses"],
    ["openrouter", "POST", "/api/v1/chat/completions"],
    ["openrouter", "POST", "/api/v1/messages"],
    // Gemini, as pi, opencode and Antigravity call it.
    ["gemini", "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent"],
    ["gemini", "POST", "/v1beta/models/gemini-2.5-pro:generateContent"],
    ["gemini", "POST", "/v1beta/models/gemini-2.5-pro:countTokens"],
    ["gemini", "GET", "/v1beta/models"],
    ["deepseek", "POST", "/chat/completions"],
    ["deepseek", "POST", "/v1/chat/completions"],
    // AI Gateway: Codex, opencode's AI SDK gateway, pi's Anthropic Messages.
    ["vercel", "POST", "/codex/v1/responses"],
    ["vercel", "WEBSOCKET", "/codex/v1/responses"],
    ["vercel", "POST", "/v3/ai/language-model"],
    ["vercel", "GET", "/v3/ai/config"],
    ["vercel", "POST", "/v1/messages"],
    ["poolside", "POST", "/chat/completions"],
  ];
  for (const [segment, method, path] of seen) {
    assert.ok(modelEndpointAllowed(route(segment), method, path), `${segment} ${method} ${path}`);
  }
});

test("the rest of a provider's API is refused", () => {
  const refused: [string, string, string][] = [
    ["openai", "POST", "/files"],
    ["openai", "GET", "/files/file-abc/content"],
    ["openai", "POST", "/fine_tuning/jobs"],
    ["openai", "DELETE", "/models/ft:gpt-4o:acme"],
    ["openai", "POST", "/batches"],
    ["openai", "GET", "/organization/costs"],
    ["openai", "GET", "/responses"],
    ["openai", "POST", "/responses/"],
    ["anthropic", "POST", "/v1/files"],
    ["anthropic", "POST", "/v1/messages/batches"],
    ["anthropic", "GET", "/v1/organizations/api_keys"],
    ["anthropic", "DELETE", "/v1/messages"],
    ["anthropic", "WEBSOCKET", "/v1/messages"],
    ["anthropic", "POST", "/v1/messages?beta=true"],
    ["anthropic", "POST", "//evil.example/v1/messages"],
    ["anthropic", "GET", "/v1/models/.."],
    ["anthropic", "GET", "/v1/models/%2e%2e"],
    ["anthropic", "GET", "/v1/models/a/b"],
    ["gemini", "POST", "/v1beta/models/m:predict"],
    ["gemini", "POST", "/v1beta/files"],
    ["gemini", "POST", "/v1beta/tunedModels"],
    ["gemini", "POST", "/v1beta/models/../files:generateContent"],
    ["openrouter", "GET", "/api/v1/keys"],
    ["openrouter", "GET", "/api/v1/credits"],
    ["vercel", "GET", "/v1/credits"],
    ["deepseek", "GET", "/user/balance"],
  ];
  for (const [segment, method, path] of refused) {
    assert.ok(!modelEndpointAllowed(route(segment), method, path), `${segment} ${method} ${path}`);
  }
});

test("every proxied provider lists its endpoints, and only proxied providers have a route", () => {
  for (const provider of MODEL_PROVIDERS) {
    if (!provider.proxy) continue;
    assert.ok(provider.proxy.endpoints.length > 0, provider.key);
    for (const endpoint of provider.proxy.endpoints) assert.match(endpoint.path, /^\//, `${provider.key} ${endpoint.path}`);
  }
  assert.equal(modelProviderForSegment("meta"), undefined, "nothing sends Meta's key through the proxy");
  assert.ok(MODEL_PROVIDERS.some((provider) => provider.key === "META_API_KEY"), "its host stays on the Modal allowlist");
});
