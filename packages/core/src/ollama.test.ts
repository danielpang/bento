import { test } from "node:test";
import assert from "node:assert/strict";
import { isOllamaModel, OLLAMA_CLOUD_URL, ollamaModelId, ollamaServerUrl, trustedCostUsd } from "./ollama.js";

test("only the ollama/ prefix sends a run to Ollama", () => {
  assert.equal(isOllamaModel("ollama/glm-5.1"), true);
  assert.equal(isOllamaModel("ollama/hf.co/team/coder:7b"), true);
  assert.equal(isOllamaModel("glm-5.1"), false);
  assert.equal(isOllamaModel("ollama/"), false);
  assert.equal(isOllamaModel("openrouter/ollama/glm-5.1"), false);
  assert.equal(ollamaModelId("ollama/hf.co/team/coder:7b"), "hf.co/team/coder:7b");
  assert.equal(ollamaModelId("claude-sonnet-5"), "claude-sonnet-5");
});

test("an unsaved base URL is Ollama Cloud, and a saved one loses /v1", () => {
  assert.equal(ollamaServerUrl(undefined), OLLAMA_CLOUD_URL);
  assert.equal(ollamaServerUrl("  "), OLLAMA_CLOUD_URL);
  assert.equal(ollamaServerUrl("http://gpu-box:11434/"), "http://gpu-box:11434");
  assert.equal(ollamaServerUrl("https://ollama.example.com/v1/"), "https://ollama.example.com");
});

test("a cost reported for an Ollama run is not kept", () => {
  assert.equal(trustedCostUsd("ollama/gpt-oss:120b", 0.117262), undefined);
  assert.equal(trustedCostUsd("claude-sonnet-5", 0.42), 0.42);
});
