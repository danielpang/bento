import { test } from "node:test";
import assert from "node:assert/strict";
import { reportsCost, spendCoverageNote } from "./credentials.js";
import {
  hasOllamaCredentials,
  isOllamaModel,
  missingOllamaCredentials,
  OLLAMA_CLOUD_URL,
  ollamaCredentialsOnly,
  ollamaModelId,
  ollamaServerUrl,
  ollamaUrlFromSandbox,
} from "./ollama.js";

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

test("Ollama Cloud needs a key, and a server of your own does not", () => {
  assert.deepEqual(missingOllamaCredentials({}), ["OLLAMA_API_KEY"]);
  assert.deepEqual(missingOllamaCredentials({ OLLAMA_BASE_URL: "https://ollama.com/v1" }), ["OLLAMA_API_KEY"]);
  assert.deepEqual(missingOllamaCredentials({ OLLAMA_API_KEY: "k" }), []);
  assert.deepEqual(missingOllamaCredentials({ OLLAMA_BASE_URL: "http://gpu-box:11434" }), []);
  assert.equal(hasOllamaCredentials({ ANTHROPIC_API_KEY: "sk-ant" }), false);
  assert.deepEqual(
    ollamaCredentialsOnly({ ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "t", OLLAMA_API_KEY: "k" }),
    { OLLAMA_API_KEY: "k" },
  );
});

test("only a Docker sandbox dials this machine's loopback by another name", () => {
  assert.equal(ollamaUrlFromSandbox("http://localhost:11434", "docker"), "http://host.docker.internal:11434");
  assert.equal(ollamaUrlFromSandbox("http://127.0.0.1:11434/v1", "docker"), "http://host.docker.internal:11434/v1");
  assert.equal(ollamaUrlFromSandbox("http://localhost:11434", "local-process"), "http://localhost:11434");
  assert.equal(ollamaUrlFromSandbox("http://localhost.example.com:11434", "docker"), "http://localhost.example.com:11434");
});

test("Claude Code on an Ollama model is said to report no cost", () => {
  assert.equal(reportsCost("claude-code", "ollama/glm-5.1"), false);
  assert.equal(reportsCost("claude-code", "claude-sonnet-5"), true);
  assert.equal(reportsCost("claude-code"), true);
  assert.equal(reportsCost("pi", "ollama/gpt-oss:20b"), true);
  assert.match(spendCoverageNote(), /Claude Code runs on Ollama models report none either/);
});
