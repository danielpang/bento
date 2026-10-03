import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRunPrompt } from "@bento/core";
import {
  announcesLaunchOnFirstEvent,
  captureRunFinished,
  dshFailureAdvice,
  mergeAgentExecEnv,
  missingRequiredEnvMessage,
  museFailureAdvice,
  poolFailureAdvice,
  runDurationSeconds,
  runnerReportedError,
} from "./run-executor.js";
import type { Analytics } from "../analytics.js";
import type { AppContext } from "../context.js";

test("a hosted run without a key points at Agents, Model provider keys", () => {
  assert.equal(
    missingRequiredEnvMessage({
      missing: ["AI_GATEWAY_API_KEY"],
      toolName: "fx",
      cli: "fx",
      mode: "multi",
      onOllama: false,
      sharing: false,
      canShareLogin: false,
    }),
    "No AI_GATEWAY_API_KEY is configured, so fx cannot start. Add it under Agents, Model provider keys. Then re-run the agent.",
  );
});

test("a local run without a key still points at bento setup", () => {
  assert.match(
    missingRequiredEnvMessage({
      missing: ["ANTHROPIC_API_KEY"],
      toolName: "Claude Code",
      cli: "claude-code",
      mode: "local",
      onOllama: false,
      sharing: false,
      canShareLogin: false,
    }),
    /bento setup/,
  );
});

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

test("Muse Code failures name the setting that fixes them", () => {
  assert.match(
    museFailureAdvice("muse stopped before reporting a result (exit code 1): invalid API key") ?? "",
    /Replace META_API_KEY/,
  );
  assert.match(museFailureAdvice("The model `muse-spark-9` does not exist") ?? "", /Change the model/);
  assert.equal(museFailureAdvice("the tests failed"), null);
  assert.equal(museFailureAdvice("executable file `muse` not found in $PATH"), null);
});

test("runner-reported muse failures receive Muse Code advice", () => {
  const reported = runnerReportedError("muse", "unauthorized: invalid API key");
  assert.match(reported ?? "", /Replace META_API_KEY/);
});

test("a runner-reported Claude outage names the Claude status page", () => {
  const reported = runnerReportedError(
    "claude-code",
    `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
    "claude-sonnet-5",
  );
  assert.match(reported ?? "", /529/);
  assert.match(reported ?? "", /status\.claude\.com/);
});

test("a runner-reported OpenAI outage names the OpenAI status page", () => {
  const reported = runnerReportedError(
    "codex",
    "The server had an error while processing your request. Sorry about that!",
    "gpt-5-codex",
  );
  assert.match(reported ?? "", /status\.openai\.com/);
});

test("a runner-reported OpenRouter outage names the OpenRouter status page", () => {
  const reported = runnerReportedError(
    "opencode",
    "OpenRouter API error: Provider returned error (502 Bad Gateway)",
    "openrouter/anthropic/claude-sonnet-5",
  );
  assert.match(reported ?? "", /status\.openrouter\.ai/);
});

test("a runner-reported Cursor outage names the Cursor status page", () => {
  const reported = runnerReportedError("cursor", "503 Service Unavailable", "claude-sonnet-5");
  assert.match(reported ?? "", /status\.cursor\.com/);
});

test("a runner-reported DeepSeek outage names the DeepSeek status page", () => {
  const reported = runnerReportedError("dsh", "503 Service Unavailable", "deepseek-v4-pro");
  assert.match(reported ?? "", /status\.deepseek\.com/);
});

test("a runner-reported Grok mention names the xAI status page", () => {
  const reported = runnerReportedError("cursor", "xAI API error: grok-4.6 is overloaded", "grok-4.6");
  assert.match(reported ?? "", /status\.x\.ai/);
});

test("a runner-reported auth failure is not given a status page", () => {
  assert.equal(
    runnerReportedError("claude-code", "401 Unauthorized: invalid API key", "claude-sonnet-5"),
    "401 Unauthorized: invalid API key",
  );
});

test("text-mode adapters do not announce launch on their first event", () => {
  assert.equal(announcesLaunchOnFirstEvent({ stdoutMode: "text" }), false);
  assert.equal(announcesLaunchOnFirstEvent({}), true);
  assert.equal(announcesLaunchOnFirstEvent({ stdoutMode: undefined }), true);
});

/**
 * Thenable drizzle chain for captureRunFinished: the one select it
 * issues resolves to the canned row, join and all.
 */
function dbReturning(rows: unknown[]) {
  const obj: Record<string, unknown> = {};
  const next = () => obj;
  obj.select = next;
  obj.from = next;
  obj.innerJoin = next;
  obj.leftJoin = next;
  obj.where = next;
  obj.limit = next;
  obj.then = (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(onFulfilled, onRejected);
  return obj;
}

const FINISHED_ROW = {
  startedBy: "user-1",
  type: "pipeline",
  featureId: "feature-1",
  stageId: "stage-1",
  swarmId: null,
  swarmTaskId: null,
  role: "stage",
  executor: "server",
  costUsd: "0.42",
  numTurns: 7,
  exitCode: 0,
  error: null,
  startedAt: new Date("2026-09-01T10:00:00Z"),
  endedAt: new Date("2026-09-01T10:02:30Z"),
  agentProfileId: "profile-1",
  harness: "claude-code",
  model: "claude-opus-5",
  // Both parents are read, and only the run's own board fills one in.
  featureOrganizationId: "org-1",
  featureProjectId: "project-1",
  swarmOrganizationId: null,
  swarmProjectId: null,
};

test("a finished run reports which harness and model ran it", async () => {
  const captured: Array<{ event: string; userId?: string | null; organizationId?: string | null; properties?: Record<string, unknown> }> =
    [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  await captureRunFinished(
    { analytics, db: dbReturning([FINISHED_ROW]) } as unknown as AppContext,
    "run-1",
    "succeeded",
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, "agent run finished");
  assert.equal(captured[0]?.userId, "user-1");
  assert.equal(captured[0]?.organizationId, "org-1");
  assert.deepEqual(captured[0]?.properties, {
    status: "succeeded",
    success: true,
    run_id: "run-1",
    type: "pipeline",
    feature_id: "feature-1",
    stage_id: "stage-1",
    swarm_id: null,
    swarm_task_id: null,
    project_id: "project-1",
    role: "stage",
    executor: "server",
    agent_profile_id: "profile-1",
    harness: "claude-code",
    model: "claude-opus-5",
    duration_seconds: 150,
    cost_usd: 0.42,
    num_turns: 7,
    exit_code: 0,
    error: null,
  });
});

test("a run that never started has no duration, and no analytics means no query", async () => {
  assert.equal(runDurationSeconds(null, new Date()), null);
  assert.equal(runDurationSeconds(new Date("2026-09-01T10:00:00Z"), null), null);
  // A clock that went backwards must not report a negative run.
  assert.equal(runDurationSeconds(new Date("2026-09-01T10:00:01Z"), new Date("2026-09-01T10:00:00Z")), null);
  assert.equal(runDurationSeconds(new Date("2026-09-01T10:00:00.000Z"), new Date("2026-09-01T10:00:00.250Z")), 0.25);

  let queried = false;
  const db = new Proxy(
    {},
    {
      get: () => {
        queried = true;
        return () => db;
      },
    },
  );
  await captureRunFinished({ analytics: null, db } as unknown as AppContext, "run-1", "failed");
  assert.equal(queried, false);
});
