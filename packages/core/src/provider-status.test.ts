import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_STATUS_PAGES,
  looksLikeProviderOutage,
  outageProvider,
  providerOutageAdvice,
  withProviderOutageAdvice,
} from "./provider-status.js";

test("a Claude 529 is an outage on Claude", () => {
  const error = `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
  assert.equal(looksLikeProviderOutage(error), true);
  assert.equal(outageProvider(error, { cli: "claude-code" }), "anthropic");
  assert.match(providerOutageAdvice(error, { cli: "claude-code" }) ?? "", /status\.claude\.com/);
});

test("an OpenAI server error is an outage on OpenAI", () => {
  const error = "The server had an error while processing your request. Sorry about that!";
  assert.equal(outageProvider(error, { cli: "codex" }), "openai");
  assert.match(providerOutageAdvice(error, { cli: "codex" }) ?? "", /status\.openai\.com/);
});

test("an OpenRouter 502 is an outage on OpenRouter", () => {
  const error = 'OpenRouter API error: Provider returned error (502 Bad Gateway)';
  assert.equal(outageProvider(error, { cli: "opencode", model: "openrouter/anthropic/claude-sonnet-5" }), "openrouter");
  assert.match(providerOutageAdvice(error) ?? "", /status\.openrouter\.ai/);
});

test("an error that names OpenRouter wins over the Claude Code tool", () => {
  const error = "openrouter: 503 Service Unavailable";
  assert.equal(outageProvider(error, { cli: "claude-code", model: "claude-sonnet-5" }), "openrouter");
});

test("a prefixed model names the provider when the error does not", () => {
  const error = "503 Service Unavailable";
  assert.equal(outageProvider(error, { cli: "pi", model: "anthropic/claude-sonnet-5" }), "anthropic");
  assert.equal(outageProvider(error, { cli: "opencode", model: "openai/gpt-5" }), "openai");
  assert.equal(outageProvider(error, { cli: "pi", model: "openrouter/z-ai/glm-4.6" }), "openrouter");
});

test("a refused key is not an outage", () => {
  assert.equal(looksLikeProviderOutage("401 Unauthorized: Incorrect API key provided"), false);
  assert.equal(looksLikeProviderOutage("403 Forbidden: please check the api-key you provided"), false);
  assert.equal(providerOutageAdvice("401 Unauthorized", { cli: "claude-code" }), null);
});

test("a rate limit is not an outage", () => {
  assert.equal(looksLikeProviderOutage("429 Too Many Requests"), false);
  assert.equal(providerOutageAdvice("Rate limited: 429", { cli: "codex" }), null);
});

test("a missing model is not an outage", () => {
  assert.equal(looksLikeProviderOutage("404 Not Found: The model `laguna-xl-9` does not exist"), false);
});

test("a Cursor CLI outage names Cursor, not the model behind it", () => {
  const error = "503 Service Unavailable";
  assert.equal(outageProvider(error, { cli: "cursor", model: "claude-sonnet-5" }), "cursor");
  assert.match(providerOutageAdvice(error, { cli: "cursor", model: "claude-sonnet-5" }) ?? "", /status\.cursor\.com/);
  assert.equal(outageProvider(error, { cli: "cursor", model: "grok-4.6" }), "cursor");
});

test("a Grok mention names the xAI status page", () => {
  const error = "xAI API error: 503 grok-4.6 is overloaded";
  assert.equal(outageProvider(error, { cli: "cursor", model: "grok-4.6" }), "xai");
  assert.match(providerOutageAdvice(error) ?? "", /status\.x\.ai/);
});

test("a DeepSeek Harness outage names the DeepSeek status page", () => {
  const error = "503 Service Unavailable";
  assert.equal(outageProvider(error, { cli: "dsh", model: "deepseek-v4-pro" }), "deepseek");
  assert.match(providerOutageAdvice(error, { cli: "dsh" }) ?? "", /status\.deepseek\.com/);
});

test("a Gemini model prefix names the Gemini status page", () => {
  const error = "503 Service Unavailable";
  assert.equal(outageProvider(error, { cli: "pi", model: "google/gemini-2.5-pro" }), "google");
  assert.match(providerOutageAdvice(error, { cli: "opencode", model: "google/gemini-2.5-pro" }) ?? "", /aistudio\.google\.com\/status/);
});

test("a Poolside outage names the Poolside status page", () => {
  const error = "502 Bad Gateway";
  assert.equal(outageProvider(error, { cli: "pool", model: "poolside/laguna-s-2.1" }), "poolside");
  assert.match(providerOutageAdvice(error, { cli: "pool" }) ?? "", /status\.poolside\.ai/);
});

test("every provider page is an https status URL", () => {
  for (const [id, page] of Object.entries(PROVIDER_STATUS_PAGES)) {
    assert.match(page.url, /^https:\/\//, `${id} is not an https URL`);
    assert.ok(page.name.trim(), `${id} has no display name`);
  }
});

test("an outage with no identifiable provider gets no status page", () => {
  assert.equal(providerOutageAdvice("503 Service Unavailable"), null);
});

test("advice is not appended twice", () => {
  const error = "API Error: 529 Overloaded";
  const once = withProviderOutageAdvice(error, { cli: "claude-code" });
  assert.match(once, /status\.claude\.com/);
  assert.equal(withProviderOutageAdvice(once, { cli: "claude-code" }), once);
});

test("a task-specific failure is left alone", () => {
  assert.equal(providerOutageAdvice("the tests failed", { cli: "claude-code" }), null);
  assert.equal(withProviderOutageAdvice("forced failure", { cli: "codex" }), "forced failure");
});
