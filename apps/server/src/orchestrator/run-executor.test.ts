import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRunPrompt } from "@bento/core";
import {
  announcesLaunchOnFirstEvent,
  dshFailureAdvice,
  mergeAgentExecEnv,
  poolFailureAdvice,
  runnerReportedError,
} from "./run-executor.js";

test("tools without session ids retain stage context whether sent idle or queued", () => {
  for (const cli of ["pool", "dsh"]) {
    for (const followUp of ["Please also add a test.", "Use the smaller implementation."]) {
      const prompt = agentRunPrompt({
        cli,
        followUp,
        stagePrompt: "Implement the feature from the card.",
        resume: true,
      });
      assert.match(prompt, /^Implement the feature from the card\./);
      assert.match(prompt, new RegExp(`${followUp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
  }
  assert.equal(
    agentRunPrompt({ cli: "codex", followUp: "Please add a test.", stagePrompt: "Stage context", resume: true }),
    "Please add a test.",
  );
  assert.equal(
    agentRunPrompt({ cli: "pool", followUp: null, stagePrompt: "Stage context", resume: false }),
    "Stage context",
  );
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

test("a runner-reported pool key failure gets the same advice as a server-executed one", () => {
  const error = "403 Forbidden: please check the api-key you provided: encountered unexpected error";
  const reported = runnerReportedError("pool", error);
  assert.match(reported ?? "", /403 Forbidden/);
  assert.match(reported ?? "", /Replace POOLSIDE_API_KEY under Model provider keys/);
});

test("a runner-reported pool failure that already explains itself is left alone", () => {
  const error = "pool reported the task as not completed (exit code 4)";
  assert.equal(runnerReportedError("pool", error), error);
});

test("a runner-reported failure from another tool is not given pool advice", () => {
  const error = "403 Forbidden: please check the api-key you provided: encountered unexpected error";
  assert.equal(runnerReportedError("codex", error), error);
});

test("a runner report with no error stays empty", () => {
  assert.equal(runnerReportedError("pool", undefined), null);
});

test("DeepSeek Harness failures name the setting that fixes them", () => {
  assert.match(
    dshFailureAdvice("dsh stopped before reporting a result (exit code 1): dsh: 401: invalid API key") ?? "",
    /Replace DEEPSEEK_API_KEY/,
  );
  assert.match(dshFailureAdvice("dsh: 404: model `deepseek-v4-pro` not found") ?? "", /Change the model/);
  assert.match(dshFailureAdvice("Node 22.14 is too old, requires Node 22.19") ?? "", /Node 22\.19/);
  assert.match(dshFailureAdvice("EACCES: permission denied, open dsh-home") ?? "", /profile directory/);
  assert.match(dshFailureAdvice("dsh finished without readable output") ?? "", /developer preview/);
  assert.equal(dshFailureAdvice("the task failed for a project-specific reason"), null);
});

test("a 401 inside tool output is not blamed on the saved DeepSeek key", () => {
  assert.equal(dshFailureAdvice("bash: curl: 401 Unauthorized from the app under test"), null);
  assert.equal(dshFailureAdvice("model `deepseek-v4-pro` not found"), null);
});

test("runner-reported dsh failures receive Harness advice", () => {
  const reported = runnerReportedError(
    "dsh",
    "dsh stopped before reporting a result (exit code 1): dsh: 401: invalid API key",
  );
  assert.match(reported ?? "", /Replace DEEPSEEK_API_KEY/);
});

test("text-mode adapters do not announce launch on their first event", () => {
  assert.equal(announcesLaunchOnFirstEvent({ stdoutMode: "text" }), false);
  assert.equal(announcesLaunchOnFirstEvent({}), true);
  assert.equal(announcesLaunchOnFirstEvent({ stdoutMode: undefined }), true);
});
