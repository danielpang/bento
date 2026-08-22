import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRunPrompt, mergeAgentExecEnv, poolFailureAdvice } from "./run-executor.js";

test("pool follow-ups retain stage context whether sent idle or queued", () => {
  for (const followUp of ["Please also add a test.", "Use the smaller implementation."]) {
    const prompt = agentRunPrompt("pool", followUp, "Implement the feature from the card.");
    assert.match(prompt, /^Implement the feature from the card\./);
    assert.match(prompt, new RegExp(`${followUp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  }
  assert.equal(agentRunPrompt("codex", "Please add a test.", "Stage context"), "Please add a test.");
  assert.equal(agentRunPrompt("pool", null, "Stage context"), "Stage context");
});

test("adapter environment reaches the agent process with credential precedence", () => {
  assert.deepEqual(
    mergeAgentExecEnv(
      {
        POOLSIDE_STANDALONE_BASE_URL: "https://inference.poolside.ai/v1",
        POOLSIDE_STANDALONE_MODEL: "poolside/laguna-s-2.1",
      },
      { POOLSIDE_API_KEY: "saved-key", POOLSIDE_STANDALONE_BASE_URL: "https://enterprise.example/v1" },
      { GITHUB_TOKEN: "clone-token" },
      { GIT_AUTHOR_NAME: "Bento User" },
    ),
    {
      POOLSIDE_STANDALONE_BASE_URL: "https://enterprise.example/v1",
      POOLSIDE_STANDALONE_MODEL: "poolside/laguna-s-2.1",
      POOLSIDE_API_KEY: "saved-key",
      GITHUB_TOKEN: "clone-token",
      GIT_AUTHOR_NAME: "Bento User",
    },
  );
});

/**
 * Every string below is what pool 1.0.16 actually printed: the first
 * two against Poolside-hosted inference with a refused key, the next
 * against an OpenAI-compatible endpoint answering 401 and 404, and the
 * last against a run that simply worked. Written from captures rather
 * than from the docs, because the docs describe none of them.
 */
test("a key pool cannot use names the key, wherever the refusal came from", () => {
  const platform = poolFailureAdvice(
    "403 Forbidden: please check the api-key you provided: encountered unexpected error",
  );
  assert.match(platform ?? "", /Replace POOLSIDE_API_KEY under Model provider keys/);
  const compatible = poolFailureAdvice("401 Unauthorized: Incorrect API key provided: encountered unexpected error");
  assert.match(compatible ?? "", /Replace POOLSIDE_API_KEY/);
  // The same advice for a key that is missing from the sandbox rather
  // than refused by the endpoint: pool cannot tell them apart, and the
  // fix is the same screen either way.
  assert.match(poolFailureAdvice("no auth token provided") ?? "", /Replace POOLSIDE_API_KEY/);
});

test("an unrelated authorization failure is not blamed on the saved key", () => {
  assert.equal(poolFailureAdvice("403 Forbidden: this account cannot access the requested model"), null);
});

test("a model the endpoint does not serve names the model and where to change it", () => {
  const advice = poolFailureAdvice(
    "404 Not Found: The model `laguna-xl-9` does not exist: encountered unexpected error",
  );
  assert.match(advice ?? "", /pool could not run the model laguna-xl-9\./);
  assert.match(advice ?? "", /Change the model on this agent under Agents, then run again\./);
  // Deliberately a different sentence from the key one: "no key" and
  // "wrong model" have different fixes, and one auth-shaped message
  // for both hides the case where the credentials are correct.
  assert.doesNotMatch(advice ?? "", /POOLSIDE_API_KEY/);
});

test("a failure pool already explained is left alone", () => {
  assert.equal(poolFailureAdvice("pool reported the task as not completed (exit code 4)"), null);
  assert.equal(
    poolFailureAdvice("executable file `pool` not found in $PATH"),
    null,
    "a missing binary has its own message, which must not be replaced by credentials advice",
  );
  assert.equal(poolFailureAdvice(""), null);
});
