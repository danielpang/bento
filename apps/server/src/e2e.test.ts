import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createDb,
  createPool,
  agentProfiles,
  featureMessages,
  featureEvents,
  featurePullRequests,
  features,
  gateChecks,
  githubInstallations,
  agentRuns,
  organization,
  pipelines,
  projects,
  repositories,
  runEvents,
  runMigrations,
  sandboxes,
  stages,
} from "@bento/db";
import { SseParser } from "@bento/core";
import { LocalProcessDriver, WorktreeManager, type SandboxHandle } from "@bento/sandbox";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { publishFeatureBranches } from "./orchestrator/publish.js";
import { linkGitHubRemotes } from "./orchestrator/repo-remote.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { createFeatureFlags } from "./feature-flags.js";
import {
  deliverQueuedMessage,
  markCancelled,
  registerJobs,
  recoverInterruptedRuns,
} from "./orchestrator/run-executor.js";
import { reapSandbox } from "./orchestrator/reap-sandbox.js";
import { appendRunEvent } from "./orchestrator/transcript.js";
import {
  JUDGE_PROMPT_PREFIX,
  advanceFeature,
  evaluateFeatureGate,
  finishFeature,
  moveFeatureTo,
} from "./orchestrator/gate-evaluator.js";
import { CARD_BUSY_DELETE, startRunIfIdle } from "./orchestrator/start-run.js";
import { resolveAgentEnv } from "./orchestrator/agent-env.js";
import { gitIdentityEnv } from "./orchestrator/agent-auth.js";
import { claudeCodeAdapter, opencodeAdapter } from "@bento/agents";
import { recoverMissedMessages } from "./orchestrator/recover-session.js";

const run = promisify(execFile);

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "e2e_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let repoDir: string;

async function recreateTestDb(): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
}

before(async () => {
  await recreateTestDb();
  await runMigrations(testUrl);

  repoDir = await mkdtemp(path.join(tmpdir(), "bento-fixture-repo-"));
  await run("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", [
    "-C",
    repoDir,
    "-c",
    "user.email=test@bento.dev",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "init",
  ]);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-data-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    BENTO_LIVE_IDLE_SEC: "0",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  const userId = await ensureLocalUser(db);

  ctx = {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    driver: new LocalProcessDriver(),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
    featureFlags: createFeatureFlags(env),
  };
  await registerJobs(ctx);
  app = createApp(ctx);
});

after(async () => {
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

async function json<T>(res: Response): Promise<T> {
  if (!res.ok && res.status !== 201) {
    assert.fail(`unexpected status ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];

async function waitForRun(runId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await json<{ status: string }>(await app.request(`/api/runs/${runId}`));
    if (TERMINAL_STATUSES.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}

/** Waits until the feature settles on one of the expected statuses. */
async function waitForFeatureStatus(featureId: string, expected: string[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; currentStageId: string | null } | null = null;
  while (Date.now() < deadline) {
    last = await json<{ status: string; currentStageId: string | null }>(
      await app.request(`/api/features/${featureId}`),
    );
    if (expected.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`feature ${featureId} stayed ${last?.status} instead of ${expected.join("|")}`);
}

/**
 * Waits for the card to reach a specific stage. Status alone is not a
 * usable signal here: a card is already "active" on the stage it is
 * leaving, so waiting on status races the gate.
 */
async function waitForStage(featureId: string, stageId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; currentStageId: string | null } | null = null;
  while (Date.now() < deadline) {
    last = await json<{ status: string; currentStageId: string | null }>(
      await app.request(`/api/features/${featureId}`),
    );
    if (last.currentStageId === stageId) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`feature ${featureId} stopped at stage ${last?.currentStageId} (status ${last?.status})`);
}

/**
 * The last transition on a card, once it reads as `expected`.
 *
 * The move and the history row commit together, so a card that has
 * already reached its next stage already has the transition that put
 * it there. This still waits because the evaluator is a background
 * job, and the test can get here before that job has run. Returns the
 * last trigger seen on timeout, so a real regression fails on the real
 * value rather than a throw.
 */
async function waitForLastTransition(featureId: string, expected: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const transitions = await json<{ trigger: string; toStageId: string }[]>(
      await app.request(`/api/features/${featureId}/transitions`),
    );
    last = transitions.at(-1)?.trigger;
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function setupProject(name: string) {
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, localPath: repoDir }),
    }),
  );
  await unassignStages(project.id);
  const pipeline = await json<{ stages: { id: string; name: string; position: number }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  return { project, stages: pipeline.stages };
}

async function createFeature(projectId: string, title: string) {
  return json<{ id: string }>(
    await app.request("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, title, description: "e2e" }),
    }),
  );
}

async function fakeProfile(name: string) {
  return json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, cli: "fake", model: "fake-1" }),
    }),
  );
}

/**
 * Takes the seeded agents off a project's stages.
 *
 * A new project arrives with one on each, which is what a person wants
 * and what these tests must not have: they assign their own fake agent,
 * and a seeded claude-code agent would start a real run the moment a
 * card advanced. Called by every test that creates a project, so each
 * one still says out loud what it assigns.
 */
async function unassignStages(projectId: string): Promise<void> {
  const pipeline = await json<{ stages: { id: string }[] }>(
    await app.request(`/api/projects/${projectId}/pipeline`),
  );
  for (const stage of pipeline.stages) {
    await patchStage(stage.id, { defaultAgentProfileId: null });
  }
}

async function patchStage(stageId: string, patch: Record<string, unknown>) {
  return json<{ id: string }>(
    await app.request(`/api/stages/${stageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

test("local mode reports the acting user as a beta tester", async () => {
  const res = await app.request("/api/flags");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { betaTesters: true });
});

test("local mode can manage machine credentials", async () => {
  const created = await json<{ id: string }>(
    await app.request("/api/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "local-secret-value" }),
    }),
  );
  const listed = await json<{ secrets: { id: string; name: string; hint: string }[]; canManage: boolean }>(
    await app.request("/api/secrets"),
  );
  assert.equal(listed.canManage, true);
  assert.equal(listed.secrets.length, 1);
  assert.deepEqual(
    { id: listed.secrets[0]?.id, name: listed.secrets[0]?.name, hint: listed.secrets[0]?.hint },
    { id: created.id, name: "ANTHROPIC_API_KEY", hint: "••••••••alue" },
  );

  const rotated = await json<{ id: string; hint: string }>(
    await app.request("/api/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "rotated-secret-5678" }),
    }),
  );
  assert.equal(rotated.id, created.id, "rotation updates the local credential instead of inserting a duplicate");
  assert.equal(rotated.hint, "••••••••5678");
  assert.equal((await json<{ secrets: unknown[] }>(await app.request("/api/secrets"))).secrets.length, 1);

  const removed = await app.request(`/api/secrets/${rotated.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await json(await app.request("/api/secrets")), { secrets: [], canManage: true });
});

/**
 * A run with no credential fails before the agent starts, and the
 * reason has to reach a person: it lands in the transcript (the one
 * surface every client shows) and names a door that exists. The
 * sharing path itself needs a real login on the machine, so it is
 * verified live rather than here; this pins the gate and the message.
 */
test("a run without credentials says so in the transcript", { timeout: 90_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("No key");
  const feature = await createFeature(project.id, "Needs a key");
  const claude = await json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "keyless", cli: "claude-code", model: "claude-opus-5" }),
    }),
  );
  await patchStage(projectStages[0]!.id, { defaultAgentProfileId: claude.id });
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const deadline = Date.now() + 30_000;
  let failed: { status: string; error: string | null } | undefined;
  while (Date.now() < deadline) {
    const { runs } = await json<{ runs: { status: string; error: string | null }[] }>(
      await app.request(`/api/features/${feature.id}`),
    );
    failed = runs[0];
    if (failed && failed.status === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /No ANTHROPIC_API_KEY is configured/);
  assert.match(failed?.error ?? "", /bento setup/, "the message points at a door local mode actually has");

  const { runs } = await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`));
  const transcript = await (await app.request(`/api/runs/${runs[0]!.id}/transcript`)).text();
  assert.match(transcript, /system> No ANTHROPIC_API_KEY/, "the reason is in the transcript, not a column nobody renders");
});

/**
 * What a card's agents produced, read back from the feature branch:
 * the changed files, the diff, and the stage write-ups under
 * docs/bento/. Git is the source, so this works with the worktree and
 * sandbox both gone.
 */
test("a card's committed changes and artifacts can be read back", async () => {
  const { project } = await setupProject("Changes read-back");
  const feature = await createFeature(project.id, "Readable changes");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const { branchName } = await json<{ branchName: string }>(await app.request(`/api/features/${feature.id}`));
  assert.ok(branchName, "advancing assigns the branch");

  // Play the agent: commit a code change and a stage write-up.
  await run("git", ["-C", repoDir, "checkout", "-qb", branchName]);
  await writeFile(path.join(repoDir, "sites.ts"), "export const sites = [];\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", ["-C", repoDir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "add sites"]);
  await mkdir(path.join(repoDir, "docs", "bento"), { recursive: true });
  await writeFile(path.join(repoDir, "docs", "bento", "product-investigation.md"), "# Findings\nShip it.\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", ["-C", repoDir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "notes"]);
  await run("git", ["-C", repoDir, "checkout", "-q", "main"]);

  const changes = await json<{
    repositories: {
      name: string;
      files: { path: string }[];
      diff: string;
      artifacts: { path: string; content: string }[];
    }[];
  }>(await app.request(`/api/features/${feature.id}/changes`));
  assert.equal(changes.repositories.length, 1);
  const repo = changes.repositories[0]!;
  assert.ok(repo.files.some((f) => f.path === "sites.ts"), "the changed file is listed");
  assert.match(repo.diff, /export const sites/, "the diff carries the change itself");
  assert.equal(repo.artifacts[0]?.path, "docs/bento/product-investigation.md");
  assert.match(repo.artifacts[0]?.content ?? "", /Ship it/, "the write-up is readable in full");

  const plain = await (await app.request(`/api/features/${feature.id}/changes/plain`)).text();
  assert.match(plain, /sites\.ts/);
  assert.match(plain, /Ship it/, "the Mac pane sees the same content as lines");
});

/**
 * A feature branched from a checkout sitting on unmerged work must not
 * claim that work as its own: the diff base is the fork point, not the
 * default branch's merge-base.
 */
/**
 * The whole artifact path against real parts: a run whose agent drops
 * files in the workspace artifacts directory, the capture that reads
 * them out through the driver, the store that keeps the binary one, and
 * the routes that hand them back with the headers that keep agent bytes
 * from ever acting as the console.
 */
test("a run's artifacts are captured, listed, and served safely", { timeout: 90_000 }, async () => {
  const { project } = await setupProject("Artifact capture");
  const feature = await createFeature(project.id, "Artifact card");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const profile = await fakeProfile("artifact-fake");
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "make ARTIFACT files" }),
    }),
  );
  assert.equal(await waitForRun(run.id), "succeeded");

  const listed = await json<{ id: string; path: string; kind: string; mime: string; size: number }[]>(
    await app.request(`/api/features/${feature.id}/artifacts`),
  );
  const plan = listed.find((a) => a.path === "artifacts/fake-plan.md");
  const shot = listed.find((a) => a.path === "artifacts/fake-shot.png");
  assert.ok(plan, `the markdown artifact is listed, got ${JSON.stringify(listed)}`);
  assert.ok(shot, "the image artifact is listed");
  assert.equal(plan.kind, "markdown");
  assert.equal(shot.kind, "image");

  // The write-up came back inline, sandboxed and unsniffable: agent
  // bytes served by the console must never be able to act as it.
  const planBody = await app.request(`/api/artifacts/${plan.id}/content`);
  assert.equal(planBody.status, 200);
  assert.equal(planBody.headers.get("content-type"), "text/markdown");
  assert.equal(planBody.headers.get("content-security-policy"), "sandbox");
  assert.equal(planBody.headers.get("x-content-type-options"), "nosniff");
  assert.match(await planBody.text(), /Fake plan/);

  // The image went through the artifact store and came back byte for byte.
  const shotBody = await app.request(`/api/artifacts/${shot.id}/content`);
  assert.equal(shotBody.status, 200);
  assert.equal(shotBody.headers.get("content-type"), "image/png");
  assert.equal(await shotBody.text(), "not-really-a-png");

  // Captured files leave the workspace, or the next run on this sandbox
  // would capture them again as its own.
  const leftBehind = await readdir(path.join(ctx.worktrees.workspacePath(feature.id), "artifacts")).catch(
    () => [] as string[],
  );
  assert.deepEqual(leftBehind, [], "captured files are removed from the artifacts directory");
});

test("changes exclude work inherited from the branch point", async () => {
  const { project } = await setupProject("Fork point");
  const feature = await createFeature(project.id, "Fork point card");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const { branchName } = await json<{ branchName: string }>(await app.request(`/api/features/${feature.id}`));

  const commit = async (message: string) => {
    await run("git", ["-C", repoDir, "add", "-A"]);
    await run("git", ["-C", repoDir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", message]);
  };
  // Side work not on main, then the feature branches from its tip.
  await run("git", ["-C", repoDir, "checkout", "-qb", "side/unmerged"]);
  await writeFile(path.join(repoDir, "inherited.ts"), "export const inherited = true;\n");
  await commit("side work");
  await run("git", ["-C", repoDir, "checkout", "-qb", branchName]);
  await writeFile(path.join(repoDir, "mine.ts"), "export const mine = true;\n");
  await commit("card work");
  await run("git", ["-C", repoDir, "checkout", "-q", "main"]);

  const changes = await json<{ repositories: { files: { path: string }[] }[] }>(
    await app.request(`/api/features/${feature.id}/changes`),
  );
  const paths = changes.repositories[0]?.files.map((f) => f.path) ?? [];
  assert.deepEqual(paths, ["mine.ts"], "only the card's own commits count as its changes");
});

/**
 * Pipelines are editable structures: a stage can join at the end and
 * leave when empty. Occupied stages refuse deletion, because silently
 * relocating live cards is how boards lose things.
 */
test("a project can be renamed, and removing it takes its board", async () => {
  const { project } = await setupProject("Working title");
  const feature = await createFeature(project.id, "Card that goes with it");

  const renamed = await json<{ name: string; autoStartPipeline: boolean }>(
    await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Payments revamp  " }),
    }),
  );
  assert.equal(renamed.name, "Payments revamp", "the stored name is trimmed");
  assert.equal(renamed.autoStartPipeline, false, "a new project waits for a person by default");

  const blank = await app.request(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(blank.status, 400, "a name of only spaces is not a name");

  // One field at a time: the panel flips the toggle without restating
  // the name, and doing so must not blank it.
  const toggled = await json<{ name: string; autoStartPipeline: boolean }>(
    await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoStartPipeline: true }),
    }),
  );
  assert.equal(toggled.autoStartPipeline, true);
  assert.equal(toggled.name, "Payments revamp", "a settings write leaves the name alone");

  const removed = await json<{ deletedCards: number }>(
    await app.request(`/api/projects/${project.id}`, { method: "DELETE" }),
  );
  assert.equal(removed.deletedCards, 1, "the delete says how much board went with it");

  assert.equal((await app.request(`/api/projects/${project.id}`)).status, 404);
  assert.equal(
    (await app.request(`/api/features/${feature.id}`)).status,
    404,
    "the cards go with the project rather than outliving it",
  );
  // Removing it twice must not read as though there were two of it.
  assert.equal((await app.request(`/api/projects/${project.id}`, { method: "DELETE" })).status, 404);
});

test("stages can be added, and removed only when empty", async () => {
  const { project, stages: initial } = await setupProject("Editable pipeline");
  const pipeline = await json<{ id: string }>(await app.request(`/api/projects/${project.id}/pipeline`));

  const created = await json<{ id: string; position: number; name: string; gateType: string }>(
    await app.request("/api/stages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipelineId: pipeline.id, name: "Security review" }),
    }),
  );
  assert.equal(created.name, "Security review");
  assert.equal(created.position, initial.length, "the new stage joins at the end");
  assert.equal(created.gateType, "manual", "new stages wait for a person until told otherwise");

  // A card in the first stage blocks that stage's removal.
  const feature = await createFeature(project.id, "Occupier");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const refused = await app.request(`/api/stages/${initial[0]!.id}`, { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /move them first/);

  // The empty new stage removes cleanly.
  const removed = await app.request(`/api/stages/${created.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const after = await json<{ stages: { id: string }[] }>(await app.request(`/api/projects/${project.id}/pipeline`));
  assert.ok(!after.stages.some((s) => s.id === created.id));
});

/**
 * The live path: an adapter that holds a stdin conversation hears a
 * message while it works, in the same run. The fake's LIVE mode reads
 * stdin lines and answers each with a turn, so this proves the driver
 * stdin channel, the executor's delivery handle, and the run staying
 * open across turns, without spending a token.
 */
test("a live session hears messages mid-run without a second run", { timeout: 120_000 }, async () => {
  const { project } = await setupProject("Live session");
  const feature = await createFeature(project.id, "Live card");
  const profile = await fakeProfile("live-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const first = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "LIVE hello" }),
    }),
  );

  // Genuinely running, so the live handle exists.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await json<{ status: string }>(await app.request(`/api/runs/${first.id}`));
    if (current.status === "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const sent = await json<{ queued: boolean; live?: boolean; delivery?: string }>(
    await app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "change of plan" }),
    }),
  );
  assert.equal(sent.queued, false, "a live session hears the message now");
  assert.equal(sent.live, true);
  assert.equal(sent.delivery, "queue", "the fake declares queue-behind-turn semantics");

  assert.equal(await waitForRun(first.id, 90_000), "succeeded");
  const { runs } = await json<{ runs: unknown[] }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(runs.length, 1, "the conversation stayed inside one run");

  const transcript = await (await app.request(`/api/runs/${first.id}/transcript`)).text();
  assert.match(transcript, /you> change of plan/, "the user's line is in the conversation");
  const turns = transcript.match(/\[done/g)?.length ?? 0;
  assert.equal(turns >= 2, true, "the second message produced a second turn in the same run");
});

/**
 * After a live turn finishes on a manual stage with nothing queued,
 * the process stays open for a short idle window so the next message
 * is the same conversation rather than a new run.
 */
test("a live session stays open after a turn so a later message needs no second run", { timeout: 120_000 }, async () => {
  const previousIdle = ctx.env.BENTO_LIVE_IDLE_SEC;
  ctx.env.BENTO_LIVE_IDLE_SEC = 20;
  try {
    const { project } = await setupProject("Live idle hold");
    const feature = await createFeature(project.id, "Idle card");
    const profile = await fakeProfile("idle-fake");
    await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

    const first = await json<{ id: string }>(
      await app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "LIVE hello" }),
      }),
    );

    const deadline = Date.now() + 30_000;
    let sawFirstTurn = false;
    while (Date.now() < deadline) {
      const current = await json<{ status: string }>(await app.request(`/api/runs/${first.id}`));
      const transcript = await (await app.request(`/api/runs/${first.id}/transcript`)).text();
      if (current.status === "running" && /\[done/.test(transcript)) {
        sawFirstTurn = true;
        break;
      }
      if (TERMINAL_STATUSES.includes(current.status)) {
        assert.fail(`the run ended (${current.status}) before the idle window could hold it`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(sawFirstTurn, "the first turn finished while the run stayed open");

    const sent = await json<{ queued: boolean; live?: boolean }>(
      await app.request(`/api/features/${feature.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "keep going" }),
      }),
    );
    assert.equal(sent.queued, false, "the waiting session heard the message now");
    assert.equal(sent.live, true);

    assert.equal(await waitForRun(first.id, 90_000), "succeeded");
    const { runs } = await json<{ runs: unknown[] }>(await app.request(`/api/features/${feature.id}`));
    assert.equal(runs.length, 1, "the later message stayed inside the same run");
    const transcript = await (await app.request(`/api/runs/${first.id}/transcript`)).text();
    assert.match(transcript, /you> keep going/);
    const turns = transcript.match(/\[done/g)?.length ?? 0;
    assert.equal(turns >= 2, true, "the later message produced a second turn");
    assert.match(transcript, /The agent is waiting/);
  } finally {
    ctx.env.BENTO_LIVE_IDLE_SEC = previousIdle;
  }
});

/**
 * Reads SSE frames off a streaming response, one at a time, through
 * the same parser the api-client ships. That is the point: the first
 * version of this helper hand-rolled its own parsing, so the wire
 * format looked covered while the parser real clients run stayed
 * untested.
 */
function sseFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const pending: { event: string; data: string }[] = [];
  return {
    /** The next complete frame, or null when the stream ends. */
    async next(): Promise<{ event: string; data: string } | null> {
      while (pending.length === 0) {
        const { value, done } = await reader.read();
        if (done) return null;
        pending.push(...parser.push(decoder.decode(value, { stream: true })));
      }
      return pending.shift()!;
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  };
}

/**
 * The typing is visible but not durable: fragments of the message the
 * agent is composing reach an open viewer as run_delta frames, and the
 * finished message is the only copy that survives. A replay after the
 * run must carry events and no fragments, or refreshing the page would
 * change what the conversation says.
 */
test("the message being typed streams live and is never persisted", { timeout: 120_000 }, async () => {
  const { project } = await setupProject("Delta streaming");
  const feature = await createFeature(project.id, "Typing card");
  const profile = await fakeProfile("delta-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "LIVE hello" }),
    }),
  );

  // Subscribed before the worker picks the run up, so the first turn's
  // fragments are broadcast while someone is listening.
  const live = await app.request(`/api/runs/${run.id}/events?since=0`);
  assert.ok(live.body, "the events endpoint streams");
  const frames = sseFrames(live.body!);
  const deltas: { channel: string; text: string }[] = [];
  let status = "";
  try {
    while (true) {
      const frame = await frames.next();
      assert.ok(frame, "the stream ends with done, not a bare EOF");
      if (frame.event === "run_delta") deltas.push(JSON.parse(frame.data) as { channel: string; text: string });
      if (frame.event === "done") {
        status = (JSON.parse(frame.data) as { status: string }).status;
        break;
      }
    }
  } finally {
    await frames.cancel();
  }
  assert.equal(status, "succeeded");
  assert.ok(
    deltas.some((d) => d.channel === "text" && d.text === "Heard."),
    "the fragment reached the open stream",
  );

  // The same endpoint after the run: replayed events, no fragments.
  const replay = await app.request(`/api/runs/${run.id}/events?since=0`);
  const replayFrames = sseFrames(replay.body!);
  let sawMessage = false;
  try {
    while (true) {
      const frame = await replayFrames.next();
      assert.ok(frame, "the replay ends with done");
      assert.notEqual(frame.event, "run_delta", "fragments must not survive the run");
      if (frame.event === "run_event" && frame.data.includes("Heard.")) sawMessage = true;
      if (frame.event === "done") break;
    }
  } finally {
    await replayFrames.cancel();
  }
  assert.ok(sawMessage, "the finished message is the durable copy");
});

/**
 * Talking to a working agent queues: a headless run cannot hear
 * mid-flight, so the message waits on the card and becomes a resume
 * run, in the same session, the moment the run ends. Two messages
 * during one run arrive as one combined delivery.
 */
test("a message sent mid-run is queued and delivered when the run ends", { timeout: 120_000 }, async () => {
  const { project } = await setupProject("Queued messages");
  const feature = await createFeature(project.id, "Chatty card");
  const profile = await fakeProfile("queue-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const first = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // SLOW keeps the run alive long enough to talk over it.
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "SLOW keep going" }),
    }),
  );

  const say = (text: string) =>
    app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

  // Genuinely running before we talk over it.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await json<{ status: string }>(await app.request(`/api/runs/${first.id}`));
    if (current.status === "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const one = await json<{ queued: boolean }>(await say("first thought"));
  assert.equal(one.queued, true, "a message during a run queues instead of demanding a stop");
  const two = await json<{ queued: boolean }>(await say("second thought"));
  assert.equal(two.queued, true);

  await waitForRun(first.id, 90_000);

  // Delivery is part of the run ending, so the follow-up appears at once.
  let follow: { id: string; prompt: string; cliSessionId: string | null } | undefined;
  const followDeadline = Date.now() + 20_000;
  while (Date.now() < followDeadline && !follow) {
    const { runs } = await json<{ runs: { id: string; prompt: string; cliSessionId: string | null }[] }>(
      await app.request(`/api/features/${feature.id}`),
    );
    follow = runs.find((r) => r.id !== first.id);
    if (!follow) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(follow, "the queued message becomes a run of its own");
  assert.equal(follow.prompt, "first thought\nsecond thought", "messages during one run stack");
  assert.equal(follow.cliSessionId, "fake-session-1", "delivery resumes the same session");

  await waitForRun(follow.id, 90_000);
  const transcript = await (await app.request(`/api/runs/${follow.id}/transcript`)).text();
  assert.match(transcript, /you> first thought/, "the conversation shows the user's line");

  // The stitched view: both runs, in order, with who spoke them.
  const conversation = await json<{ blocks: { agentName: string; events: { type: string; role?: string; text?: string }[] }[] }>(
    await app.request(`/api/features/${feature.id}/conversation`),
  );
  assert.equal(conversation.blocks.length, 2, "both finished runs are in the conversation");
  assert.equal(conversation.blocks[0]?.agentName, "queue-fake");
  const followEvents = conversation.blocks[1]?.events ?? [];
  assert.ok(
    followEvents.some((e) => e.type === "message" && e.role === "user" && (e.text ?? "").includes("first thought")),
    "the follow-up block carries the user's message",
  );
});

/**
 * A resume against a conversation the sandbox no longer holds fails
 * instantly, and before the executor learned to recover, the dead
 * session id was re-persisted and every retry resumed it again: one
 * card failed the same way three times in a row. Now the id is wiped
 * and a fresh run with the same prompt starts by itself.
 */
test("a resume against a lost conversation restarts fresh instead of failing forever", { timeout: 120_000 }, async () => {
  const { project } = await setupProject("Dead session");
  const feature = await createFeature(project.id, "Amnesiac card");
  const profile = await fakeProfile("deadsession-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const first = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "settle in" }),
    }),
  );
  assert.equal(await waitForRun(first.id, 90_000), "succeeded");

  // A message on the idle card becomes a resume run in the recorded
  // session, which the fake then reports as gone.
  await app.request(`/api/features/${feature.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "DEADSESSION carry on" }),
  });

  interface RunRow {
    id: string;
    prompt: string;
    status: string;
    cliSessionId: string | null;
    error: string | null;
  }
  // The failed resume and its fresh replacement, which must succeed.
  let failed: RunRow | undefined;
  let retried: RunRow | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(failed && retried?.status === "succeeded")) {
    const { runs } = await json<{ runs: RunRow[] }>(await app.request(`/api/features/${feature.id}`));
    const followUps = runs.filter((r) => r.prompt === "DEADSESSION carry on");
    failed = followUps.find((r) => r.status === "failed");
    retried = followUps.find((r) => r.status === "succeeded");
    if (!(failed && retried)) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(failed, "the dead resume fails");
  assert.match(failed.error ?? "", /No conversation found with session ID/, "the failure names the reason");
  assert.equal(failed.cliSessionId, null, "the dead session id is wiped, so nothing resumes it again");
  assert.ok(retried && retried.id !== failed.id, "a fresh run with the same prompt starts by itself");
  assert.equal(retried.status, "succeeded");

  const transcript = await (await app.request(`/api/runs/${failed.id}/transcript`)).text();
  assert.match(transcript, /cannot be resumed/, "the transcript says what happened and what happens next");
});

/**
 * Transcript writes survive concurrent writers. During a restart the
 * dying process's loop and the new process's reattached loop briefly
 * drive the same run, and with in-memory seq counters their first
 * collision on the (run_id, seq) unique index killed a loop and dropped
 * an agent message. Seq is now allocated in the database with a retry,
 * so every message lands exactly once, whoever writes it.
 */
test("concurrent transcript appends all land, with contiguous seqs", async () => {
  const { project, stages: projectStages } = await setupProject("Concurrent transcript");
  const feature = await createFeature(project.id, "Two writers");
  const profile = await fakeProfile("append-fake");
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: projectStages[0]!.id,
      agentProfileId: profile.id,
      prompt: "hold still",
      status: "running",
      executor: "server",
    })
    .returning();

  const writers = 25;
  await Promise.all(
    Array.from({ length: writers }, (_, i) =>
      appendRunEvent(ctx, run!.id, { type: "message", role: "system", text: `line ${i}` }),
    ),
  );

  const rows = await ctx.db
    .select({ seq: runEvents.seq, payload: runEvents.payload })
    .from(runEvents)
    .where(eq(runEvents.runId, run!.id))
    .orderBy(sql`seq`);
  assert.equal(rows.length, writers, "every append landed despite racing for the same seq");
  assert.deepEqual(
    rows.map((r) => r.seq),
    Array.from({ length: writers }, (_, i) => i + 1),
    "seqs are contiguous from 1, with no gaps for a stream cursor to fall into",
  );
  const texts = new Set(rows.map((r) => (r.payload as { text: string }).text));
  assert.equal(texts.size, writers, "no message was lost or duplicated");
});

/**
 * The transcript hole a restart leaves. A detached agent keeps
 * working, and what it says while nobody listens survives only in the
 * CLI's own session record inside the sandbox. Resuming the session
 * reads that record back and appends what the transcript never got,
 * exactly once, however many times the card is resumed after.
 */
test("resuming a session recovers the messages the agent sent while detached", async () => {
  const { project, stages: projectStages } = await setupProject("Session recovery");
  const feature = await createFeature(project.id, "Went dark");
  const profile = await fakeProfile("recovery-fake");

  const plant = async (status: "failed" | "running") => {
    const [run] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: feature.id,
        stageId: projectStages[0]!.id,
        agentProfileId: profile.id,
        prompt: status === "failed" ? "do the task" : "hello",
        status,
        cliSessionId: "ses_recovery1",
        executor: "server",
      })
      .returning();
    return run!;
  };
  // The run that went dark: it delivered one message, then the restart
  // detached it and the agent said two more things into the void.
  const interrupted = await plant("failed");
  await appendRunEvent(ctx, interrupted.id, {
    type: "message",
    role: "assistant",
    text: "Reading the code now.",
    raw: { type: "text", part: { id: "prt_1", messageID: "msg_1", type: "text", text: "Reading the code now." } },
  });
  // The resume the user's ping started.
  const resumed = await plant("running");

  const workdir = await mkdtemp(path.join(tmpdir(), "bento-recovery-"));
  const logPath = path.join(workdir, "export.json");
  await writeFile(
    logPath,
    JSON.stringify({
      info: { id: "ses_recovery1" },
      messages: [
        {
          info: { role: "assistant", id: "msg_1" },
          parts: [{ type: "text", text: "Reading the code now.", id: "prt_1", messageID: "msg_1" }],
        },
        {
          info: { role: "assistant", id: "msg_2" },
          parts: [{ type: "text", text: "The fix is in, committing.", id: "prt_2", messageID: "msg_2" }],
        },
        {
          info: { role: "assistant", id: "msg_3" },
          parts: [{ type: "text", text: "All done, the branch is ready.", id: "prt_3", messageID: "msg_3" }],
        },
      ],
    }),
  );
  // The real opencode parser and diff over a record read out of the
  // "sandbox" by the real driver; only the CLI invocation is replaced,
  // because the test machine cannot assume an opencode install.
  const adapter = {
    ...opencodeAdapter,
    sessionRecovery: {
      ...opencodeAdapter.sessionRecovery!,
      readLogCommand: () => ["cat", logPath],
    },
  };
  const handle: SandboxHandle = { externalId: "local-recovery", provider: "local-process", workdir };

  const recoverArgs = {
    handle,
    adapter,
    featureId: feature.id,
    runId: resumed.id,
    sessionId: "ses_recovery1",
    cwd: workdir,
  };
  await recoverMissedMessages(ctx, recoverArgs);

  const transcript = async () =>
    (
      await ctx.db
        .select({ payload: runEvents.payload })
        .from(runEvents)
        .where(eq(runEvents.runId, resumed.id))
        .orderBy(sql`seq`)
    ).map((r) => r.payload as { role?: string; text?: string });

  const first = await transcript();
  assert.equal(first.length, 3, "one explanation plus the two missed messages");
  assert.match(first[0]!.text ?? "", /kept working while Bento was disconnected/);
  assert.match(first[0]!.text ?? "", /2 messages/);
  assert.deepEqual(
    first.slice(1).map((r) => [r.role, r.text]),
    [
      ["assistant", "The fix is in, committing."],
      ["assistant", "All done, the branch is ready."],
    ],
    "only the undelivered messages arrive, in conversation order",
  );

  // Recovery is idempotent: the recovered rows carry the same native
  // ids delivered ones do, so running it again finds nothing missing.
  await recoverMissedMessages(ctx, recoverArgs);
  assert.equal((await transcript()).length, 3, "a second recovery adds nothing");

  // A session id the CLI never minted (an agent-controlled string with
  // shell metacharacters) recovers nothing rather than reaching a shell.
  await recoverMissedMessages(ctx, { ...recoverArgs, sessionId: 'ses"; rm -rf /tmp/x; "' });
  assert.equal((await transcript()).length, 3);
});

/**
 * Terminal states are written once. Two paths racing a run's ending
 * (a draining process's loop and its successor, or cancel against a
 * natural finish) used to both write, and the loser overwrote the
 * winner's status.
 */
test("a run already ended cannot be cancelled over its terminal state", async () => {
  const { project, stages: projectStages } = await setupProject("Terminal CAS");
  const feature = await createFeature(project.id, "Finished card");
  const profile = await fakeProfile("cas-fake");
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: projectStages[0]!.id,
      agentProfileId: profile.id,
      prompt: "already over",
      status: "succeeded",
      executor: "server",
    })
    .returning();

  await markCancelled(ctx, run!.id);

  const [after] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
  assert.equal(after!.status, "succeeded", "the finished status survived the late cancel");
});

/**
 * The stream's replay cursor. Every frame carries its seq as the SSE
 * id, and EventSource sends the last one it saw as Last-Event-ID when
 * it reconnects on its own. Honouring that header is what keeps a
 * deploy or a network drop from replaying every already-shown message
 * (the old behavior, which doubled the transcript) or losing the ones
 * fired while the socket was down.
 */
test("the run stream resumes from Last-Event-ID instead of replaying everything", async () => {
  const { project, stages: projectStages } = await setupProject("Stream resume");
  const feature = await createFeature(project.id, "Watched run");
  const profile = await fakeProfile("stream-fake");

  // Written directly: what is on trial is the stream's cursor, not
  // the agent.
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: projectStages[0]!.id,
      agentProfileId: profile.id,
      prompt: "already done",
      status: "succeeded",
      executor: "server",
    })
    .returning();
  for (let seq = 1; seq <= 5; seq++) {
    const payload = { type: "message", role: "assistant", text: `line ${seq}` };
    await ctx.db.insert(runEvents).values({ runId: run!.id, seq, type: "message", payload });
  }

  const replay = async (query = "", headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/runs/${run!.id}/events${query}`, { headers });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /event: done/, "a finished run's stream still closes");
    return [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  };

  assert.deepEqual(await replay(), [1, 2, 3, 4, 5], "a fresh stream replays the whole run");
  assert.deepEqual(await replay("?since=2"), [3, 4, 5], "the query cursor still works");
  assert.deepEqual(
    await replay("", { "Last-Event-ID": "3" }),
    [4, 5],
    "a reconnect resumes where the socket left off",
  );
  assert.deepEqual(await replay("?since=4", { "Last-Event-ID": "2" }), [5], "the cursor only moves forward");
});

/**
 * What a deploy does to runs, and what boot does about it. The dead
 * process held every server-executed run's stream, but the rows kept
 * saying "running": the card sat busy forever, its gate never
 * evaluated, its transcript cut off mid-sentence. Recovery closes
 * those, requeues the ones that never started, and delivers a message
 * parked during the outage once the card is free.
 */
test(
  "a restart closes interrupted runs, requeues waiting ones, and delivers parked messages",
  { timeout: 120_000 },
  async () => {
    const { project, stages: projectStages } = await setupProject("Restart recovery");
    const feature = await createFeature(project.id, "Interrupted card");
    const profile = await fakeProfile("restart-fake");
    const stage = projectStages[0]!;

    const plant = async (status: "running" | "starting" | "queued", executor: "server" | "runner") => {
      const [run] = await ctx.db
        .insert(agentRuns)
        .values({
          featureId: feature.id,
          stageId: stage.id,
          agentProfileId: profile.id,
          prompt: "half finished work",
          status,
          executor,
        })
        .returning();
      return run!;
    };
    const working = await plant("running", "server");
    const starting = await plant("starting", "server");
    const waiting = await plant("queued", "server");
    // On its own card: an active run anywhere on the feature would
    // (rightly) keep the parked message parked.
    const runnerCard = await createFeature(project.id, "Runner card");
    const [onARunner] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: runnerCard.id,
        stageId: stage.id,
        agentProfileId: profile.id,
        prompt: "half finished work",
        status: "running",
        executor: "runner",
      })
      .returning();

    // A reply that arrived while the deploy was happening.
    await ctx.db.insert(featureMessages).values({ featureId: feature.id, text: "is anyone there" });

    const closed: string[] = [];
    const offWorking = ctx.bus.onRunDone(working.id, (s) => closed.push(`${working.id}:${s}`));
    const offStarting = ctx.bus.onRunDone(starting.id, (s) => closed.push(`${starting.id}:${s}`));
    await recoverInterruptedRuns(ctx);
    offWorking();
    offStarting();

    const readRun = async (runId: string) =>
      json<{ status: string; error: string | null; endedAt: string | null }>(await app.request(`/api/runs/${runId}`));

    for (const orphan of [working, starting]) {
      const after = await readRun(orphan.id);
      assert.equal(after.status, "failed", "an interrupted run is closed, not left running forever");
      assert.match(after.error ?? "", /restart/);
      assert.ok(after.endedAt, "the close is timestamped");
      const transcript = await (await app.request(`/api/runs/${orphan.id}/transcript`)).text();
      assert.match(transcript, /restarted while this run was working/, "the transcript says why the run ended");
    }
    assert.ok(
      closed.includes(`${working.id}:failed`) && closed.includes(`${starting.id}:failed`),
      "a stream that reconnected mid-recovery still hears the close",
    );
    assert.equal((await readRun(onARunner.id)).status, "running", "a runner's run outlives the server and is left alone");

    // The waiting run went back on the queue (its job died with the
    // old process) and this test's own workers pick it up. Its finish
    // delivers the parked reply into a run of the same conversation.
    assert.equal(await waitForRun(waiting.id), "succeeded", "a run that never started is queued afresh");

    let resume: { id: string; prompt: string } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !resume) {
      const detail = await json<{ runs: { id: string; prompt: string }[] }>(
        await app.request(`/api/features/${feature.id}`),
      );
      resume = detail.runs.find((r) => r.prompt === "is anyone there");
      if (!resume) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(resume, "a message parked during the deploy becomes a run once the card is free");
    assert.equal(await waitForRun(resume.id), "succeeded");
    const transcript = await (await app.request(`/api/runs/${resume.id}/transcript`)).text();
    assert.match(transcript, /you> is anyone there/, "the reply opens the new run as the user's own line");
  },
);

/**
 * The other half of restart recovery: a run whose sandbox still holds
 * the working agent is followed, not failed. Boot attaches to the
 * surviving session, the transcript continues past where it stopped,
 * and the run ends the way it would have without the deploy.
 */
test("a restart reattaches to a run still working in its sandbox", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Reattach recovery");
  const feature = await createFeature(project.id, "Reattached card");
  const profile = await fakeProfile("reattach-fake");
  const stage = projectStages[0]!;

  const [sandbox] = await ctx.db
    .insert(sandboxes)
    .values({
      projectId: project.id,
      featureId: feature.id,
      provider: "sprite",
      externalId: `bento-${feature.id}`,
      status: "busy",
      workdir: "/workspace",
    })
    .returning();
  const [running] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "half finished work",
      status: "running",
      executor: "server",
      sandboxId: sandbox!.id,
      startedAt: new Date(Date.now() - 60_000),
    })
    .returning();
  // The first life already wrote events; the resumed half must continue
  // the counter, because (runId, seq) is unique and a restart at zero
  // would throw on its first insert.
  for (const seq of [1, 2]) {
    await ctx.db.insert(runEvents).values({
      runId: running!.id,
      seq,
      type: "message",
      payload: { type: "message", role: "assistant", text: `first life line ${seq}` },
    });
  }

  const attached: { externalId: string; argv0: string }[] = [];
  const fakeDriver = {
    provider: "sprite" as const,
    async provision(): Promise<never> {
      throw new Error("recovery must not provision");
    },
    exec(): AsyncIterable<never> {
      throw new Error("recovery must not exec");
    },
    async attach(handle: SandboxHandle, argv: string[]) {
      attached.push({ externalId: handle.externalId, argv0: argv[0] ?? "" });
      return (async function* () {
        yield {
          kind: "stdout" as const,
          data: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "resumed-1", total_cost_usd: 0.01, num_turns: 2 })}\n`,
        };
        yield { kind: "exit" as const, exitCode: 0 };
      })();
    },
    async destroy() {},
  };
  const previousDriver = ctx.driver;
  ctx.driver = fakeDriver as unknown as AppContext["driver"];
  try {
    await recoverInterruptedRuns(ctx);
    assert.equal(await waitForRun(running!.id), "succeeded", "the reattached run finishes as itself");

    const transcript = await (await app.request(`/api/runs/${running!.id}/transcript`)).text();
    assert.match(transcript, /reattached to the agent still working/, "the transcript says the run was followed");
    assert.doesNotMatch(transcript, /so the run ended here/, "no interrupted close on a run that survived");
    assert.equal(attached.length, 1, "recovery attached exactly once");
    assert.equal(attached[0]?.externalId, `bento-${feature.id}`, "the attach went to the run's own sandbox");
  } finally {
    ctx.driver = previousDriver;
  }
});

/**
 * Reattaching has honest limits: a sandbox that answers without the
 * session means the agent ended while nobody watched, and a run still
 * in "starting" may never have spawned its agent at all. Both keep the
 * interrupted close.
 */
test("a restart closes runs the sandbox cannot give back", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Reattach limits");
  const profile = await fakeProfile("reattach-limits-fake");
  const stage = projectStages[0]!;

  const plant = async (title: string, status: "running" | "starting") => {
    const feature = await createFeature(project.id, title);
    const [sandbox] = await ctx.db
      .insert(sandboxes)
      .values({
        projectId: project.id,
        featureId: feature.id,
        provider: "sprite",
        externalId: `bento-${feature.id}`,
        status: "busy",
        workdir: "/workspace",
      })
      .returning();
    const [run] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: feature.id,
        stageId: stage.id,
        agentProfileId: profile.id,
        prompt: "half finished work",
        status,
        executor: "server",
        sandboxId: sandbox!.id,
        startedAt: new Date(),
      })
      .returning();
    return run!;
  };
  const gone = await plant("Agent gone card", "running");
  const starting = await plant("Never started card", "starting");

  let asked = 0;
  const fakeDriver = {
    provider: "sprite" as const,
    async provision(): Promise<never> {
      throw new Error("recovery must not provision");
    },
    exec(): AsyncIterable<never> {
      throw new Error("recovery must not exec");
    },
    async attach() {
      asked += 1;
      return null; // the sandbox answers; the process is gone
    },
    async destroy() {},
  };
  const previousDriver = ctx.driver;
  ctx.driver = fakeDriver as unknown as AppContext["driver"];
  try {
    await recoverInterruptedRuns(ctx);
    for (const run of [gone, starting]) {
      assert.equal(await waitForRun(run.id), "failed");
      const detail = await json<{ error: string | null }>(await app.request(`/api/runs/${run.id}`));
      assert.match(detail.error ?? "", /restart/);
      const transcript = await (await app.request(`/api/runs/${run.id}/transcript`)).text();
      assert.match(transcript, /restarted while this run was working/, "the close still explains itself");
    }
    assert.equal(asked, 1, "a run that had not reached running is never attached");
  } finally {
    ctx.driver = previousDriver;
  }
});

/**
 * A resumed live conversation is still the same conversation: the
 * opening prompt is not replayed (the agent heard it in its first
 * life), and a message sent after the restart reaches the reconnected
 * process's stdin instead of parking.
 */
test("a resumed live conversation hears new messages and never repeats the prompt", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Reattach live");
  const feature = await createFeature(project.id, "Live resumed card");
  const profile = await fakeProfile("reattach-live-fake");
  const stage = projectStages[0]!;

  const [sandbox] = await ctx.db
    .insert(sandboxes)
    .values({
      projectId: project.id,
      featureId: feature.id,
      provider: "sprite",
      externalId: `bento-${feature.id}`,
      status: "busy",
      workdir: "/workspace",
    })
    .returning();
  const [running] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      // LIVE selects the fake adapter's stdin conversation mode.
      prompt: "LIVE half finished work",
      status: "running",
      executor: "server",
      sandboxId: sandbox!.id,
      startedAt: new Date(Date.now() - 60_000),
    })
    .returning();

  const heard: string[] = [];
  const fakeDriver = {
    provider: "sprite" as const,
    supportsStdin: true,
    async provision(): Promise<never> {
      throw new Error("recovery must not provision");
    },
    exec(): AsyncIterable<never> {
      throw new Error("recovery must not exec");
    },
    async attach(_handle: SandboxHandle, _argv: string[], opts?: { stdin?: AsyncIterable<string> }) {
      const stdin = opts?.stdin;
      return (async function* () {
        // The reconnected agent waits for the conversation, exactly
        // like a live process whose stdin pipe survived the deploy.
        if (stdin) {
          for await (const line of stdin) {
            heard.push(line.trim());
            break;
          }
        }
        yield {
          kind: "stdout" as const,
          data: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "fake-live-1", total_cost_usd: 0, num_turns: 1 })}\n`,
        };
        yield { kind: "exit" as const, exitCode: 0 };
      })();
    },
    async destroy() {},
  };
  const previousDriver = ctx.driver;
  ctx.driver = fakeDriver as unknown as AppContext["driver"];
  try {
    await recoverInterruptedRuns(ctx);
    // The live session registers as part of the resume; a message sent
    // before that would (correctly) park instead of going live.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !ctx.liveInputs.has(running!.id)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ctx.liveInputs.has(running!.id), "the resumed run accepts live messages again");

    const reply = await json<{ queued: boolean; live?: boolean }>(
      await app.request(`/api/features/${feature.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a follow-up mid resume" }),
      }),
    );
    assert.equal(reply.live, true, "the message went to the reconnected agent, not the parking slot");

    assert.equal(await waitForRun(running!.id), "succeeded");
    assert.deepEqual(heard, ["a follow-up mid resume"], "stdin carried the follow-up and nothing else");
    const transcript = await (await app.request(`/api/runs/${running!.id}/transcript`)).text();
    assert.match(transcript, /you> a follow-up mid resume/, "the follow-up is the user's own transcript line");
  } finally {
    ctx.driver = previousDriver;
  }
});

/**
 * The session id is the conversation's only key, and it used to reach
 * the run row only at the very end: a run that died without a result
 * event took the whole conversation with it. It is known the moment
 * the CLI announces itself, so that is when it is written.
 */
test("a run records its session id at init, not only at the end", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Early session id");
  const feature = await createFeature(project.id, "Session id card");
  const profile = await fakeProfile("early-session-fake");
  const stage = projectStages[0]!;

  const [running] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      // SLOW keeps the run alive long enough to observe it mid-flight.
      prompt: "SLOW work",
      status: "queued",
      executor: "server",
    })
    .returning();
  await ctx.boss.send("run.execute", { runId: running!.id });

  const deadline = Date.now() + 30_000;
  let seen: { status: string; cliSessionId: string | null } | null = null;
  while (Date.now() < deadline) {
    seen = await json<{ status: string; cliSessionId: string | null }>(
      await app.request(`/api/runs/${running!.id}`),
    );
    if (seen.cliSessionId) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(seen?.cliSessionId, "fake-session-1", "the init event's session id reaches the run row");
  assert.ok(
    seen && !TERMINAL_STATUSES.includes(seen.status),
    "and it is there while the run is still working, when a crash could still lose it",
  );
  // No need to sit out the slow run once the point is proven.
  await app.request(`/api/runs/${running!.id}/cancel`, { method: "POST" });
  await waitForRun(running!.id);
});

/**
 * Two messages sent in the same instant used to both read the same
 * queuedPrompt and the second write erased the first, with both
 * senders told "queued". The append now happens in SQL, so the race
 * has no window.
 */
test("two messages racing into the parking slot both survive", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Message race");
  const feature = await createFeature(project.id, "Race card");
  const profile = await fakeProfile("race-fake");
  const stage = projectStages[0]!;

  const [running] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "SLOW work",
      status: "queued",
      executor: "server",
    })
    .returning();
  await ctx.boss.send("run.execute", { runId: running!.id });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await json<{ status: string }>(await app.request(`/api/runs/${running!.id}`));
    if (run.status === "running") break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const send = (text: string) =>
    app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  const [first, second] = await Promise.all([send("wait"), send("actually stop")]);
  assert.equal((await json<{ queued: boolean }>(first!)).queued, true);
  assert.equal((await json<{ queued: boolean }>(second!)).queued, true);

  const rows = await ctx.db.select().from(featureMessages).where(eq(featureMessages.featureId, feature.id));
  const parked = rows.map((m) => m.text).sort();
  assert.deepEqual(parked, ["actually stop", "wait"], "both racing messages are their own rows");

  await app.request(`/api/runs/${running!.id}/cancel`, { method: "POST" });
  await waitForRun(running!.id);
});

/**
 * A follow-up continues the card's work, never the judging of it. The
 * newest run on a gated card is often the completion judge, and
 * inheriting its profile and session had the reviewer answering the
 * user inside the judging session.
 */
test("a follow-up resumes the work agent's session, not the judge's", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Judge hijack");
  const feature = await createFeature(project.id, "Judged card");
  const worker = await fakeProfile("judged-worker");
  const judge = await fakeProfile("judged-judge");
  const stage = projectStages[0]!;

  const plant = async (values: {
    profileId: string;
    prompt: string;
    kind?: "task" | "judge";
    cliSessionId: string;
    queuedAt: Date;
  }) => {
    const [run] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: feature.id,
        stageId: stage.id,
        agentProfileId: values.profileId,
        prompt: values.prompt,
        kind: values.kind ?? "task",
        status: "succeeded",
        executor: "server",
        cliSessionId: values.cliSessionId,
        queuedAt: values.queuedAt,
      })
      .returning();
    return run!;
  };
  await plant({
    profileId: worker.id,
    prompt: "build the thing",
    cliSessionId: "work-sess",
    queuedAt: new Date(Date.now() - 60_000),
  });
  await plant({
    profileId: judge.id,
    prompt: `${JUDGE_PROMPT_PREFIX} for the stage "Build". Decide whether it is complete.`,
    kind: "judge",
    cliSessionId: "judge-sess",
    queuedAt: new Date(),
  });

  const reply = await json<{ queued: boolean; run?: { id: string } }>(
    await app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "also handle the empty case" }),
    }),
  );
  assert.ok(reply.run, "an idle card answers a message with a new run");
  const [resumed] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, reply.run!.id));
  assert.equal(resumed?.agentProfileId, worker.id, "the worker answers, not the judge");
  assert.equal(resumed?.cliSessionId, "work-sess", "inside the work conversation, not the judging one");
  await waitForRun(reply.run!.id);
});

/**
 * After a send-back the last work run is still the agent that just ran
 * (QA). A follow-up that inherited its profile and session kept talking
 * to QA on a card that now sat in Implementation.
 */
test("a follow-up after a send-back talks to the current stage's agent", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Send-back follow-up");
  const feature = await createFeature(project.id, "Sent back card");
  const implementer = await fakeProfile("followup-impl");
  const qa = await fakeProfile("followup-qa");
  const impl = projectStages[0]!;
  const quality = projectStages[2]!;

  await patchStage(impl.id, { defaultAgentProfileId: implementer.id });
  await ctx.db
    .update(features)
    .set({ currentStageId: impl.id, status: "active", updatedAt: new Date() })
    .where(eq(features.id, feature.id));
  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: quality.id,
    agentProfileId: qa.id,
    prompt: "verify the work",
    status: "succeeded",
    executor: "server",
    cliSessionId: "qa-sess",
  });

  const reply = await json<{ queued: boolean; run?: { id: string } }>(
    await app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fix the empty case" }),
    }),
  );
  assert.ok(reply.run, "an idle card answers a message with a new run");
  const [resumed] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, reply.run!.id));
  assert.equal(resumed?.agentProfileId, implementer.id, "the Implementation agent answers, not QA");
  assert.equal(resumed?.stageId, impl.id);
  assert.equal(resumed?.cliSessionId, null, "a different agent starts a fresh session");
  await waitForRun(reply.run!.id);
});

/**
 * A message handed to a run that never confirmed a turn is not
 * delivered, whatever the transcript shows: the run's ending puts it
 * back and the next run carries it. This is the loss the old
 * queued_prompt slot could not see, a message acknowledged, written to
 * a live channel, and then gone with the process that never read it.
 */
test("a message the agent never confirmed is redelivered to the next run", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Unread redelivery");
  const feature = await createFeature(project.id, "Unread card");
  const profile = await fakeProfile("unread-fake");
  const stage = projectStages[0]!;

  const [running] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "half finished work",
      status: "running",
      executor: "server",
    })
    .returning();
  // Sent to that run, never confirmed by a result event.
  const [message] = await ctx.db
    .insert(featureMessages)
    .values({ featureId: feature.id, text: "fix the header", status: "sent", runId: running!.id, sentAt: new Date() })
    .returning();

  // The run ends without ever reaching a result: a cancel, here.
  await markCancelled(ctx, running!.id);

  let resume: { id: string; prompt: string } | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !resume) {
    const detail = await json<{ runs: { id: string; prompt: string }[] }>(
      await app.request(`/api/features/${feature.id}`),
    );
    resume = detail.runs.find((r) => r.prompt === "fix the header");
    if (!resume) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(resume, "the unread message becomes the next run's prompt");
  assert.equal(await waitForRun(resume.id), "succeeded");

  const [after] = await ctx.db.select().from(featureMessages).where(eq(featureMessages.id, message!.id));
  assert.equal(after?.status, "delivered", "the redelivering run's result confirms it");
  assert.equal(after?.runId, resume.id, "and the message records which run answered");
});

/**
 * A message that became a run's prompt is finished, whatever becomes
 * of the run.
 *
 * Treating it as still in flight was an endless loop: a run that ends
 * without a result (no credentials, a sandbox that will not provision,
 * the run limit) requeued its own prompt, the terminal path handed it
 * straight to another run, and that one failed identically. A card
 * with a persistent failure spawned runs until somebody noticed. The
 * run row carries the prompt, so a failure is something to read and
 * resume, not a message to deliver again.
 */
test("a run's own prompt is never handed to another run", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Prompt redelivery");
  const feature = await createFeature(project.id, "Looping card");
  const profile = await fakeProfile("loop-fake");
  const stage = projectStages[0]!;

  // Executor "runner" so the delivered run stays queued for this test
  // to end deliberately, rather than being executed out from under it.
  const [previous] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "earlier work",
      status: "succeeded",
      executor: "runner",
      cliSessionId: "loop-sess",
    })
    .returning();
  const [message] = await ctx.db
    .insert(featureMessages)
    .values({ featureId: feature.id, text: "retry the header" })
    .returning();

  await deliverQueuedMessage(ctx, previous!.id);

  const carrying = async () =>
    ctx.db.select().from(agentRuns).where(eq(agentRuns.prompt, "retry the header"));
  const first = await carrying();
  assert.equal(first.length, 1, "the message became exactly one run");
  const [afterDelivery] = await ctx.db
    .select()
    .from(featureMessages)
    .where(eq(featureMessages.id, message!.id));
  assert.equal(afterDelivery?.status, "delivered", "handing a message to a run as its prompt delivers it");
  assert.equal(afterDelivery?.runId, first[0]!.id);

  // The run ends without ever reaching a result, which is what every
  // pre-agent failure looks like.
  await markCancelled(ctx, first[0]!.id);

  assert.equal(
    (await carrying()).length,
    1,
    "the ended run's prompt is not delivered again, so no second run is spawned",
  );
});

/**
 * A parked message always has an owner. The old slot's only delivery
 * chance was a run's terminal path; a message that missed it (a race,
 * a crash) sat invisible forever. Boot now sweeps for stranded
 * messages and delivers them from the card's newest run.
 */
test("boot recovery delivers a message stranded with no active run", { timeout: 60_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Stranded delivery");
  const feature = await createFeature(project.id, "Stranded card");
  const profile = await fakeProfile("stranded-fake");
  const stage = projectStages[0]!;

  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: profile.id,
    prompt: "finished long ago",
    status: "succeeded",
    executor: "server",
    cliSessionId: "stranded-sess",
  });
  await ctx.db.insert(featureMessages).values({ featureId: feature.id, text: "are you still there" });

  await recoverInterruptedRuns(ctx);

  let resume: { id: string; prompt: string; cliSessionId?: string | null } | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !resume) {
    const detail = await json<{ runs: { id: string; prompt: string; cliSessionId?: string | null }[] }>(
      await app.request(`/api/features/${feature.id}`),
    );
    resume = detail.runs.find((r) => r.prompt === "are you still there");
    if (!resume) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(resume, "the sweep found the stranded message an owner");
  assert.equal(await waitForRun(resume.id), "succeeded");
});

/**
 * "Run claude-code" on a stage whose assigned agent IS a claude-code
 * agent means that agent, with its name and skill, not a nameless
 * quick-<cli> stand-in. The stand-in is only for unassigned stages.
 */
test("a quick run uses the stage's assigned agent when the tool matches", async () => {
  const { project, stages: projectStages } = await setupProject("Quick prefers assigned");
  const feature = await createFeature(project.id, "Named runs");
  const assigned = await json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Senior Product Manager", cli: "fake", model: "fake-1" }),
    }),
  );
  await patchStage(projectStages[0]!.id, { defaultAgentProfileId: assigned.id });
  // Keep the auto-started run out of the way: runner executor leaves it
  // queued, and we cancel it so quick-run's busy guard lets us through.
  await ctx.db.execute(sql`update projects set executor = 'runner' where id = ${project.id}`);
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const { runs: auto } = await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`));
  for (const r of auto) await app.request(`/api/runs/${r.id}/cancel`, { method: "POST" });

  const quick = await json<{ agentProfileId: string; id: string }>(
    await app.request(`/api/features/${feature.id}/quick-run?cli=fake`, { method: "POST" }),
  );
  assert.equal(quick.agentProfileId, assigned.id, "the assigned agent runs, not quick-fake");
  await app.request(`/api/runs/${quick.id}/cancel`, { method: "POST" });
});

/**
 * The skill is the user's lever on agent output: it rides into every
 * stage prompt the agent runs, which is how a team defines what the
 * stage write-up must contain. And the transcript speaks the agent's
 * name, because "assistant" is a wire role, not a colleague.
 */
test("an agent's skill shapes its prompt, and the log speaks its name", async () => {
  const { project } = await setupProject("Skilled");
  await ctx.db.execute(sql`update projects set executor = 'runner' where id = ${project.id}`);
  const feature = await createFeature(project.id, "Skilled card");

  const profile = await json<{ id: string; skill: string | null }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Investigator",
        cli: "fake",
        model: "fake-1",
        skill: "Your write-up must have sections: Problem, Evidence, Recommendation.",
      }),
    }),
  );
  assert.match(profile.skill ?? "", /Problem, Evidence/);

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const created = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const claim = (await (await post("/api/runner/claim", { runnerId: "skill-laptop" })).json()) as {
    run: { id: string } | null;
    stagePrompt?: string;
  };
  assert.equal(claim.run?.id, created.id);
  assert.match(claim.stagePrompt ?? "", /You are "Investigator"/, "the prompt names the agent");
  assert.match(claim.stagePrompt ?? "", /Problem, Evidence, Recommendation/, "the skill rides into the prompt");

  await post(`/api/runner/runs/${created.id}/events`, {
    runnerId: "skill-laptop",
    events: [
      { type: "init", sessionId: "skill-session" },
      { type: "message", role: "assistant", text: "Reading the code." },
    ],
  });
  const transcript = await (await app.request(`/api/runs/${created.id}/transcript`)).text();
  assert.match(transcript, /Investigator> Reading the code\./, "the log speaks the agent's name");
  assert.doesNotMatch(transcript, /assistant>/, "the wire role never reaches a person");

  // A skill can be cleared, and nothing else moves when it is.
  const cleared = await json<{ skill: string | null; model: string }>(
    await app.request(`/api/profiles/${profile.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: null }),
    }),
  );
  assert.equal(cleared.skill, null);
  assert.equal(cleared.model, "fake-1");

  // Leave nothing claimed or queued for later tests.
  await post(`/api/runner/runs/${created.id}/complete`, { runnerId: "skill-laptop", ok: true });
});

/**
 * Runs a body with these process.env values in place, null meaning
 * absent, and restores what was there afterwards. The credential tests
 * below turn on what is *not* set as much as on what is, so inheriting
 * a developer's own `ANTHROPIC_API_KEY` would quietly invert a result.
 */
async function withEnv(values: Record<string, string | null>, body: () => Promise<void>) {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    await body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * A subscription login token satisfies claude-code without an API key.
 * This is the path a containerized server relies on: it cannot reach
 * the machine's keychain, so the token from `claude setup-token`
 * arrives through the environment instead.
 */
test("a claude login token counts as a credential", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: null }, async () => {
    const { env, missing } = await resolveAgentEnv(ctx, null, claudeCodeAdapter);
    assert.deepEqual(missing, [], "a login token means nothing is missing");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-test", "and the token reaches the sandbox env");
  });
});

/**
 * The two Anthropic credentials are alternatives, and Claude Code picks
 * the key when it is handed both, so a stale key beside a good token
 * failed the run with "Invalid API key" while every check here passed.
 * Only one of them may reach the sandbox.
 */
test("a login token displaces the API key rather than joining it", async () => {
  await withEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", ANTHROPIC_API_KEY: "sk-ant-api-stale", ANTHROPIC_BASE_URL: null },
    async () => {
      const { env, missing } = await resolveAgentEnv(ctx, null, claudeCodeAdapter);
      assert.deepEqual(missing, []);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-test", "the token is what the agent gets");
      assert.equal(env.ANTHROPIC_API_KEY, undefined, "and the key it supersedes is withheld");
    },
  );
});

/**
 * The exception, and the reason this is not a plain preference: a login
 * token is only valid at Anthropic's own API. Once a base URL points
 * the tool at OpenRouter or a gateway, the key is the only credential
 * that can work, so the token gives way instead.
 */
test("a redirected endpoint reverses which Anthropic credential wins", async () => {
  await withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      ANTHROPIC_API_KEY: "sk-or-routed",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
    },
    async () => {
      const { env, missing } = await resolveAgentEnv(ctx, null, claudeCodeAdapter);
      assert.deepEqual(missing, []);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-or-routed", "the key is what reaches a redirected tool");
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "and the token, useless there, is withheld");
    },
  );
});

/**
 * With the endpoint redirected and only a token stored, the run stops
 * here naming the key. Starting it would spend a sandbox to arrive at
 * an authentication error that says nothing about what to add.
 */
test("a redirected endpoint with only a token is missing the key", async () => {
  await withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
    },
    async () => {
      const { missing } = await resolveAgentEnv(ctx, null, claudeCodeAdapter);
      assert.deepEqual(missing, ["ANTHROPIC_API_KEY"], "and the message names what to add");
    },
  );
});

/**
 * Dragging a card between lanes. Forward keeps advance's meaning (the
 * stage's agent starts), backward keeps send-back's (verdicts are
 * discarded, the previous agent stops, the destination waits), and
 * neither records an approval.
 */
test("a card can be moved to any stage, and the move keeps its direction's meaning", { timeout: 120_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Dragging");
  const feature = await createFeature(project.id, "Drag me");
  const profile = await fakeProfile("dragging-fake");
  const move = (stageId: string | null) =>
    app.request(`/api/features/${feature.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId }),
    });

  // Forward from the backlog, skipping two stages: one move, one event.
  const third = projectStages[2]!;
  await patchStage(third.id, { defaultAgentProfileId: profile.id });
  const jumped = await json<{ currentStageId: string; status: string }>(await move(third.id));
  assert.equal(jumped.currentStageId, third.id);
  assert.equal(jumped.status, "active");

  // Forward into an agent stage started that agent, like advance does.
  const ranAfter = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { runs } = await json<{ runs: { status: string; stageId: string }[] }>(
        await app.request(`/api/features/${feature.id}`),
      );
      const run = runs.find((r) => r.stageId === third.id);
      if (run && ["succeeded", "failed"].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  })();
  assert.equal(ranAfter?.status, "succeeded", "a forward move starts the stage's agent");

  // No approval was recorded: a drag is not a verdict.
  const history = await json<{ kind: string; trigger: string }[]>(
    await app.request(`/api/features/${feature.id}/history`),
  );
  assert.ok(
    history.some((e) => e.kind === "stage_moved" && e.trigger === "manual"),
    "the move is in the history",
  );

  // Backward two stages: verdicts of the stage being left are gone,
  // and the destination agent does not start, even when one is assigned.
  const first = projectStages[0]!;
  await patchStage(first.id, { defaultAgentProfileId: profile.id });
  const idsBeforeBack = (
    await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`))
  ).runs.map((r) => r.id);
  const back = await json<{ currentStageId: string }>(await move(first.id));
  assert.equal(back.currentStageId, first.id);
  const gate = await json<{ checks: unknown[] }>(await app.request(`/api/features/${feature.id}/gate`));
  assert.equal(gate.checks.length, 0, "a backward move leaves no stale verdicts behind");
  await new Promise((r) => setTimeout(r, 1500));
  const afterBack = await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`));
  assert.deepEqual(
    afterBack.runs.map((r) => r.id),
    idsBeforeBack,
    "a backward move does not start the destination agent",
  );

  // To the backlog, and a stage from another pipeline is refused.
  const toBacklog = await json<{ currentStageId: string | null }>(await move(null));
  assert.equal(toBacklog.currentStageId, null);
  const foreign = await move("00000000-0000-0000-0000-000000000000");
  assert.equal(foreign.status, 400, "a stage outside this pipeline is refused");
});

/**
 * Send-back used to leave the previous stage's agent in place: the card
 * moved, but the next run (and any follow-up) still belonged to QA.
 * The previous agent must stop; the destination does not start on its
 * own, because the person has not yet said why the card came back.
 */
test("sending a card back stops the current agent and starts nothing", { timeout: 60_000 }, async () => {
  const { project, stages } = await setupProject("Send-back stop");
  const reviewer = await fakeProfile("sendback-stop-review");
  const qa = await fakeProfile("sendback-stop-qa");
  const review = stages[1]!;
  const quality = stages[2]!;
  await patchStage(review.id, { defaultAgentProfileId: reviewer.id });
  await patchStage(quality.id, { defaultAgentProfileId: qa.id });

  for (const status of ["queued", "running"] as const) {
    const feature = await createFeature(project.id, `Rework me ${status}`);
    await ctx.db
      .update(features)
      .set({ currentStageId: quality.id, status: "active", updatedAt: new Date() })
      .where(eq(features.id, feature.id));
    const [live] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: feature.id,
        stageId: quality.id,
        agentProfileId: qa.id,
        prompt: "verify the work",
        status,
        executor: "runner",
      })
      .returning({ id: agentRuns.id });

    assert.equal((await app.request(`/api/features/${feature.id}/back`, { method: "POST" })).status, 200);
    const detail = await json<{
      currentStageId: string;
      runs: { id: string; status: string; stageId: string; agentProfileId: string }[];
    }>(await app.request(`/api/features/${feature.id}`));
    assert.equal(detail.currentStageId, review.id);
    const stopped = detail.runs.find((r) => r.id === live!.id);
    assert.equal(stopped?.status, "cancelled", `a ${status} agent on the previous stage is stopped`);
    assert.equal(detail.runs.length, 1, "send-back starts no destination run of its own");
  }
});

/**
 * An automatic destination whose previous visit already succeeded would
 * walk the card forward again the moment anything evaluated it. Send-back
 * must not start that stage's agent and must not ask the gate.
 */
test("sending a card back onto an automatic stage does not bounce it forward", { timeout: 30_000 }, async () => {
  const { project, stages } = await setupProject("Send-back bounce");
  const reviewer = await fakeProfile("sendback-bounce-review");
  const qa = await fakeProfile("sendback-bounce-qa");
  const review = stages[1]!;
  const quality = stages[2]!;
  await patchStage(review.id, {
    defaultAgentProfileId: reviewer.id,
    gateType: "auto",
    gateCriteria: [],
  });
  await patchStage(quality.id, { defaultAgentProfileId: qa.id });

  const feature = await createFeature(project.id, "Bounce me");
  await ctx.db
    .update(features)
    .set({ currentStageId: quality.id, status: "active", updatedAt: new Date() })
    .where(eq(features.id, feature.id));
  await ctx.db.insert(agentRuns).values([
    {
      featureId: feature.id,
      stageId: review.id,
      agentProfileId: reviewer.id,
      prompt: "earlier review",
      status: "succeeded",
      executor: "runner",
    },
    {
      featureId: feature.id,
      stageId: quality.id,
      agentProfileId: qa.id,
      prompt: "verify the work",
      status: "succeeded",
      executor: "runner",
    },
  ]);

  assert.equal((await app.request(`/api/features/${feature.id}/back`, { method: "POST" })).status, 200);
  const idsAtSendBack = (
    await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`))
  ).runs.map((r) => r.id);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const detail = await json<{ currentStageId: string; runs: { id: string }[] }>(
      await app.request(`/api/features/${feature.id}`),
    );
    assert.equal(detail.currentStageId, review.id, "an automatic destination must not walk the card forward again");
    assert.deepEqual(
      detail.runs.map((r) => r.id).sort(),
      idsAtSendBack.slice().sort(),
      "send-back must not start a run that would then pass the gate",
    );
    await new Promise((r) => setTimeout(r, 250));
  }
});

/**
 * A message parked on the previous stage's agent survives send-back and
 * is carried by the destination agent once the person starts that
 * conversation, not by an automatic follow-up of the stopped run.
 */
test("parked messages survive send-back and reach the new agent", { timeout: 60_000 }, async () => {
  const { project, stages } = await setupProject("Send-back parked");
  const reviewer = await fakeProfile("sendback-parked-review");
  const qa = await fakeProfile("sendback-parked-qa");
  const review = stages[1]!;
  const quality = stages[2]!;
  await patchStage(review.id, { defaultAgentProfileId: reviewer.id });
  await patchStage(quality.id, { defaultAgentProfileId: qa.id });

  const feature = await createFeature(project.id, "Parked after send-back");
  await ctx.db
    .update(features)
    .set({ currentStageId: quality.id, status: "active", updatedAt: new Date() })
    .where(eq(features.id, feature.id));
  const [live] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: quality.id,
      agentProfileId: qa.id,
      prompt: "verify the work",
      status: "running",
      executor: "runner",
      cliSessionId: "qa-sess",
    })
    .returning({ id: agentRuns.id });
  await ctx.db.insert(featureMessages).values({
    featureId: feature.id,
    text: "the tests fail on empty input",
  });

  assert.equal((await app.request(`/api/features/${feature.id}/back`, { method: "POST" })).status, 200);

  const parked = await ctx.db.select().from(featureMessages).where(eq(featureMessages.featureId, feature.id));
  assert.equal(parked.length, 1);
  assert.equal(parked[0]?.status, "queued", "send-back leaves the parked message for the next conversation");

  // The stopped run's terminal path must not auto-start the destination
  // with that parked text: that would skip the person saying why.
  await deliverQueuedMessage(ctx, live!.id);
  const afterDeliver = await json<{
    currentStageId: string;
    runs: { id: string; status: string; agentProfileId: string; stageId: string }[];
  }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(afterDeliver.runs.find((r) => r.id === live!.id)?.status, "cancelled");
  assert.equal(afterDeliver.runs.length, 1, "ending the previous run does not start the destination agent");
  assert.equal(afterDeliver.currentStageId, review.id);

  const reply = await json<{ queued: boolean; run?: { id: string; prompt: string } }>(
    await app.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "add a null check like the review asked" }),
    }),
  );
  assert.ok(reply.run, "the person's next message starts the destination conversation");
  const [started] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, reply.run!.id));
  assert.equal(started?.agentProfileId, reviewer.id, "the Code review agent answers, not QA");
  assert.equal(started?.stageId, review.id);
  assert.equal(started?.cliSessionId, null, "a different agent starts a fresh session");
  assert.match(started?.prompt ?? "", /the tests fail on empty input/);
  assert.match(started?.prompt ?? "", /add a null check like the review asked/);
  // Runner-executed so the prompt could be read without waiting on a
  // worker. Cancel it so later tests that claim from the shared runner
  // pool do not pick this run up.
  await markCancelled(ctx, started!.id);
});

/**
 * The right edge of the board. A card past the last stage is done, and
 * done used to be a trap: it kept the stage it finished in, so every
 * client offered the stage actions and every one of them refused, while
 * the run endpoints, which only checked "has a stage", would happily
 * start an agent on it. And there was no way back at all, so one
 * mis-click on the final approve was permanent.
 */
test("a done card refuses new work and can be reopened", { timeout: 90_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Right edge");
  const feature = await createFeature(project.id, "Finish me");
  const profile = await fakeProfile("right-edge-fake");

  // Walk it off the end of the pipeline.
  for (let i = 0; i <= projectStages.length; i++) {
    await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  }
  const done = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${feature.id}`),
  );
  assert.equal(done.status, "done");
  const lastStage = projectStages[projectStages.length - 1]!;
  assert.equal(done.currentStageId, lastStage.id, "a done card keeps the stage it finished in");
  const plainDone = await (await app.request(`/api/features/${feature.id}/history/plain`)).text();
  assert.match(plainDone, /finished /, "clearing the last stage reads as finishing it");

  // Nothing moves it except reopening, and nothing runs on it.
  for (const path of ["advance", "approve", "reject", "finish"]) {
    const res = await app.request(`/api/features/${feature.id}/${path}`, { method: "POST" });
    assert.equal(res.status, 409, `${path} must refuse a done card`);
  }
  const dragged = await app.request(`/api/features/${feature.id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId: projectStages[0]!.id }),
  });
  assert.equal(dragged.status, 409, "move must refuse a done card too");
  const started = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
  });
  assert.equal(started.status, 409, "an agent must not start on a done card");
  assert.match(((await started.json()) as { error: string }).error, /reopen it first/);
  const quick = await app.request(`/api/features/${feature.id}/quick-run?cli=fake`, { method: "POST" });
  assert.equal(quick.status, 409, "quick-run is the same door");

  // Back is the way out: the card returns to the stage it finished in.
  const reopened = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${feature.id}/back`, { method: "POST" }),
  );
  assert.equal(reopened.status, "active");
  assert.equal(reopened.currentStageId, lastStage.id, "reopening returns to the last stage, not before it");

  // Reopening starts nothing on its own: whoever reopened it decides.
  const runs = await json<{ runs: unknown[] }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(runs.runs.length, 0, "no run starts just because a card was reopened");

  // And the reopened card is an ordinary card again.
  const again = await app.request(`/api/features/${feature.id}/approve`, { method: "POST" });
  assert.equal(again.status, 200, "the reopened stage can be approved");
  const finished = await json<{ status: string }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(finished.status, "done");
});

/**
 * Finishing early, which is what dropping a card on the board's Done
 * lane does. Plenty of work does not want the rest of the pipeline: a
 * one-line copy fix needs no design review, and a card someone finished
 * by hand wants recording rather than running. The card keeps the stage
 * it was in, so this stays one kind of done rather than two.
 */
test("a card can be marked done from any stage, and reopens into the one it left", { timeout: 90_000 }, async () => {
  const { project, stages: projectStages } = await setupProject("Early finish");
  const feature = await createFeature(project.id, "Finish early");
  const profile = await fakeProfile("early-finish-fake");
  const second = projectStages[1]!;

  // Into the second stage, then done from there with four stages left.
  await app.request(`/api/features/${feature.id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId: second.id }),
  });
  const done = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${feature.id}/finish`, { method: "POST" }),
  );
  assert.equal(done.status, "done");
  assert.equal(done.currentStageId, second.id, "the card keeps the stage it was finished from");

  // Both halves are in the history: it left the stage, and its status
  // changed. The stage's gate is asked when the card arrives there, and
  // that evaluation has to leave a finished card alone.
  await new Promise((r) => setTimeout(r, 1500));
  const settled = await json<{ status: string }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(settled.status, "done", "the stage's gate must not un-finish the card behind you");
  const history = await json<
    { kind: string; trigger: string; fromStageId: string | null; toStageId: string | null; toStatus: string | null }[]
  >(await app.request(`/api/features/${feature.id}/history`));
  const left = history.filter((e) => e.kind === "stage_moved" && e.toStageId === null);
  assert.equal(left.length, 1, "finishing records the move off the stage once");
  assert.equal(left[0]?.fromStageId, second.id);
  assert.equal(left[0]?.trigger, "manual");
  assert.ok(
    history.some((e) => e.kind === "status_changed" && e.toStatus === "done" && e.trigger === "manual"),
    "and the status change, so the history does not read as a trip to the backlog",
  );
  const plain = await (await app.request(`/api/features/${feature.id}/history/plain`)).text();
  assert.match(
    plain,
    new RegExp(`done from ${projectStages[1]!.name.replace("/", "\\/")}`),
    "the plain history says the stage was skipped, not finished",
  );

  // It is a done card in every other respect.
  const started = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
  });
  assert.equal(started.status, 409, "an agent must not start on a card marked done early");
  const twice = await app.request(`/api/features/${feature.id}/finish`, { method: "POST" });
  assert.equal(twice.status, 409, "finishing it again is refused rather than logged twice");

  // Reopening returns it to the stage it was finished from.
  const reopened = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${feature.id}/back`, { method: "POST" }),
  );
  assert.equal(reopened.status, "active");
  assert.equal(reopened.currentStageId, second.id, "not the last stage, and not the one before it");

  /**
   * A card still in the backlog can be finished too, and it is the one
   * with no stage to come back to. It reopens into the backlog rather
   * than being frozen done, which is the trap reopening exists to
   * prevent.
   */
  const never = await createFeature(project.id, "Never started");
  const skipped = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${never.id}/finish`, { method: "POST" }),
  );
  assert.equal(skipped.status, "done");
  assert.equal(skipped.currentStageId, null);
  const backToBacklog = await json<{ status: string; currentStageId: string | null }>(
    await app.request(`/api/features/${never.id}/back`, { method: "POST" }),
  );
  assert.equal(backToBacklog.status, "active");
  assert.equal(backToBacklog.currentStageId, null, "a card finished from the backlog reopens there");
});

test("full feature lifecycle with fake agent", { timeout: 90_000 }, async () => {
  // Project with default pipeline
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fixture", localPath: repoDir }),
    }),
  );
  await unassignStages(project.id);
  const pipeline = await json<{ stages: { id: string; name: string; position: number }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.equal(pipeline.stages.length, 6);

  // Feature enters the first stage
  const feature = await json<{ id: string }>(
    await app.request("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: "Test feature", description: "Do a thing." }),
    }),
  );
  const advanced = await json<{ currentStageId: string; status: string }>(
    await app.request(`/api/features/${feature.id}/advance`, { method: "POST" }),
  );
  assert.equal(advanced.status, "active");
  assert.equal(advanced.currentStageId, pipeline.stages[0]!.id);

  // Fake agent profile + run
  const profile = await json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", cli: "fake", model: "fake-1" }),
    }),
  );
  const created = await json<{ id: string; status: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(created.status, "queued");

  // Wait for the queue worker to finish the run
  let finished: { status: string; cliSessionId: string | null; costUsd: string | null } | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await json<{ status: string; cliSessionId: string | null; costUsd: string | null }>(
      await app.request(`/api/runs/${created.id}`),
    );
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      finished = current;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(finished, "run did not finish in time");
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.cliSessionId, "fake-session-1");

  // Transcript endpoint replays events in the plain line format
  const transcriptRes = await app.request(`/api/runs/${created.id}/transcript`);
  const transcript = await transcriptRes.text();
  const lines = transcript.split("\n");
  assert.match(lines[0]!, /^cursor\|\d+\|succeeded$/);
  assert.ok(lines.some((l) => l.includes("Working on it.")), `transcript missing message: ${transcript}`);
  assert.ok(lines.some((l) => l.startsWith("[done")), `transcript missing done marker: ${transcript}`);

  // Incremental cursor returns nothing new
  const lastSeq = Number(lines[0]!.split("|")[1]);
  const incremental = await (await app.request(`/api/runs/${created.id}/transcript?since=${lastSeq}`)).text();
  assert.equal(incremental.split("\n").length, 1);

  // The fake agent committed in the feature's worktree
  const repos = await json<{ name: string }[]>(await app.request(`/api/projects/${project.id}/repositories`));
  const worktree = ctx.worktrees.worktreePath(feature.id, repos[0]!.name);
  const log = await run("git", ["-C", worktree, "log", "--oneline"]);
  assert.match(log.stdout, /fake agent commit/);

  // A manual stage waits for a person after the agent finishes. The
  // evaluate job is queued, not inline, so reading the board now would
  // race it: still active one moment, gated the next. Wait for the
  // settled status. Left active, a card whose run succeeded looks done
  // rather than like something that needs a person.
  await waitForFeatureStatus(feature.id, ["gated"]);

  // Board plain endpoint shows the feature with its run status
  const board = await (await app.request(`/api/projects/${project.id}/board/plain`)).text();
  // Cost then the agent's latest line sit between the run id and the
  // title; each is a dash when there is nothing to say. Output is a
  // dash here because the run has already succeeded, and stale words
  // on a settled card would read as though something were happening.
  assert.match(
    board,
    new RegExp(
      `feature\\|${feature.id}\\|${advanced.currentStageId}\\|gated\\|succeeded\\|${created.id}\\|[^|]*\\|-\\|Test feature`,
    ),
    board,
  );

  // Manual gate approval advances the card to stage 2
  const next = await json<{ currentStageId: string }>(
    await app.request(`/api/features/${feature.id}/advance`, { method: "POST" }),
  );
  assert.equal(next.currentStageId, pipeline.stages[1]!.id);

  // quick-run creates its profile on first use and succeeds
  const quick = await json<{ id: string }>(
    await app.request(`/api/features/${feature.id}/quick-run?cli=fake`, { method: "POST" }),
  );
  let quickStatus = "";
  const quickDeadline = Date.now() + 60_000;
  while (Date.now() < quickDeadline) {
    const current = await json<{ status: string }>(await app.request(`/api/runs/${quick.id}`));
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      quickStatus = current.status;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(quickStatus, "succeeded");

  // A failing run is reported as failed
  const failing = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        featureId: feature.id,
        agentProfileId: profile.id,
        prompt: "please FAIL this run",
      }),
    }),
  );
  let failStatus = "";
  const failDeadline = Date.now() + 60_000;
  while (Date.now() < failDeadline) {
    const current = await json<{ status: string }>(await app.request(`/api/runs/${failing.id}`));
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      failStatus = current.status;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(failStatus, "failed");
});

test("command gate auto-advances the card when it passes", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Command gate");
  const feature = await createFeature(project.id, "Auto advance me");
  const profile = await fakeProfile("gate-fake-pass");

  // Stage 1 advances automatically once a shell command succeeds.
  await patchStage(stages[0]!.id, {
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "test -f .bento-fake-output", timeoutSec: 30 }],
  });

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(run.id), "succeeded");

  // The fake agent writes .bento-fake-output, so the gate passes and the
  // card moves to stage 2 with no human involvement.
  const settled = await waitForStage(feature.id, stages[1]!.id);
  assert.equal(settled.status, "active");

  assert.equal(await waitForLastTransition(feature.id, "gate_auto"), "gate_auto");
});

test("failing command gate holds the card and recheck can clear it", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Failing gate");
  const feature = await createFeature(project.id, "Hold me");
  const profile = await fakeProfile("gate-fake-hold");

  await patchStage(stages[0]!.id, {
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "test -f never-created-by-anyone", timeoutSec: 30 }],
  });

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  await waitForRun(run.id);

  const held = await waitForFeatureStatus(feature.id, ["gated"]);
  assert.equal(held.currentStageId, stages[0]!.id, "card must not advance past a failing gate");

  const gate = await json<{ checks: { status: string; detail: { message: string } }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );
  assert.equal(gate.checks[0]?.status, "failed");
  assert.match(gate.checks[0]?.detail.message ?? "", /exited 1/);

  // Relax the criterion, re-check, and the same card advances.
  await patchStage(stages[0]!.id, { gateCriteria: [{ type: "command", cmd: "true", timeoutSec: 30 }] });
  await app.request(`/api/features/${feature.id}/recheck`, { method: "POST" });
  const cleared = await waitForStage(feature.id, stages[1]!.id);
  assert.equal(cleared.status, "active");
});

/**
 * The two modes are different questions, not one being the other plus a
 * step: a manual stage is a person's decision and consults nothing
 * else. This used to be the opposite, with a stage able to demand both
 * an approval and green checks, and the two mechanisms could disagree
 * about who was in charge.
 *
 * A stage still carrying the older `manual` criterion is read as
 * manual, which is what keeps pipelines built before the mode existed
 * behaving exactly as they did.
 */
test("a manual stage decides on the person alone, whatever else is listed", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Mixed gate");
  const feature = await createFeature(project.id, "Mixed criteria");

  // A command that cannot pass, on a manual stage. It must not hold the
  // card, because a manual stage does not consult it.
  await patchStage(stages[0]!.id, {
    gateType: "manual",
    gateCriteria: [{ type: "command", cmd: "false", timeoutSec: 30 }],
  });

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForStage(feature.id, stages[0]!.id);

  const approved = await json<{ feature: { currentStageId: string } }>(
    await app.request(`/api/features/${feature.id}/approve`, { method: "POST" }),
  );
  assert.equal(
    approved.feature.currentStageId,
    stages[1]!.id,
    "approving a manual stage advances it, regardless of what its criteria say",
  );

  // The legacy spelling: an automatic stage carrying a manual criterion
  // is still a person's decision, so it waits.
  await patchStage(stages[1]!.id, { gateType: "auto", gateCriteria: [{ type: "manual" }] });
  await new Promise((r) => setTimeout(r, 2_000));
  const held = await json<{ currentStageId: string }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(held.currentStageId, stages[1]!.id, "a manual criterion still means a person decides");
});


/**
 * Chaining goes through two queued jobs (gate.evaluate, then the next
 * stage's run.execute), so it is the slowest path in the suite and needs
 * a longer window than a single run does.
 */
test("each stage can run a different agent, and advancing chains the next run", { timeout: 180_000 }, async () => {
  const { project, stages } = await setupProject("Per stage agents");
  const feature = await createFeature(project.id, "Chained stages");
  const designer = await fakeProfile("stage-designer");
  const implementer = await fakeProfile("stage-implementer");

  await patchStage(stages[0]!.id, {
    defaultAgentProfileId: designer.id,
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "true", timeoutSec: 30 }],
  });
  await patchStage(stages[1]!.id, { defaultAgentProfileId: implementer.id });

  // Entering stage 1 queues the designer on its own; starting it by
  // hand as well would be the double start the busy guard refuses.
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const firstRun = await runByProfile(feature.id, designer.id);
  await waitForRun(firstRun.id);
  await waitForStage(feature.id, stages[1]!.id, 120_000);

  // The gate passing queues the implementer automatically.
  const chained = await runByProfile(feature.id, implementer.id);
  assert.equal(chained.stageId, stages[1]!.id);
});

/** Polls until the feature has a run by the given agent, however it was started. */
async function runByProfile(featureId: string, profileId: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await json<{ runs: { id: string; agentProfileId: string; stageId: string }[] }>(
      await app.request(`/api/features/${featureId}`),
    );
    const found = detail.runs.find((r) => r.agentProfileId === profileId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no run by profile ${profileId} appeared within ${timeoutMs}ms`);
}

test("a finished run can be resumed in the same CLI session", { timeout: 90_000 }, async () => {
  const { project } = await setupProject("Resume");
  const feature = await createFeature(project.id, "Resume me");
  const profile = await fakeProfile("resume-fake");

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const first = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  await waitForRun(first.id);

  const resumed = await json<{ id: string; cliSessionId: string; prompt: string }>(
    await app.request(`/api/runs/${first.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "also handle the empty case" }),
    }),
  );
  assert.equal(resumed.cliSessionId, "fake-session-1");
  assert.equal(resumed.prompt, "also handle the empty case");
  assert.equal(await waitForRun(resumed.id), "succeeded");

  // Newest first, so the run someone just started is never below a scroll.
  const { runs } = await json<{ runs: { id: string }[] }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.id, resumed.id, "the latest run leads the list");
});

/**
 * A phase runs an agent profile, and a profile pairs a coding agent
 * with a model. Not every pairing exists: Claude Code cannot run a GPT
 * model. Picking the tool first is what normally keeps the two in step,
 * but a model typed by hand and the API both skip that, so the pairing
 * is checked where it is stored.
 *
 * Refusing here is what keeps the failure cheap. Stored, the pairing
 * would be assigned to a phase and only fall over once a sandbox had
 * started and a run was already underway.
 */
/**
 * Editing an agent, rather than deleting it and making another. The
 * difference is the id: stages point at an agent through it, so an
 * edit re-points every stage using that agent, and a replacement
 * leaves them all pointing at nothing.
 */
test("an agent can be edited, and its stages follow it", { timeout: 60_000 }, async () => {
  const created = await json<{ id: string; name: string; model: string; extraArgs: string[] }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Before", cli: "claude-code", model: "claude-opus-5", extraArgs: ["--verbose"] }),
    }),
  );
  const { project, stages: projectStages } = await setupProject("Editing");
  const stage = projectStages[0]!;
  await patchStage(stage.id, { defaultAgentProfileId: created.id });

  const patch = (body: unknown, id = created.id) =>
    app.request(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // A rename alone must not disturb the rest of the row. extraArgs has
  // a default on create, and defaulting it here would empty it.
  const renamed = await json<{ name: string; model: string; extraArgs: string[] }>(await patch({ name: "After" }));
  assert.equal(renamed.name, "After");
  assert.equal(renamed.model, "claude-opus-5", "a rename must not move the model");
  assert.deepEqual(renamed.extraArgs, ["--verbose"], "a rename must not clear the flags");

  // The pairing is checked against the merged row. Only the model is
  // being sent, so a check reading the body alone would see no cli and
  // wave this through.
  const impossible = await patch({ model: "gpt-5-pro" });
  assert.equal(impossible.status, 400, "Claude Code still cannot run an OpenAI model");
  const stillThere = await json<{ model: string }>(await app.request(`/api/profiles`)).then((rows) =>
    (rows as unknown as { id: string; model: string }[]).find((p) => p.id === created.id),
  );
  assert.equal(stillThere?.model, "claude-opus-5", "a refused edit must not be applied");

  // Changing both at once is how a pairing legitimately moves.
  const moved = await json<{ cli: string; model: string }>(
    await patch({ cli: "opencode", model: "openai/gpt-5-pro" }),
  );
  assert.equal(moved.cli, "opencode");
  assert.equal(moved.model, "openai/gpt-5-pro");

  // The stage still points at the same agent, which now runs something
  // else. That is the whole reason to edit rather than replace.
  const pipeline = await json<{ stages: { id: string; defaultAgentProfileId: string | null }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.equal(pipeline.stages.find((s) => s.id === stage.id)?.defaultAgentProfileId, created.id);

  assert.equal((await patch({ name: "x" }, "00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await patch({})).status, 400, "an empty patch is a mistake, not a no-op");
});

/**
 * The list is read by a person looking for one agent by name, so it is
 * ordered by name.
 *
 * Unordered, Postgres returns heap order, and an update rewrites the
 * row at the end of the table: editing an agent sent it to the bottom
 * of every list it appeared in, which reads as a "recently changed"
 * sort nobody asked for.
 */
test("agents are listed alphabetically, and an edit does not move one", async () => {
  const post = (name: string) =>
    app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, cli: "claude-code", model: "claude-opus-5" }),
    });

  // Created out of order, and mixed case: capitals sorting ahead of
  // lowercase would split the list into two alphabets.
  const names = ["zz sorting Zebra", "zz sorting alpha", "zz sorting Middle"];
  const ids: Record<string, string> = {};
  for (const name of names) {
    const row = await json<{ id: string; name: string }>(await post(name));
    ids[name] = row.id;
  }

  const listed = async () =>
    (await json<{ id: string; name: string }[]>(await app.request("/api/profiles")))
      .filter((p) => p.name.startsWith("zz sorting "))
      .map((p) => p.name);

  assert.deepEqual(await listed(), ["zz sorting alpha", "zz sorting Middle", "zz sorting Zebra"]);

  await app.request(`/api/profiles/${ids["zz sorting alpha"]}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5" }),
  });
  assert.deepEqual(
    await listed(),
    ["zz sorting alpha", "zz sorting Middle", "zz sorting Zebra"],
    "editing an agent must not move it in the list",
  );

  // The TUI reads the same agents through a different route.
  const plain = await (await app.request("/api/profiles/plain")).text();
  const fromPlain = plain
    .split("\n")
    .map((line) => line.split("|").at(-1) ?? "")
    .filter((name) => name.startsWith("zz sorting "));
  assert.deepEqual(fromPlain, ["zz sorting alpha", "zz sorting Middle", "zz sorting Zebra"]);
});

test("an impossible pairing of coding agent and model is refused", async () => {
  const post = (body: unknown) =>
    app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const refused = await post({ name: "wrong", cli: "claude-code", model: "gpt-5-pro" });
  assert.equal(refused.status, 400, "Claude Code cannot run an OpenAI model");
  assert.match(((await refused.json()) as { error: string }).error, /cannot run OpenAI models/);

  // Nothing was stored, so the phase cannot end up pointing at it.
  const listed = (await json<{ name: string }[]>(await app.request("/api/profiles"))).filter(
    (p) => p.name === "wrong",
  );
  assert.equal(listed.length, 0, "a refused pairing must not be stored");

  // The pairing people actually run: Claude Code with an Opus model.
  const allowed = await post({ name: "opus on claude code", cli: "claude-code", model: "claude-opus-5" });
  assert.equal(allowed.status, 201, "Claude Code running Opus is the ordinary case");

  // Provider naming tools reach far more, which is the point of them.
  const wide = await post({ name: "gpt on opencode", cli: "opencode", model: "openai/gpt-5-pro" });
  assert.equal(wide.status, 201, "opencode names its provider, so it reaches OpenAI");

  const harness = await post({ name: "DeepSeek harness", cli: "dsh", model: "deepseek-v4-pro" });
  assert.equal(harness.status, 201, "DeepSeek Harness accepts its bare model id");
  const prefixedHarness = await post({ name: "prefixed harness", cli: "dsh", model: "deepseek/deepseek-v4-pro" });
  assert.equal(prefixedHarness.status, 400, "DeepSeek Harness cannot accept provider-prefixed model ids");
  assert.match(((await prefixedHarness.json()) as { error: string }).error, /bare model id/);

  // A model the catalog has not caught up with is allowed: the snapshot
  // trails the tools, and refusing a brand new model would be worse.
  const unknown = await post({ name: "next week's model", cli: "claude-code", model: "claude-opus-9" });
  assert.equal(unknown.status, 201, "an unprovable pairing must not be refused");

  // The quick-run shortcut mints its own profile, so it is checked too.
  const { project } = await setupProject("pairing");
  const feature = await createFeature(project.id, "pairing");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const quick = await app.request(
    `/api/features/${feature.id}/quick-run?cli=claude-code&model=gpt-5-pro`,
    { method: "POST" },
  );
  assert.equal(quick.status, 400, "quick-run's ?model= must not bypass the check");
});

/**
 * The point of an automatic stage: a card crosses the board on its own.
 *
 * This is the behaviour that was missing. A stage's mode was stored,
 * shown, and editable, but nothing read it, and a stage with no
 * criteria returned early rather than advancing, so a fully automatic
 * pipeline sat still while its agents ran and succeeded.
 */
test("a card crosses an automatic pipeline with no human input", { timeout: 180_000 }, async () => {
  const { project, stages } = await setupProject("autopilot");
  const profile = await fakeProfile("autopilot agent");
  for (const stage of stages) {
    await patchStage(stage.id, { gateType: "auto", gateCriteria: [], defaultAgentProfileId: profile.id });
  }

  const feature = await createFeature(project.id, "walks by itself");
  // The one human action: put it into the pipeline. Nothing after this.
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  // It should reach the far end on its own, each stage running its
  // agent and handing on when that agent finishes.
  await waitForFeatureStatus(feature.id, ["done"], 150_000);

  const events = await json<{ kind: string; trigger: string }[]>(
    await app.request(`/api/features/${feature.id}/history`),
  );
  const automatic = events.filter((e) => e.kind === "stage_moved" && e.trigger === "gate_auto");
  assert.ok(
    automatic.length >= stages.length - 1,
    `expected the card to advance itself through the stages, saw ${automatic.length} automatic moves`,
  );
});

/**
 * A manual stage is a person's decision and consults no criteria, so
 * approving advances and rejecting sends the card back.
 */
test("a manual stage waits for a person, then approve advances and reject goes back", { timeout: 120_000 }, async () => {
  const { project, stages } = await setupProject("manual gate");
  const first = stages[0]!;
  const second = stages[1]!;
  await patchStage(first.id, { gateType: "manual", gateCriteria: [] });
  await patchStage(second.id, { gateType: "manual", gateCriteria: [] });

  const feature = await createFeature(project.id, "needs a person");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForStage(feature.id, first.id);

  // No agent, no criteria, and it must not wander off on its own.
  await new Promise((r) => setTimeout(r, 3_000));
  let now = await json<{ currentStageId: string }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(now.currentStageId, first.id, "a manual stage must not advance by itself");

  // And it has to READ as waiting. Left active, a card whose agent has
  // finished shows a succeeded run and looks done rather than like
  // something that needs a person, which is what the board colours on.
  const waiting = await waitForFeatureStatus(feature.id, ["gated"], 30_000);
  assert.equal(waiting.currentStageId, first.id);
  const gate = await json<{ checks: { detail: { message?: string } }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );
  assert.match(gate.checks.map((c) => c.detail?.message ?? "").join(" "), /Waiting for your approval/);

  const approved = await app.request(`/api/features/${feature.id}/approve`, { method: "POST" });
  assert.equal(approved.status, 200);
  await waitForStage(feature.id, second.id);

  const rejected = await app.request(`/api/features/${feature.id}/reject?reason=not+yet`, { method: "POST" });
  assert.equal(rejected.status, 200);
  await waitForStage(feature.id, first.id);

  now = await json<{ currentStageId: string }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(now.currentStageId, first.id, "rejecting sends the card back a stage");
});

/**
 * An automatic stage with no agent can never finish, and nothing would
 * ask again: runs are what queue an evaluation, and the sweep only
 * revisits cards already marked gated. It has to say so rather than sit
 * there silently, which is what it used to do.
 */
test("an automatic stage with no agent holds the card and says why", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("no agent");
  const first = stages[0]!;
  await patchStage(first.id, { gateType: "auto", gateCriteria: [], defaultAgentProfileId: null });

  const feature = await createFeature(project.id, "nothing to run");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForFeatureStatus(feature.id, ["gated"], 60_000);

  const gate = await json<{ checks: { detail: { message?: string } }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );
  assert.match(
    gate.checks.map((c) => c.detail?.message ?? "").join(" "),
    /No agent is assigned/,
    "the card must say why it stopped",
  );
});

/**
 * A manual stage whose agent has finished has two things to say, and
 * they are different facts: the work is done, and nobody has decided
 * yet. Said as one row it claimed the opposite of the first, reading as
 * though the run had not succeeded.
 */
test("a finished manual stage says the agent completed and that approval is pending", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("says both");
  const profile = await fakeProfile("says-both-agent");
  await patchStage(stages[0]!.id, { gateType: "manual", gateCriteria: [], defaultAgentProfileId: profile.id });

  const feature = await createFeature(project.id, "done but undecided");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForFeatureStatus(feature.id, ["gated"], 60_000);

  const gate = await json<{ checks: { criterion: { type: string }; status: string; detail: { message?: string } }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );

  const run = gate.checks.find((c) => c.criterion.type === "run_succeeded");
  assert.ok(run, "the card should say what happened to the agent");
  assert.equal(run.status, "passed", "the agent finished, so this must not read as unsatisfied");
  assert.match(run.detail?.message ?? "", /completed/);

  const approval = gate.checks.find((c) => c.criterion.type === "manual");
  assert.ok(approval, "and that a person still has to decide");
  assert.equal(approval.status, "pending");
  assert.match(approval.detail?.message ?? "", /Waiting for your approval/);
});

/**
 * Spend is reported, never enforced, and it has to be honest about its
 * own coverage. Bento prices nothing: it records what the CLI printed,
 * and Codex, Cursor, and opencode print nothing. A total that quietly
 * omitted those would read as a cheap project rather than an
 * unmeasured one.
 */
test("usage says how much of the spend it could not measure", { timeout: 120_000 }, async () => {
  const { project, stages } = await setupProject("spend");
  const profile = await fakeProfile("spend agent");
  await patchStage(stages[0]!.id, { gateType: "manual", gateCriteria: [], defaultAgentProfileId: profile.id });

  const feature = await createFeature(project.id, "costs something");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForFeatureStatus(feature.id, ["gated"], 60_000);

  const idle = await createFeature(project.id, "never ran");
  const usage = await json<{
    totalUsd: number;
    totalRuns: number;
    runsWithoutCost: number;
    byFeature: { featureId: string; title: string; runs: number; costUsd: number | null; runsWithoutCost: number }[];
  }>(await app.request(`/api/projects/${project.id}/usage`));
  assert.ok(usage.totalRuns >= 1, "the run should be counted");
  // The fake agent reports a cost, so this one is measured.
  assert.ok(usage.totalUsd > 0, "a reported cost should reach the total");
  assert.equal(typeof usage.runsWithoutCost, "number", "coverage is always stated, even when complete");

  const billed = usage.byFeature.find((row) => row.featureId === feature.id);
  assert.ok(billed, "the card that ran should appear on the spend rollup");
  assert.ok((billed.costUsd ?? 0) > 0, "a reported cost should reach the card");
  assert.ok(billed.runs >= 1);
  const untouched = usage.byFeature.find((row) => row.featureId === idle.id);
  assert.ok(untouched, "a card that never ran still belongs on the spend page");
  assert.equal(untouched.runs, 0);
  assert.equal(untouched.costUsd, null, "no runs is not the same as zero dollars");

  // The board carries the same figure, for the client that cannot parse
  // JSON. A dash means nothing reported, which is not zero.
  const board = await (await app.request(`/api/projects/${project.id}/board/plain`)).text();
  const line = board.split("\n").find((l) => l.startsWith(`feature|${feature.id}|`))!;
  const cost = line.split("|")[6]!;
  assert.match(cost, /^\d+\.\d\d$/, `expected a cost field on the board line, got ${cost}`);
});

/**
 * Spend is a bill of finished work. Judges are the gate talking to
 * itself, and a run that is still queued has not printed a figure.
 * Counting either made a fully measured card wear "$4.20+" and made
 * the project total disagree with Sessions.
 */
test("usage ignores judge runs and in-flight runs", async () => {
  const { project, stages: projectStages } = await setupProject("spend-filter");
  const worker = await fakeProfile("spend-worker");
  const judge = await fakeProfile("spend-judge");
  const feature = await createFeature(project.id, "judged and running");
  const idle = await createFeature(project.id, "never ran");
  const stage = projectStages[0]!;

  await ctx.db.insert(agentRuns).values([
    {
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: worker.id,
      prompt: "build it",
      kind: "task",
      status: "succeeded",
      executor: "server",
      costUsd: "4.20",
    },
    {
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: judge.id,
      prompt: `${JUDGE_PROMPT_PREFIX} for the stage "Build".`,
      kind: "judge",
      status: "succeeded",
      executor: "server",
      costUsd: "9.99",
    },
    {
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: worker.id,
      prompt: "still going",
      kind: "task",
      status: "running",
      executor: "server",
      costUsd: null,
    },
  ]);

  const usage = await json<{
    totalUsd: number;
    totalRuns: number;
    runsWithoutCost: number;
    byFeature: { featureId: string; title: string; runs: number; costUsd: number | null; runsWithoutCost: number }[];
  }>(await app.request(`/api/projects/${project.id}/usage`));

  assert.equal(usage.totalRuns, 1, "only the finished task run is a spend run");
  assert.equal(usage.totalUsd, 4.2);
  assert.equal(usage.runsWithoutCost, 0, "an in-flight null is not silent coverage");

  const billed = usage.byFeature.find((row) => row.featureId === feature.id);
  assert.ok(billed);
  assert.equal(billed.runs, 1);
  assert.equal(billed.costUsd, 4.2);
  assert.equal(billed.runsWithoutCost, 0);
  const untouched = usage.byFeature.find((row) => row.featureId === idle.id);
  assert.ok(untouched);
  assert.equal(untouched.runs, 0);
  assert.equal(untouched.costUsd, null);
});

/**
 * The completions chart counts a card once, at its latest completion,
 * and only while it is still done. A reopened card leaves the chart
 * the same way it leaves the Done lane, and a card finished twice is
 * one completion, not two.
 */
test("completions count done cards once, at their latest completion", async () => {
  const { project } = await setupProject("completions");
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000);

  const doneNow = await createFeature(project.id, "done recently");
  const reopened = await createFeature(project.id, "done then reopened");
  const doneTwice = await createFeature(project.id, "done twice");
  const doneLongAgo = await createFeature(project.id, "done long ago");
  await createFeature(project.id, "never finished");

  const finish = (featureId: string, at: Date) => ({
    featureId,
    kind: "status_changed" as const,
    fromStatus: "active",
    toStatus: "done",
    trigger: "manual" as const,
    at,
  });
  await ctx.db.insert(featureEvents).values([
    finish(doneNow.id, twoHoursAgo),
    finish(reopened.id, twoHoursAgo),
    finish(doneTwice.id, fortyDaysAgo),
    finish(doneTwice.id, twoHoursAgo),
    finish(doneLongAgo.id, fortyDaysAgo),
  ]);
  for (const id of [doneNow.id, doneTwice.id, doneLongAgo.id]) {
    await ctx.db.update(features).set({ status: "done" }).where(eq(features.id, id));
  }
  // Reopened after finishing: the done event stays in the log, but the
  // card is active again and must not be counted.
  await ctx.db.update(features).set({ status: "active" }).where(eq(features.id, reopened.id));

  type Completions = {
    range: string;
    bucketUnit: string;
    total: number;
    buckets: { start: string; completed: number }[];
  };

  const week = await json<Completions>(
    await app.request(`/api/projects/${project.id}/completions?range=1w`),
  );
  assert.equal(week.bucketUnit, "day");
  assert.equal(week.buckets.length, 7, "a week is seven day buckets, empty days included");
  assert.equal(week.total, 2, "the recent card and the twice-done card, nothing else");
  assert.equal(
    week.buckets.reduce((sum, b) => sum + b.completed, 0),
    week.total,
    "the headline total is the sum of the bars",
  );
  const starts = week.buckets.map((b) => Date.parse(b.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "buckets arrive oldest first");

  const day = await json<Completions>(
    await app.request(`/api/projects/${project.id}/completions?range=1d`),
  );
  assert.equal(day.bucketUnit, "hour");
  assert.equal(day.buckets.length, 24);
  assert.equal(day.total, 2, "both fresh completions fall inside the last day");

  const year = await json<Completions>(
    await app.request(`/api/projects/${project.id}/completions?range=1y`),
  );
  assert.equal(year.bucketUnit, "month");
  assert.equal(year.buckets.length, 12);
  assert.equal(year.total, 3, "the old completion appears, and the twice-done card still counts once");

  const defaulted = await json<Completions>(await app.request(`/api/projects/${project.id}/completions`));
  assert.equal(defaulted.range, "1m", "no range asked for means the last month");
  assert.equal(defaulted.buckets.length, 30);
  assert.equal(defaulted.total, 2, "a forty day old completion is outside the month");

  const bad = await app.request(`/api/projects/${project.id}/completions?range=2w`);
  assert.equal(bad.status, 400, "an unknown window is refused, not guessed at");
});

test("webhooks are rejected without a valid signature", async () => {
  const res = await app.request("/api/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request" },
    body: JSON.stringify({ action: "opened" }),
  });
  // No webhook secret is configured in this test env, so the endpoint
  // refuses rather than trusting an unsigned payload.
  assert.equal(res.status, 503);
});

/**
 * A project can span several repositories. Each gets its own worktree
 * inside one feature workspace, so an agent sees them side by side and a
 * cross-cutting change is still a single card.
 */
test("a project can span several repositories", { timeout: 90_000 }, async () => {
  // A second fixture repo alongside the first.
  const secondRepo = await mkdtemp(path.join(tmpdir(), "bento-fixture-two-"));
  await run("git", ["-C", secondRepo, "init", "-b", "main"]);
  await writeFile(path.join(secondRepo, "service.md"), "backend\n");
  await run("git", ["-C", secondRepo, "add", "-A"]);
  await run("git", [
    "-C", secondRepo, "-c", "user.email=test@bento.dev", "-c", "user.name=test", "commit", "-qm", "init",
  ]);

  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Two repos",
        repositories: [
          { name: "web", localPath: repoDir },
          { name: "api", localPath: secondRepo },
        ],
      }),
    }),
  );
  await unassignStages(project.id);

  const repos = await json<{ name: string; position: number }[]>(
    await app.request(`/api/projects/${project.id}/repositories`),
  );
  assert.deepEqual(
    repos.map((r) => r.name),
    ["web", "api"],
  );

  const feature = await createFeature(project.id, "Cross cutting change");
  const profile = await fakeProfile("multi-repo-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const started = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(started.id), "succeeded");

  // Both repositories are checked out side by side in one workspace, on
  // the same feature branch. With several repos the agent starts at the
  // workspace root rather than inside any one of them, so it is the
  // agent's job to choose which repositories to touch.
  const workspace = ctx.worktrees.workspacePath(feature.id);
  for (const name of ["web", "api"]) {
    const dir = path.join(workspace, name);
    const gitDir = await run("git", ["-C", dir, "rev-parse", "--git-dir"]);
    assert.ok(gitDir.stdout.trim(), `${name} should be a git worktree`);
    const branch = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
    assert.match(branch.stdout.trim(), /^feature\//, `${name} should be on the feature branch`);
  }
});

test("a project keeps at least one repository", { timeout: 60_000 }, async () => {
  const { project } = await setupProject("Single repo");
  const repos = await json<{ id: string }[]>(await app.request(`/api/projects/${project.id}/repositories`));
  assert.equal(repos.length, 1, "the localPath shorthand creates one repository");

  const res = await app.request(`/api/projects/${project.id}/repositories/${repos[0]!.id}`, { method: "DELETE" });
  assert.equal(res.status, 409, "removing the last repository is refused");
});

/**
 * The workspace has one directory that is not a checkout: artifacts/,
 * where agents put mockups and previews. A repository with that name
 * would collide with it, so a typed name is refused outright, and a
 * name derived from a path (or a GitHub repository actually called
 * artifacts) is suffixed the same way a duplicate is.
 */
test("a repository cannot claim the artifacts directory", { timeout: 60_000 }, async () => {
  const { project } = await setupProject("Reserved name");

  const typed = await app.request(`/api/projects/${project.id}/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "artifacts", localPath: repoDir }),
  });
  assert.equal(typed.status, 400, "a repository named artifacts should be refused");

  // A checkout whose directory is named artifacts, the shape a GitHub
  // repository called artifacts arrives in.
  const parent = await mkdtemp(path.join(tmpdir(), "bento-fixture-reserved-"));
  const dir = path.join(parent, "artifacts");
  await mkdir(dir);
  await run("git", ["-C", dir, "init", "-b", "main"]);
  await writeFile(path.join(dir, "README.md"), "reserved\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.email=test@bento.dev", "-c", "user.name=test", "commit", "-qm", "init"]);

  const derived = await json<{ name: string }>(
    await app.request(`/api/projects/${project.id}/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localPath: dir }),
    }),
  );
  assert.equal(derived.name, "artifacts-2", "a derived artifacts name should be suffixed, not claimed");

  // And the same at project creation, where names settle in one batch.
  const created = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Reserved at creation", repositories: [{ localPath: dir }] }),
    }),
  );
  const names = (await json<{ name: string }[]>(
    await app.request(`/api/projects/${created.id}/repositories`),
  )).map((r) => r.name);
  assert.deepEqual(names, ["artifacts-2"]);
});

test("publication transcript events arrive before a successful run is done", { timeout: 90_000 }, async () => {
  const source = await fixtureRepo("publication-order");

  let allowPublication!: () => void;
  const publicationAllowed = new Promise<void>((resolve) => {
    allowPublication = resolve;
  });
  let reportPublicationStarted!: () => void;
  const publicationStarted = new Promise<void>((resolve) => {
    reportPublicationStarted = resolve;
  });
  const publisher = {
    async pushToken() {
      reportPublicationStarted();
      await publicationAllowed;
      throw new Error("test publication failure");
    },
    async ensurePullRequest() {
      assert.fail("a failed push must not try to open a pull request");
    },
  };
  const previousGitHubApp = ctx.githubApp;

  let unsubscribeEvents = () => {};
  let unsubscribeDone = () => {};
  try {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Publication order",
          repositories: [
            {
              name: "publication-order",
              localPath: source,
              repoUrl: "https://github.com/acme/publication-order",
              defaultBranch: "main",
            },
          ],
        }),
      }),
    );
    await unassignStages(project.id);
    await ctx.db.insert(organization).values({
      id: "publication-order-org",
      name: "Publication Order",
      slug: "publication-order",
    });
    await ctx.db
      .update(projects)
      .set({ organizationId: "publication-order-org" })
      .where(eq(projects.id, project.id));
    const projectPipelines = await ctx.db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(eq(pipelines.projectId, project.id));
    await ctx.db
      .update(pipelines)
      .set({ organizationId: "publication-order-org" })
      .where(eq(pipelines.projectId, project.id));
    for (const pipeline of projectPipelines) {
      await ctx.db
        .update(stages)
        // createPr because publishing is per stage opt in now, and this
        // test is about the ordering of publication notes.
        .set({ organizationId: "publication-order-org", createPr: true })
        .where(eq(stages.pipelineId, pipeline.id));
    }
    await ctx.db.insert(githubInstallations).values({
      organizationId: "publication-order-org",
      installationId: "publication-order-installation",
      accountLogin: "acme",
      accountType: "Organization",
      installedBy: ctx.userId,
    });
    ctx.githubApp = {
      forInstallation() {
        return publisher;
      },
    } as unknown as NonNullable<AppContext["githubApp"]>;
    const feature = await createFeature(project.id, "Publish before done");
    const profile = await fakeProfile("publication-order-agent");
    await ctx.db
      .update(agentProfiles)
      .set({ organizationId: "publication-order-org" })
      .where(eq(agentProfiles.id, profile.id));
    await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
    const started = await json<{ id: string }>(
      await app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
      }),
    );

    const observed: string[] = [];
    unsubscribeEvents = ctx.bus.onRunEvent(started.id, ({ event }) => {
      if (event.type === "message" && event.role === "system" && event.text.startsWith("Could not publish")) {
        observed.push("publication");
      }
    });
    const done = new Promise<string>((resolve) => {
      unsubscribeDone = ctx.bus.onRunDone(started.id, (status) => {
        observed.push("done");
        resolve(status);
      });
    });

    await publicationStarted;
    const whilePublishing = await json<{ status: string }>(await app.request(`/api/runs/${started.id}`));
    assert.equal(whilePublishing.status, "running", "the run must not become terminal before publication notes");

    allowPublication();
    assert.equal(await done, "succeeded");
    assert.deepEqual(observed, ["publication", "done"]);

    const transcript = await (await app.request(`/api/runs/${started.id}/transcript`)).text();
    assert.match(transcript, /Could not publish publication-order/);
    assert.match(transcript.split("\n")[0]!, /^cursor\|\d+\|succeeded$/);
  } finally {
    unsubscribeEvents();
    unsubscribeDone();
    if (previousGitHubApp) ctx.githubApp = previousGitHubApp;
    else delete ctx.githubApp;
    allowPublication();
  }
});

/**
 * The resolve-conflicts button end to end, minus GitHub itself: the
 * server re-reads merge state rather than trusting the button, starts
 * the card's own agent in the work conversation, marks the run
 * "rebase" so its finish republishes the branch, and refuses when
 * nothing conflicts or nothing has run.
 */
test("resolve-conflicts starts the work agent on a conflicted pull request", { timeout: 60_000 }, async () => {
  const source = await fixtureRepo("resolve-conflicts");
  const previousGitHubApp = ctx.githubApp;
  let mergeAnswer: "clean" | "conflicted" | "unknown" = "conflicted";
  const asked: { owner: string; repo: string; prNumber: number }[] = [];
  const github = {
    async mergeState(ref: { owner: string; repo: string; prNumber: number }) {
      asked.push(ref);
      return { state: mergeAnswer };
    },
  };
  try {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Resolve conflicts",
          repositories: [
            {
              name: "resolve-conflicts",
              localPath: source,
              repoUrl: "https://github.com/acme/resolve-conflicts",
              defaultBranch: "main",
            },
          ],
        }),
      }),
    );
    await unassignStages(project.id);
    // The same organization scaffolding the publication test builds:
    // githubConnectionFor only consults the App for a feature that
    // belongs to an organization with an installation.
    await ctx.db.insert(organization).values({
      id: "resolve-conflicts-org",
      name: "Resolve Conflicts",
      slug: "resolve-conflicts",
    });
    await ctx.db.update(projects).set({ organizationId: "resolve-conflicts-org" }).where(eq(projects.id, project.id));
    const projectPipelines = await ctx.db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(eq(pipelines.projectId, project.id));
    await ctx.db
      .update(pipelines)
      .set({ organizationId: "resolve-conflicts-org" })
      .where(eq(pipelines.projectId, project.id));
    for (const p of projectPipelines) {
      await ctx.db.update(stages).set({ organizationId: "resolve-conflicts-org" }).where(eq(stages.pipelineId, p.id));
    }
    await ctx.db.insert(githubInstallations).values({
      organizationId: "resolve-conflicts-org",
      installationId: "resolve-conflicts-installation",
      accountLogin: "acme",
      accountType: "Organization",
      installedBy: ctx.userId,
    });
    ctx.githubApp = {
      forInstallation() {
        return github;
      },
    } as unknown as NonNullable<AppContext["githubApp"]>;

    const feature = await createFeature(project.id, "Conflicted card");
    const worker = await fakeProfile("resolve-conflicts-agent");
    await ctx.db
      .update(agentProfiles)
      .set({ organizationId: "resolve-conflicts-org" })
      .where(eq(agentProfiles.id, worker.id));

    // Nothing published yet: there is no pull request to resolve.
    const early = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(early.status, 409);

    await ctx.db.update(features).set({ branchName: "feature/conflicted" }).where(eq(features.id, feature.id));
    const [repoRow] = await ctx.db.select().from(repositories).where(eq(repositories.projectId, project.id));
    await ctx.db.insert(featurePullRequests).values({
      featureId: feature.id,
      repositoryId: repoRow!.id,
      repoUrl: "https://github.com/acme/resolve-conflicts",
      number: 41,
      url: "https://github.com/acme/resolve-conflicts/pull/41",
    });

    // The drawer's question: which pull requests cannot merge.
    const status = await json<{ name: string; number: number; state: string }[]>(
      await app.request(`/api/features/${feature.id}/merge-status`),
    );
    assert.equal(status.length, 1);
    assert.equal(status[0]?.number, 41);
    assert.equal(status[0]?.state, "conflicted");

    // A conflict with no conversation: there is no agent to hand it to.
    const noRun = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(noRun.status, 400);

    // The card's work run, first on a runner: the server cannot push a
    // branch it never sees, so the button refuses rather than burning a
    // run whose resolution goes nowhere.
    const pipeline = await json<{ stages: { id: string }[] }>(await app.request(`/api/projects/${project.id}/pipeline`));
    const [planted] = await ctx.db
      .insert(agentRuns)
      .values({
        featureId: feature.id,
        stageId: pipeline.stages[0]!.id,
        agentProfileId: worker.id,
        prompt: "build the thing",
        status: "succeeded",
        executor: "runner",
        cliSessionId: "conflict-sess",
      })
      .returning();
    const onRunner = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(onRunner.status, 409);
    assert.match(((await onRunner.json()) as { error: string }).error, /runner/);

    await ctx.db.update(agentRuns).set({ executor: "server" }).where(eq(agentRuns.id, planted!.id));
    const started = await json<{ id: string; kind: string; agentProfileId: string; cliSessionId: string | null; prompt: string }>(
      await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" }),
    );
    assert.equal(started.kind, "rebase");
    assert.equal(started.agentProfileId, worker.id, "the card's own agent resolves");
    assert.equal(started.cliSessionId, "conflict-sess", "inside the work conversation, where the intent lives");
    assert.match(started.prompt, /rebase/i);
    assert.match(started.prompt, /#41/);
    assert.match(started.prompt, /git fetch origin main/, "the fetch step is a runnable command");
    assert.deepEqual(asked.at(-1), { owner: "acme", repo: "resolve-conflicts", prNumber: 41 });

    // One card, one agent: the queued rebase run holds the lock.
    const busy = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(busy.status, 409);
    await app.request(`/api/runs/${started.id}/cancel`, { method: "POST" });
    await waitForRun(started.id);

    // A stale drawer cannot start a rebase nothing needs: the server
    // asks GitHub again, and a clean pull request refuses.
    mergeAnswer = "clean";
    const clean = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(clean.status, 409);
    assert.match(((await clean.json()) as { error: string }).error, /no merge conflicts/);

    // "unknown" is not "clean": GitHub may still be computing, and the
    // refusal must not put words in its mouth.
    mergeAnswer = "unknown";
    const unknown = await app.request(`/api/features/${feature.id}/resolve-conflicts`, { method: "POST" });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /not finished computing/);

    // A pull request linked by hand writes only features.pr_number, and
    // it must still be visible here: the fallback reads the project's
    // repository with the mirrored number.
    mergeAnswer = "conflicted";
    await ctx.db.delete(featurePullRequests).where(eq(featurePullRequests.featureId, feature.id));
    await ctx.db.update(features).set({ prNumber: 41 }).where(eq(features.id, feature.id));
    const linked = await json<{ number: number; state: string }[]>(
      await app.request(`/api/features/${feature.id}/merge-status`),
    );
    assert.equal(linked.length, 1, "a hand-linked pull request still answers merge-status");
    assert.equal(linked[0]?.number, 41);
    assert.equal(linked[0]?.state, "conflicted");
  } finally {
    if (previousGitHubApp) ctx.githubApp = previousGitHubApp;
    else delete ctx.githubApp;
  }
});

/**
 * Publishing is the half of "the agent opens a pull request" that the
 * agent does not do. The agent commits inside the worktree; the server
 * pushes and opens the pull requests, because an agent can read
 * anything its sandbox can and a push credential in there is one prompt
 * injection from being exfiltrated.
 *
 * The push is real, against a bare repository on disk. Only the GitHub
 * API calls are faked, since those need a GitHub App installation.
 */
/**
 * Create a pull request is a per stage choice, and choosing it without
 * a GitHub connection must say so where the person is looking: in the
 * run's transcript, naming what to configure.
 */
test("a stage set to create a pull request says when no GitHub connection exists", { timeout: 90_000 }, async () => {
  const { project, stages: initial } = await setupProject("PR mode");
  const first = initial[0]!;

  const updated = await json<{ createPr: boolean }>(
    await app.request(`/api/stages/${first.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ createPr: true }),
    }),
  );
  assert.equal(updated.createPr, true, "the setting survives the round trip");

  const feature = await createFeature(project.id, "Wants a pull request");
  const profile = await fakeProfile("pr-mode-agent");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const started = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(started.id), "succeeded");

  const transcript = await (await app.request(`/api/runs/${started.id}/transcript`)).text();
  assert.match(
    transcript,
    /no GitHub connection is configured/,
    "the transcript names the missing connection",
  );
  assert.match(transcript, /Settings, GitHub/, "and says where to fix it");

  // A stage that never asked stays quiet: no note, no pull request talk.
  await patchStage(first.id, { createPr: false });
  const second = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(second.id), "succeeded");
  const quiet = await (await app.request(`/api/runs/${second.id}/transcript`)).text();
  assert.ok(!/pull request/.test(quiet), "an unset stage publishes nothing and says nothing");
});

/**
 * The agent_judge criterion: a second agent rules on the stage's work.
 * The judge is a real run on the same stage, so its reasoning lands in
 * the card's transcript; the fake agent answers VERDICT: INCOMPLETE
 * when its prompt carries JUDGE_INCOMPLETE, which the test plants
 * through the judge profile's skill.
 */
test("a judge agent rules on the work before an automatic stage advances", { timeout: 180_000 }, async () => {
  const { project, stages: initial } = await setupProject("Judged pipeline");
  const first = initial[0]!;
  const second = initial[1]!;
  const worker = await fakeProfile("judged-worker");
  const approver = await fakeProfile("judge-approves");
  const rejecter = await json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "judge-rejects", cli: "fake", model: "fake-1", skill: "JUDGE_INCOMPLETE" }),
    }),
  );

  await patchStage(first.id, {
    gateType: "auto",
    defaultAgentProfileId: worker.id,
    gateCriteria: [{ type: "agent_judge", agentProfileId: rejecter.id }],
  });

  // Advancing starts the worker; its finish starts the judge; the
  // judge's INCOMPLETE verdict holds the card where its reason shows.
  const feature = await createFeature(project.id, "Judge me");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  // The card gates as soon as the judge STARTS ("reviewing the work"),
  // so wait for the ruling itself rather than the gated status.
  type Gate = { checks: { criterion: { type: string }; status: string; detail: { message?: string } }[] };
  let ruling: Gate["checks"][number] | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const gate = await json<Gate>(await app.request(`/api/features/${feature.id}/gate`));
    ruling = gate.checks.find((check) => check.criterion.type === "agent_judge");
    if (ruling && ruling.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(ruling?.status, "failed");
  assert.match(ruling?.detail.message ?? "", /incomplete/i);
  assert.match(ruling?.detail.message ?? "", /fake judge says no/i, "the judge's own reason reaches the card");

  // A friendlier judge and a re-check: the new judge approves and the
  // card advances on its own.
  await patchStage(first.id, {
    gateCriteria: [{ type: "agent_judge", agentProfileId: approver.id }],
  });
  await app.request(`/api/features/${feature.id}/recheck`, { method: "POST" });
  await waitForStage(feature.id, second.id);
});

/**
 * The Create pull request button. The push mechanics are proven against
 * a real remote in "the server pushes each repository the agent
 * committed in"; this covers the route's guardrails, which are what a
 * local-mode user without a token meets first.
 */
test("publishing on demand says what it needs before it can push", { timeout: 60_000 }, async () => {
  const { project } = await setupProject("Manual publish");
  const feature = await createFeature(project.id, "Publish me by hand");

  // Still in the backlog: no branch exists to push.
  const noBranch = await app.request(`/api/features/${feature.id}/publish`, { method: "POST" });
  assert.equal(noBranch.status, 409);
  assert.match(((await noBranch.json()) as { error: string }).error, /no branch yet/);

  // On the board a branch exists, but this test env has no GitHub
  // connection, and the refusal names the fix.
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const noGithub = await app.request(`/api/features/${feature.id}/publish`, { method: "POST" });
  assert.equal(noGithub.status, 409);
  assert.match(((await noGithub.json()) as { error: string }).error, /Settings, GitHub/);
});

/**
 * The Create PR button on a hosted card. A sprite keeps its checkouts
 * inside the sandbox, where the server cannot mount them, so the route
 * exports the commits through the driver, the same handoff a finished
 * run uses, and pushes with the organization's App installation. The
 * push itself is proven against a real remote in "the server pushes
 * each repository the agent committed in".
 */
test("publishing on demand exports the card's sandbox when the driver keeps no host worktrees", { timeout: 60_000 }, async () => {
  const checkout = await fixtureRepo("sandbox-publish");
  await run("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/sandbox-publish.git"]);
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sandbox publish", localPath: checkout }),
    }),
  );
  await unassignStages(project.id);
  const [repo] = await json<{ name: string }[]>(await app.request(`/api/projects/${project.id}/repositories`));

  // The connection a hosted organization actually has: an App
  // installation, which githubConnectionFor answers before any token.
  await ctx.db.insert(organization).values({
    id: "sandbox-publish-org",
    name: "Sandbox Publish",
    slug: "sandbox-publish",
  });
  await ctx.db.update(projects).set({ organizationId: "sandbox-publish-org" }).where(eq(projects.id, project.id));
  await ctx.db.insert(githubInstallations).values({
    organizationId: "sandbox-publish-org",
    installationId: "sandbox-publish-installation",
    accountLogin: "acme",
    accountType: "Organization",
    installedBy: ctx.userId,
  });
  const feature = await createFeature(project.id, "Publish from the sandbox");
  const [stored] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(stored?.organizationId, "sandbox-publish-org", "the card inherits the project's organization");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const exported: string[] = [];
  let exportError: Error | null = null;
  const fakeDriver = {
    provider: "sprite",
    async provision(): Promise<never> {
      throw new Error("this test provisions nothing");
    },
    exec(): AsyncIterable<never> {
      throw new Error("this test execs nothing");
    },
    async destroy() {},
    async exportRepository(handle: SandboxHandle, name: string, base: string) {
      if (exportError) throw exportError;
      exported.push(`${handle.externalId}:${handle.workdir}:${name}->${base}`);
      // Nothing committed beyond the base, so nothing to publish.
      return null;
    },
  };
  const previousDriver = ctx.driver;
  const previousGitHubApp = ctx.githubApp;
  ctx.driver = fakeDriver as unknown as AppContext["driver"];
  ctx.githubApp = {
    forInstallation(installationId: string) {
      assert.equal(installationId, "sandbox-publish-installation");
      return {
        async pushToken() {
          return "unused: nothing was committed, so nothing is pushed";
        },
        async ensurePullRequest() {
          assert.fail("nothing to publish means no pull request is opened");
        },
      };
    },
  } as unknown as NonNullable<AppContext["githubApp"]>;
  try {
    // A card that never ran has no sandbox to read.
    const noSandbox = await app.request(`/api/features/${feature.id}/publish`, { method: "POST" });
    assert.equal(noSandbox.status, 409);
    assert.match(((await noSandbox.json()) as { error: string }).error, /no sandbox yet/);

    await ctx.db.insert(sandboxes).values({
      projectId: project.id,
      featureId: feature.id,
      provider: "sprite",
      externalId: "sprite-publish-test",
      status: "hibernated",
      workdir: "/workspace",
    });
    const res = await app.request(`/api/features/${feature.id}/publish`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { published: [], failures: [] });
    assert.deepEqual(exported, [`sprite-publish-test:/workspace:${repo!.name}->main`]);

    // A sandbox that went away surfaces as a named failure, not a
    // refusal to try.
    exportError = new Error("the sandbox is gone");
    const dead = await app.request(`/api/features/${feature.id}/publish`, { method: "POST" });
    assert.equal(dead.status, 200);
    const body = (await dead.json()) as { published: unknown[]; failures: { name: string; reason: string }[] };
    assert.deepEqual(body.published, []);
    assert.equal(body.failures[0]?.name, repo!.name);
    assert.match(body.failures[0]?.reason ?? "", /the sandbox is gone/);
  } finally {
    ctx.driver = previousDriver;
    ctx.githubApp = previousGitHubApp;
  }
});

/**
 * An agent used once could never be deleted, because its runs pointed
 * at it and the delete was refused. The runs go with it now: the board
 * should not fill with names nobody uses, and the cards themselves keep
 * their event log either way.
 */
test("deleting an agent takes its runs with it", { timeout: 90_000 }, async () => {
  const { project, stages: pipelineStages } = await setupProject("Deletable agent");
  const feature = await createFeature(project.id, "Ran once");
  const profile = await fakeProfile("disposable");
  // Advanced before the stage has an agent, so nothing auto-starts and
  // this test owns the one run it is about to make.
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await patchStage(pipelineStages[0]!.id, { defaultAgentProfileId: profile.id });
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(run.id, 90_000), "succeeded");

  const removed = await app.request(`/api/profiles/${profile.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { deletedRuns: number }).deletedRuns, 1, "it says what it took");

  const runs = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  assert.equal(runs.length, 0, "the run went with the agent");
  const events = await ctx.db.select().from(runEvents).where(eq(runEvents.runId, run.id));
  assert.equal(events.length, 0, "and so did its transcript");

  // The stage it was assigned to is released rather than left pointing
  // at something that no longer exists.
  const pipeline = await json<{ stages: { id: string; defaultAgentProfileId: string | null }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.equal(pipeline.stages[0]?.defaultAgentProfileId, null);

  // The card is still there, and still knows it moved.
  const history = await json<unknown[]>(await app.request(`/api/features/${feature.id}/history`));
  assert.ok(history.length > 0, "the card keeps its own history");
});

/**
 * A card was the one thing in Bento that could not be removed short of
 * deleting the organization, so the first card anybody makes, which the
 * README tells them to make, was permanent.
 */
test("a card created by mistake can be deleted, and a repeat answers 404", async () => {
  const { project } = await setupProject("Deletable card");
  const feature = await createFeature(project.id, "Typo in the tilte");

  const deleted = await app.request(`/api/features/${feature.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  const listed = await json<{ id: string }[]>(await app.request(`/api/features?projectId=${project.id}`));
  assert.ok(!listed.some((f) => f.id === feature.id), "it is off the board, not filtered out of one view");
  assert.equal((await app.request(`/api/features/${feature.id}`)).status, 404);

  // 404 rather than success on a repeat, for the reason the profiles
  // delete already writes down: answering the same thing to "deleted it
  // already" and to "that is not yours" is what keeps the route from
  // confirming which ids exist.
  const again = await app.request(`/api/features/${feature.id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
});

/**
 * The delete this feature exists for: a card that has actually run.
 *
 * Its sandbox is a machine somebody is billed for, so the row cannot go
 * without the machine going first, and the branch is the only copy of
 * the work, so the machine cannot take that with it.
 */
test("deleting a worked card takes its runs, transcript and sandbox, and leaves the branch", { timeout: 90_000 }, async () => {
  const { project, stages: pipelineStages } = await setupProject("Deletable worked card");
  const feature = await createFeature(project.id, "Ran before it went");
  const profile = await fakeProfile("worked-then-deleted");
  // Advanced before the stage has an agent, so nothing auto-starts and
  // this test owns the one run it is about to make.
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await patchStage(pipelineStages[0]!.id, { defaultAgentProfileId: profile.id });
  const started = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(started.id, 90_000), "succeeded");

  const { branchName } = await json<{ branchName: string }>(await app.request(`/api/features/${feature.id}`));
  const [sandboxRow] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, feature.id));
  assert.ok(sandboxRow, "the run left a sandbox row, which is the thing the delete has to clean up");

  // This route is the first caller of driver.destroy in the product, so
  // the test watches the call rather than trusting the status code.
  const destroyed: SandboxHandle[] = [];
  const realDestroy = ctx.driver.destroy.bind(ctx.driver);
  ctx.driver.destroy = async (handle: SandboxHandle) => {
    destroyed.push(handle);
    await realDestroy(handle);
  };
  try {
    const res = await app.request(`/api/features/${feature.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
  } finally {
    ctx.driver.destroy = realDestroy;
  }

  assert.deepEqual(
    destroyed.map((h) => h.externalId),
    [sandboxRow!.externalId],
    "the machine is destroyed, not merely forgotten about",
  );
  assert.equal((await ctx.db.select().from(features).where(eq(features.id, feature.id))).length, 0);
  assert.equal((await ctx.db.select().from(agentRuns).where(eq(agentRuns.featureId, feature.id))).length, 0);
  assert.equal(
    (await ctx.db.select().from(runEvents).where(eq(runEvents.runId, started.id))).length,
    0,
    "the transcript went with the run",
  );
  assert.equal((await ctx.db.select().from(featureEvents).where(eq(featureEvents.featureId, feature.id))).length, 0);
  assert.equal((await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, sandboxRow!.id))).length, 0);
  // The check the investigation proposed for a machine gone adrift: a
  // sandbox row whose card is gone is one nothing in the product can
  // name again, and it would still be billing.
  const orphans = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.projectId, project.id), isNull(sandboxes.featureId)));
  assert.equal(orphans.length, 0, "no sandbox row is left pointing at nothing");

  // The promise the whole feature rests on: the work is the user's.
  const branches = await run("git", ["-C", repoDir, "branch", "--list", branchName]);
  assert.ok(branches.stdout.trim(), `the branch ${branchName} survives the card`);
});

/**
 * Refused rather than "cancel the agent and then delete": a delete that
 * also silently kills a running agent is a lot of consequence behind
 * one button.
 */
test("a card an agent is working cannot be deleted", async () => {
  const { project, stages: pipelineStages } = await setupProject("Busy card");
  const feature = await createFeature(project.id, "Being worked right now");
  const profile = await fakeProfile("still-going");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  // A run row rather than a live agent: the refusal is about the row's
  // status, and a real fake agent would finish while the test read it.
  const [working] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature.id,
      stageId: pipelineStages[0]!.id,
      agentProfileId: profile.id,
      prompt: "",
      status: "running",
    })
    .returning();

  const refused = await app.request(`/api/features/${feature.id}`, { method: "DELETE" });
  assert.equal(refused.status, 409);
  // Its own sentence, not CARD_BUSY: "wait for it to finish" is advice
  // about starting a second run, and waiting does not delete a card.
  assert.equal(((await refused.json()) as { error: string }).error, CARD_BUSY_DELETE);
  assert.equal((await app.request(`/api/features/${feature.id}`)).status, 200, "the card is where it was");
  assert.equal((await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, working!.id))).length, 1);

  // Queued counts as working too, which is what keeps a run.execute job
  // from ever naming a run a delete has removed.
  await ctx.db.update(agentRuns).set({ status: "queued" }).where(eq(agentRuns.id, working!.id));
  assert.equal((await app.request(`/api/features/${feature.id}`, { method: "DELETE" })).status, 409);

  // Finished, and the card goes.
  await ctx.db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, working!.id));
  assert.equal((await app.request(`/api/features/${feature.id}`, { method: "DELETE" })).status, 200);
});

/**
 * The ordering that makes this feature safe, from the failing side. A
 * destroyed machine with its card still on the board is a retry; a
 * deleted card with its machine still running is a billed sandbox no
 * query in the product can find.
 */
test("a sandbox that will not die keeps its card", async () => {
  const { project } = await setupProject("Stubborn sandbox");
  const feature = await createFeature(project.id, "Has a machine that argues");
  await ctx.db.insert(sandboxes).values({
    projectId: project.id,
    featureId: feature.id,
    provider: "docker",
    externalId: "sandbox-that-will-not-die",
    status: "hibernated",
    workdir: "/workspace",
  });

  const realDestroy = ctx.driver.destroy.bind(ctx.driver);
  ctx.driver.destroy = async () => {
    throw new Error("the machine did not answer");
  };
  let body: { error: string };
  try {
    const res = await app.request(`/api/features/${feature.id}`, { method: "DELETE" });
    assert.equal(res.status, 502);
    body = (await res.json()) as { error: string };
  } finally {
    ctx.driver.destroy = realDestroy;
  }
  assert.match(body.error, /the machine did not answer/, "the reason reaches the person, not just the log");
  assert.match(body.error, /The card was not deleted/);

  assert.equal((await app.request(`/api/features/${feature.id}`)).status, 200, "nothing observable changed");
  const rows = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, feature.id));
  assert.equal(rows.length, 1, "and the row still points at the machine, so a retry can find it");
});

/**
 * The other side of the race the delete opens. A start that blocks on
 * the delete's row lock wakes up to a card that is gone, and the runs
 * insert would die on its foreign key as an unhandled 500.
 */
test("starting a run on a card that was deleted answers gone, not a foreign key error", async () => {
  const { project, stages: pipelineStages } = await setupProject("Gone card");
  const feature = await createFeature(project.id, "Deleted mid start");
  const profile = await fakeProfile("too-late");
  assert.equal((await app.request(`/api/features/${feature.id}`, { method: "DELETE" })).status, 200);

  const outcome = await startRunIfIdle(ctx.db, {
    featureId: feature.id,
    stageId: pipelineStages[0]!.id,
    agentProfileId: profile.id,
    prompt: "",
    executor: "server",
  });
  assert.equal(outcome, "gone");

  // And every door that starts a run says so rather than throwing.
  const created = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
  });
  assert.equal(created.status, 404);
  const quick = await app.request(`/api/features/${feature.id}/quick-run?cli=fake`, { method: "POST" });
  assert.equal(quick.status, 404);
  const message = await app.request(`/api/features/${feature.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "anybody there" }),
  });
  assert.equal(message.status, 404);
});

/**
 * Sharing carries the login of the machine the SERVER runs on into each
 * sandbox, so a containerised server has nothing to offer however its
 * sandboxes run. The console reads this to hide the control rather than
 * show one that can only report failure.
 *
 * This suite runs the server as a host process, which is the case that
 * must stay visible: hiding a working control is the worse mistake,
 * because the person looking at it cannot recover from it.
 */
test("the settings route says whether a machine login can be shared", { timeout: 60_000 }, async () => {
  const settings = await json<{ canShareMachineLogin: boolean }>(await app.request("/api/settings"));
  assert.equal(typeof settings.canShareMachineLogin, "boolean", "the console gets an answer, not undefined");
  assert.equal(settings.canShareMachineLogin, true, "a server running on the host can offer its own login");
});

/**
 * The identity on agent commits had no home in the product: a server in
 * a container has no git config to read, so every commit arrived as the
 * sandbox image's placeholder and the only fix was an env var set
 * before boot.
 */
test("the commit identity can be set from the settings route", { timeout: 60_000 }, async () => {
  const before = await json<{ gitIdentity: { name: string } | null }>(await app.request("/api/settings"));
  void before;

  const saved = await app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com" }),
  });
  assert.equal(saved.status, 200);

  const after = await json<{ gitAuthorName: string; gitAuthorEmail: string; gitIdentity: { name: string; email: string } | null }>(
    await app.request("/api/settings"),
  );
  assert.equal(after.gitAuthorName, "Ada Lovelace");
  assert.equal(after.gitAuthorEmail, "ada@example.com");

  // What a commit would say, resolved through the same path a run uses.
  const identity = await gitIdentityEnv(ctx);
  assert.equal(identity.GIT_AUTHOR_NAME, "Ada Lovelace");
  assert.equal(identity.GIT_AUTHOR_EMAIL, "ada@example.com");
  assert.equal(identity.GIT_COMMITTER_NAME, "Ada Lovelace", "the committer is set too, not just the author");

  // The setting is the only thing that sets this. The environment used
  // to outrank it, which left the console showing a field that changed
  // nothing while the real value lived somewhere it could not edit.
  process.env.GIT_AUTHOR_NAME = "CI Runner";
  process.env.GIT_AUTHOR_EMAIL = "ci@example.com";
  try {
    const ignored = await gitIdentityEnv(ctx);
    assert.equal(ignored.GIT_AUTHOR_NAME, "Ada Lovelace", "the environment does not override the setting");
    assert.equal(ignored.GIT_AUTHOR_EMAIL, "ada@example.com");
  } finally {
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
  }

  // Blank clears it rather than storing an empty author.
  await app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gitAuthorName: "", gitAuthorEmail: "" }),
  });
  const cleared = await json<{ gitAuthorName: string }>(await app.request("/api/settings"));
  assert.equal(cleared.gitAuthorName, "");
});

/**
 * Reordering is one request carrying the whole sequence, because
 * positions have to stay unique and contiguous: "this one is third now"
 * leaves the server guessing what happened to the one that was.
 */
test("stages can be reordered, and a partial order is refused", { timeout: 60_000 }, async () => {
  const { project, stages: original } = await setupProject("Reordering");
  const pipeline = await json<{ id: string }>(await app.request(`/api/projects/${project.id}/pipeline`));

  // Last to first, the move somebody makes when a review step turns out
  // to belong at the start.
  const moved = [original[5]!.id, ...original.slice(0, 5).map((s) => s.id)];
  const ok = await app.request("/api/stages/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pipelineId: pipeline.id, stageIds: moved }),
  });
  assert.equal(ok.status, 200);

  const after = await json<{ stages: { id: string; position: number }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.deepEqual(after.stages.map((s) => s.id), moved, "the pipeline reads back in the new order");
  assert.deepEqual(after.stages.map((s) => s.position), [0, 1, 2, 3, 4, 5], "positions stay contiguous");

  // A list missing a stage would leave that stage holding a position
  // this request is handing to somebody else.
  const partial = await app.request("/api/stages/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pipelineId: pipeline.id, stageIds: moved.slice(0, 3) }),
  });
  assert.equal(partial.status, 400);
  const repeated = await app.request("/api/stages/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pipelineId: pipeline.id, stageIds: [...moved.slice(0, 5), moved[0]!] }),
  });
  assert.equal(repeated.status, 400, "the same stage twice is not an order");

  // The refusals changed nothing.
  const unchanged = await json<{ stages: { id: string }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.deepEqual(unchanged.stages.map((s) => s.id), moved);
});

/**
 * A pipeline is weeks of tuning. Exported and imported it moves to the
 * next project, or into the repository beside the code it describes,
 * instead of being clicked together again.
 */
test("a pipeline exports to YAML and imports into another project", { timeout: 90_000 }, async () => {
  const source = await setupProject("Exporter");
  const agent = await fakeProfile("Pipeline Reviewer");
  await patchStage(source.stages[4]!.id, {
    defaultAgentProfileId: agent.id,
    gateType: "auto",
    gateCriteria: [{ type: "checks_pass" }],
    createPr: true,
  });
  const [repo] = await json<{ id: string }[]>(
    await app.request(`/api/projects/${source.project.id}/repositories`),
  );
  await app.request(`/api/projects/${source.project.id}/repositories/${repo!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCommand: "npm ci", testCommand: "npm test" }),
  });

  const exported = await app.request(`/api/projects/${source.project.id}/pipeline/export`);
  assert.equal(exported.status, 200);
  const yaml = await exported.text();
  assert.match(yaml, /slug: code-review/);
  assert.match(yaml, /agent: Pipeline Reviewer/);
  assert.match(yaml, /setup: npm ci/);

  // Into a second project, whose repository happens to have the same
  // name, so the commands land too.
  const target = await setupProject("Importer");
  const applied = await app.request(`/api/projects/${target.project.id}/pipeline/import`, {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: yaml,
  });
  assert.equal(applied.status, 200);
  const result = (await applied.json()) as { stages: number; agents: number; skippedRepositories: string[] };
  assert.equal(result.stages, 6);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.skippedRepositories, []);

  const pipeline = await json<{ stages: { slug: string; gateType: string; createPr: boolean; defaultAgentProfileId: string | null }[] }>(
    await app.request(`/api/projects/${target.project.id}/pipeline`),
  );
  const review = pipeline.stages.find((s) => s.slug === "code-review");
  assert.equal(review?.gateType, "auto");
  assert.equal(review?.createPr, true);
  assert.ok(review?.defaultAgentProfileId, "the agent named in the file is assigned here too");

  const targetRepos = await json<{ setupCommand: string | null; testCommand: string | null }[]>(
    await app.request(`/api/projects/${target.project.id}/repositories`),
  );
  assert.equal(targetRepos[0]?.setupCommand, "npm ci");
  assert.equal(targetRepos[0]?.testCommand, "npm test");
});

/**
 * An import that would strand cards is refused whole. Half an import is
 * worse than none: the board would be left in a shape nobody chose.
 */
test("an import that would delete an occupied stage is refused", { timeout: 90_000 }, async () => {
  const { project, stages: seeded } = await setupProject("Occupied");
  const feature = await createFeature(project.id, "Sitting in a stage");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const refused = await app.request(`/api/projects/${project.id}/pipeline/import`, {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: "version: 1\npipeline:\n  stages:\n    - name: Only\n      slug: only-stage\n",
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, new RegExp(seeded[0]!.name));
  assert.match(body.error, /1 card is sitting in it/);

  // Nothing was written: the pipeline is exactly as it was.
  const after = await json<{ stages: { id: string }[] }>(await app.request(`/api/projects/${project.id}/pipeline`));
  assert.equal(after.stages.length, seeded.length);
});

/**
 * Named agents move as a file of their own, without the stages. Matched
 * by name, so importing twice edits rather than duplicating, and a
 * pairing the form would refuse is refused here too.
 */
test("agents export to YAML and import updates by name", { timeout: 90_000 }, async () => {
  const created = await json<{ id: string }>(
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Yaml Reviewer",
        cli: "fake",
        model: "fake-1",
        skill: "Review like a hawk.",
      }),
    }),
  );

  const exported = await app.request("/api/profiles/export");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type") ?? "", /yaml/);
  const yaml = await exported.text();
  assert.match(yaml, /name: Yaml Reviewer/);
  assert.match(yaml, /Review like a hawk/);

  const applied = await app.request("/api/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: `version: 1
agents:
  - name: Yaml Reviewer
    tool: fake
    model: fake-1
    skill: |
      Review twice.
  - name: Yaml Newcomer
    tool: fake
    model: fake-1
    skill: Fresh pairing.
`,
  });
  assert.equal(applied.status, 200);
  const result = (await applied.json()) as { agents: number };
  assert.equal(result.agents, 2);

  const listed = await json<{ id: string; name: string; skill: string | null }[]>(await app.request("/api/profiles"));
  const reviewer = listed.filter((p) => p.name === "Yaml Reviewer");
  assert.equal(reviewer.length, 1, "importing twice must edit rather than duplicate");
  assert.equal(reviewer[0]!.id, created.id);
  assert.match(reviewer[0]!.skill ?? "", /Review twice/);
  assert.ok(listed.some((p) => p.name === "Yaml Newcomer"));
});

test("an agents import with an impossible pairing is refused", { timeout: 60_000 }, async () => {
  const refused = await app.request("/api/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: `version: 1
agents:
  - name: Impossible Pair
    tool: claude-code
    model: composer-2.5
`,
  });
  assert.equal(refused.status, 400);
  const listed = await json<{ name: string }[]>(await app.request("/api/profiles"));
  assert.ok(!listed.some((p) => p.name === "Impossible Pair"));
});

/**
 * A new project arrives ready to run. Six empty lanes and no agents was
 * six job titles to invent before anything could move.
 */
test("a new project comes with an agent on every stage", { timeout: 60_000 }, async () => {
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Seeded", localPath: repoDir }),
    }),
  );
  const pipeline = await json<{ stages: { name: string; defaultAgentProfileId: string | null }[] }>(
    await app.request(`/api/projects/${project.id}/pipeline`),
  );
  assert.equal(pipeline.stages.length, 6);
  for (const stage of pipeline.stages) {
    assert.ok(stage.defaultAgentProfileId, `${stage.name} should arrive with an agent`);
  }

  // A second project reuses them rather than making a second set of the
  // same six names.
  const before = await json<{ id: string }[]>(await app.request("/api/profiles"));
  const second = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Seeded again", localPath: repoDir }),
    }),
  );
  const after = await json<{ id: string }[]>(await app.request("/api/profiles"));
  assert.equal(after.length, before.length, "the second project reused the agents already there");
  const secondPipeline = await json<{ stages: { defaultAgentProfileId: string | null }[] }>(
    await app.request(`/api/projects/${second.id}/pipeline`),
  );
  assert.ok(secondPipeline.stages[0]?.defaultAgentProfileId);
});

/**
 * A sandbox carries git and the agent CLIs and no language runtime, so
 * a project's toolchain arrives through its repository's setup command.
 * It has to actually run, and it has to run once: paying a cold install
 * on every stage would make a five stage pipeline five installs.
 */
test("a repository's setup command runs before the agent, once per sandbox", { timeout: 120_000 }, async () => {
  const checkout = await fixtureRepo("setup-command");
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Toolchain", localPath: checkout }),
    }),
  );
  await unassignStages(project.id);
  const [repo] = await json<{ id: string }[]>(await app.request(`/api/projects/${project.id}/repositories`));
  const patched = await app.request(`/api/projects/${project.id}/repositories/${repo!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // Appends, so a second run would be visible as a second line.
    body: JSON.stringify({ setupCommand: "printf 'ran\\n' >> setup-log.txt", testCommand: "true" }),
  });
  assert.equal(patched.status, 200);

  const feature = await createFeature(project.id, "Needs a toolchain");
  const profile = await fakeProfile("setup-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const first = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(first.id, 90_000), "succeeded");

  const transcript = await (await app.request(`/api/runs/${first.id}/transcript`)).text();
  assert.match(transcript, /Setting up .*: printf/, "the transcript says what ran");
  assert.match(transcript, /Setup for .* finished/);

  const logPath = path.join(ctx.worktrees.worktreePath(feature.id, repoNameOf(checkout)), "setup-log.txt");
  assert.equal(await readFile(logPath, "utf8"), "ran\n", "the command really ran, in the checkout");

  // A second run on the same card reuses the sandbox, so the install is
  // not paid again.
  const second = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(await waitForRun(second.id, 90_000), "succeeded");
  assert.equal(await readFile(logPath, "utf8"), "ran\n", "the setup command did not run twice");
  const secondTranscript = await (await app.request(`/api/runs/${second.id}/transcript`)).text();
  assert.doesNotMatch(secondTranscript, /Setting up/);
});

test("a setup command that fails stops the run before the agent starts", { timeout: 120_000 }, async () => {
  const checkout = await fixtureRepo("setup-fails");
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Broken toolchain", localPath: checkout }),
    }),
  );
  await unassignStages(project.id);
  const [repo] = await json<{ id: string }[]>(await app.request(`/api/projects/${project.id}/repositories`));
  await app.request(`/api/projects/${project.id}/repositories/${repo!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCommand: "echo 'no such package' >&2; exit 7" }),
  });

  const feature = await createFeature(project.id, "Cannot build");
  const profile = await fakeProfile("setup-fail-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const started = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );

  assert.equal(await waitForRun(started.id, 90_000), "failed");
  const detail = await json<{ error: string | null }>(await app.request(`/api/runs/${started.id}`));
  assert.match(detail.error ?? "", /exited 7/);
  const transcript = await (await app.request(`/api/runs/${started.id}/transcript`)).text();
  assert.match(transcript, /no such package/, "the command's own output says why");
  // The agent never ran, so nothing of its own is in the transcript.
  assert.doesNotMatch(transcript, /Working on it/);
});

/**
 * The stage write-ups are how one stage's output reaches the next, so
 * they are committed on the branch. That is no reason to put six
 * generated markdown files in front of a reviewer, so the pushed head
 * takes them back out, and a setting puts them back.
 */
test("stage write-ups stay on the branch but out of the pull request", { timeout: 90_000 }, async () => {
  const bare = await mkdtemp(path.join(tmpdir(), "bento-notes-remote-"));
  await run("git", ["-C", bare, "init", "--bare", "-b", "main"]);
  const work = await fixtureRepo("stage-notes");
  await run("git", ["-C", work, "push", bare, "main"]);

  const branch = "feature/with-notes";
  await run("git", ["-C", work, "checkout", "-q", "-b", branch]);
  await mkdir(path.join(work, "docs/bento"), { recursive: true });
  await writeFile(path.join(work, "docs/bento/design.md"), "what the design stage decided\n");
  await writeFile(path.join(work, "src.js"), "the actual change\n");
  await run("git", ["-C", work, "add", "-A"]);
  await run("git", [
    "-C", work, "-c", "user.email=test@bento.dev", "-c", "user.name=test", "commit", "-qm", "work and notes",
  ]);

  const publisher = {
    async pushToken() {
      return "unused";
    },
    async ensurePullRequest(input: { owner: string; repo: string }) {
      return { prNumber: 7, url: `https://github.com/${input.owner}/${input.repo}/pull/7` };
    },
  };
  const { project } = await setupProject("Stage notes");
  const feature = await createFeature(project.id, "Notes stay home");
  const repositories = [
    { id: null, name: "notes", repoUrl: "https://github.com/acme/notes", defaultBranch: "main", worktreePath: work },
  ];

  const { failures } = await publishFeatureBranches(
    ctx.db,
    publisher,
    { featureId: feature.id, featureTitle: "Notes stay home", branch, repositories },
    { remoteUrl: () => bare },
  );
  assert.deepEqual(failures, []);

  // The code is on the remote branch and the write-up is not.
  const files = await run("git", ["-C", bare, "ls-tree", "-r", "--name-only", branch]);
  assert.match(files.stdout, /src\.js/, "the change itself is pushed");
  assert.doesNotMatch(files.stdout, /docs\/bento/, "the stage write-up is not in the pull request");
  // Still in the branch's history, for anyone who goes looking.
  const history = await run("git", ["-C", bare, "log", "--name-only", "--format=", branch]);
  assert.match(history.stdout, /docs\/bento\/design\.md/, "the write-up is still in the history");

  // The local branch is untouched: the next stage reads the file.
  const local = await run("git", ["-C", work, "ls-tree", "-r", "--name-only", branch]);
  assert.match(local.stdout, /docs\/bento\/design\.md/, "the worktree keeps the write-up");

  // With the setting on, they ride along.
  await publishFeatureBranches(
    ctx.db,
    publisher,
    { featureId: feature.id, featureTitle: "Notes stay home", branch, repositories },
    { remoteUrl: () => bare, includeStageNotes: true },
  );
  const withNotes = await run("git", ["-C", bare, "ls-tree", "-r", "--name-only", branch]);
  assert.match(withNotes.stdout, /docs\/bento\/design\.md/, "the setting puts them back");
});

/** The directory name a checkout gets inside a feature's workspace. */
function repoNameOf(checkout: string): string {
  return checkout.replace(/\/+$/, "").split("/").pop()!;
}

/**
 * Publishing refused with "no GitHub remote is linked" on projects
 * added by path, because nothing ever asked the checkout where it came
 * from. It knows: the URL is in its own config.
 */
test("a repository added by path keeps the GitHub remote its checkout has", { timeout: 60_000 }, async () => {
  const checkout = await fixtureRepo("has-origin");
  // The ssh form, to prove both spellings land as one canonical URL.
  await run("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:acme/has-origin.git"]);

  const project = await json<{ id: string; repoUrl: string | null }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Linked by path", localPath: checkout }),
    }),
  );
  await unassignStages(project.id);
  assert.equal(project.repoUrl, "https://github.com/acme/has-origin");
  const rows = await json<{ repoUrl: string | null }[]>(
    await app.request(`/api/projects/${project.id}/repositories`),
  );
  assert.equal(rows[0]?.repoUrl, "https://github.com/acme/has-origin");
});

test("a repository stored without a remote is linked the next time it publishes", { timeout: 60_000 }, async () => {
  const checkout = await fixtureRepo("backfill");
  const project = await json<{ id: string; repoUrl: string | null }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Linked later", localPath: checkout }),
    }),
  );
  await unassignStages(project.id);
  // Nothing to find at the time it was added, which is the state every
  // project created before this existed is in.
  assert.equal(project.repoUrl, null);

  await run("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/backfill.git"]);
  const stored = await ctx.db.select().from(repositories).where(eq(repositories.projectId, project.id));
  const linked = await linkGitHubRemotes(ctx.db, stored);
  assert.equal(linked[0]?.repoUrl, "https://github.com/acme/backfill");

  // Remembered, so gate criteria and hosted clones see the same link.
  const reread = await ctx.db.select().from(repositories).where(eq(repositories.projectId, project.id));
  assert.equal(reread[0]?.repoUrl, "https://github.com/acme/backfill");
});

test("the server pushes each repository the agent committed in", { timeout: 90_000 }, async () => {
  const bare = await mkdtemp(path.join(tmpdir(), "bento-remote-"));
  await run("git", ["-C", bare, "init", "--bare", "-b", "main"]);
  const work = await fixtureRepo("publishing");
  await run("git", ["-C", work, "push", bare, "main"]);

  const branch = "feature/publish-me";
  await run("git", ["-C", work, "checkout", "-q", "-b", branch]);
  await writeFile(path.join(work, "done.md"), "the agent's work\n");
  await run("git", ["-C", work, "add", "-A"]);
  await run("git", [
    "-C", work, "-c", "user.email=test@bento.dev", "-c", "user.name=test", "commit", "-qm", "agent work",
  ]);

  // A second repository the agent did not touch, which must not get an
  // empty pull request of its own.
  const untouched = await fixtureRepo("untouched");

  // The agent-controlled origin is deliberately hostile. Publishing is
  // given the trusted transport separately and must never consult it.
  await run("git", ["-C", work, "remote", "add", "origin", "https://attacker.invalid/steal-token.git"]);
  await run("git", ["-C", untouched, "remote", "add", "origin", "https://attacker.invalid/steal-token.git"]);

  const asked: string[] = [];
  const publisher = {
    async pushToken() {
      return "not used by a path remote";
    },
    async ensurePullRequest(input: { owner: string; repo: string; head: string; base: string }) {
      asked.push(`${input.repo}:${input.head}->${input.base}`);
      return { prNumber: 42, url: `https://github.com/${input.owner}/${input.repo}/pull/42` };
    },
  };

  const { project } = await setupProject("Publishing");
  const feature = await createFeature(project.id, "Publish me");
  const repositories = [
    { id: null, name: "worked-in", repoUrl: "https://github.com/acme/worked-in", defaultBranch: "main", worktreePath: work },
    { id: null, name: "untouched", repoUrl: "https://github.com/acme/untouched", defaultBranch: "main", worktreePath: untouched },
  ];
  const { published, failures } = await publishFeatureBranches(ctx.db, publisher, {
    featureId: feature.id,
    featureTitle: "Publish me",
    branch,
    repositories,
  }, { remoteUrl: () => bare });

  assert.deepEqual(failures, [], "the push should succeed against a real remote");
  assert.deepEqual(published.map((p) => p.name), ["worked-in"]);
  // The repository the agent never committed in is skipped before any
  // push: an empty pull request per stage per repository would bury the
  // real ones.
  assert.deepEqual(asked, ["worked-in:feature/publish-me->main"]);

  // The branch is really on the remote, with the agent's commit on it.
  const remoteBranches = await run("git", ["-C", bare, "branch", "--list", branch]);
  assert.match(remoteBranches.stdout, /feature\/publish-me/, "the feature branch reached the remote");
  const remoteFile = await run("git", ["-C", bare, "show", `${branch}:done.md`]);
  assert.match(remoteFile.stdout, /the agent's work/);

  // One row per repository, and running the same stage again updates it
  // rather than opening a second pull request.
  const rows = await ctx.db.select().from(featurePullRequests).where(eq(featurePullRequests.featureId, feature.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.number, 42);
  await publishFeatureBranches(ctx.db, publisher, {
    featureId: feature.id,
    featureTitle: "Publish me",
    branch,
    repositories,
  }, { remoteUrl: () => bare });
  const afterSecond = await ctx.db
    .select()
    .from(featurePullRequests)
    .where(eq(featurePullRequests.featureId, feature.id));
  assert.equal(afterSecond.length, 1, "a second stage reuses the pull request rather than opening another");

  // The feature's own pr_number mirrors the first repository's.
  const [mirrored] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(mirrored?.prNumber, 42);
});

/**
 * The rule an agent must never break, enforced where it cannot be
 * talked out of it. The prompt says so too, but a prompt is a request.
 */
test("publishing refuses to push to a protected branch", { timeout: 60_000 }, async () => {
  const work = await fixtureRepo("protected");
  const { project } = await setupProject("Protected");
  const feature = await createFeature(project.id, "Do not merge me");

  let pushed = false;
  for (const branch of ["main", "master", "MAIN"]) {
    const { published, failures } = await publishFeatureBranches(
      ctx.db,
      {
        async pushToken() {
          pushed = true;
          return "t";
        },
        async ensurePullRequest() {
          pushed = true;
          return { prNumber: 1, url: "u" };
        },
      },
      {
        featureId: feature.id,
        featureTitle: "Do not merge me",
        branch,
        repositories: [
          { id: null, name: "repo", repoUrl: "https://github.com/acme/repo", defaultBranch: "main", worktreePath: work },
        ],
      },
    );
    assert.deepEqual(published, []);
    assert.match(failures[0]?.reason ?? "", /protected branch/);
  }
  assert.equal(pushed, false, "it refuses before asking for a credential, let alone using one");
});

/** A throwaway git repository, for tests that need several. */
async function fixtureRepo(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `bento-fixture-${label}-`));
  await run("git", ["-C", dir, "init", "-b", "main"]);
  await writeFile(path.join(dir, "README.md"), `${label}\n`);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.email=test@bento.dev", "-c", "user.name=test", "commit", "-qm", "init"]);
  return dir;
}

/**
 * A path typed with a leading `~` used to be stored exactly as typed.
 * Only a shell expands tildes, so provisioning later stat'd a directory
 * literally named `~` and every run on that project died with
 * "repository path ~/... does not exist on the machine running the
 * server". The TUI expanded before sending; the console did not, and
 * nothing between them did either.
 */
test("a repository path is stored expanded, not with the tilde as typed", { timeout: 60_000 }, async () => {
  const checkout = await fixtureRepo("tilde");
  mock.method(os, "homedir", () => path.dirname(checkout));
  try {
    const project = await json<{ id: string; localPath: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Tilde", localPath: `~/${path.basename(checkout)}` }),
      }),
    );
    assert.equal(project.localPath, checkout, "the project mirrors the expanded path");

    const [repo] = await json<{ localPath: string }[]>(
      await app.request(`/api/projects/${project.id}/repositories`),
    );
    assert.equal(repo?.localPath, checkout, "the repository stores a path the filesystem can find");

    // The second door in, which takes the same input and once skipped
    // the same step.
    const added = await json<{ localPath: string }>(
      await app.request(`/api/projects/${project.id}/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "again", localPath: `~/${path.basename(checkout)}` }),
      }),
    );
    assert.equal(added.localPath, checkout, "adding a repository expands it too");
  } finally {
    mock.restoreAll();
  }
});

/**
 * Expanding a tilde is only right when the server shares a home with
 * the person typing. Inside a container `~` is /root, so expanding
 * quietly would store /root/projects/app: still wrong, and now naming a
 * directory nobody typed. A path that resolves to nothing is refused
 * while the field is still on screen.
 */
test("a checkout path that resolves to nothing is refused at once", { timeout: 60_000 }, async () => {
  const elsewhere = await mkdtemp(path.join(tmpdir(), "bento-not-home-"));
  mock.method(os, "homedir", () => elsewhere);
  try {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nowhere", localPath: "~/projects/absent" }),
    });
    assert.equal(res.status, 400, "a path pointing at nothing does not become a project");
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /home/, "the refusal names the home the server actually has");
    assert.match(error, /~\/projects\/absent/, "and the path as it was typed");

    // A relative path is refused for the same reason: nothing here
    // should be resolved against whatever directory the server started in.
    const relative = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Relative", localPath: "projects/app" }),
    });
    assert.equal(relative.status, 400, "a relative path is refused");
  } finally {
    mock.restoreAll();
  }
});

const repoNames = async (projectId: string) =>
  (await json<{ name: string; position: number }[]>(await app.request(`/api/projects/${projectId}/repositories`))).map(
    (r) => [r.name, r.position] as const,
  );

/**
 * Removing a repository used to leave two kinds of wreckage behind.
 *
 * Positions kept the hole, while a later add took the row count as its
 * position, so the new repository landed on one already in use and the
 * workspace order came down to whatever the database returned. And the
 * project's own repository columns went on naming the removed one, so a
 * GitHub gate reported on a repository the project no longer spanned.
 */
test("removing a repository renumbers the rest and re-points the project", { timeout: 90_000 }, async () => {
  const [second, third, fourth] = await Promise.all([fixtureRepo("b"), fixtureRepo("c"), fixtureRepo("d")]);
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renumbering",
        repositories: [
          { name: "one", localPath: repoDir },
          { name: "two", localPath: second },
          { name: "three", localPath: third },
        ],
      }),
    }),
  );
  await unassignStages(project.id);
  const idOf = async (index: number) =>
    (await json<{ id: string }[]>(await app.request(`/api/projects/${project.id}/repositories`)))[index]!.id;

  await app.request(`/api/projects/${project.id}/repositories/${await idOf(1)}`, { method: "DELETE" });
  assert.deepEqual(await repoNames(project.id), [
    ["one", 0],
    ["three", 1],
  ], "positions close up rather than leaving a hole");

  await app.request(`/api/projects/${project.id}/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "four", localPath: fourth }),
  });
  assert.deepEqual(await repoNames(project.id), [
    ["one", 0],
    ["three", 1],
    ["four", 2],
  ], "the added repository takes a position no other holds");

  // The project's localPath, repoUrl and defaultBranch mirror the first
  // repository, so dropping the first has to move them to the new one.
  await app.request(`/api/projects/${project.id}/repositories/${await idOf(0)}`, { method: "DELETE" });
  const after = await json<{ localPath: string }>(await app.request(`/api/projects/${project.id}`));
  assert.equal(after.localPath, third, "the project points at the repository that is now first");

  const gone = await app.request(`/api/projects/${project.id}/repositories/${await idOf(0)}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  const twice = await app.request(`/api/projects/${project.id}/repositories/${await idOf(0)}`, { method: "DELETE" });
  assert.equal(twice.status, 409, "the last one is still refused");
});

/**
 * A workspace is built once and reused for the life of the feature, so
 * a repository removed from the project stayed checked out inside it and
 * every later agent could still read and write that repository. Removing
 * one has to actually take it away.
 */
test("a repository removed from a project leaves the feature workspace", { timeout: 120_000 }, async () => {
  const second = await fixtureRepo("leaving");
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shrinking",
        repositories: [
          { name: "kept", localPath: repoDir },
          { name: "dropped", localPath: second },
        ],
      }),
    }),
  );
  await unassignStages(project.id);
  const feature = await createFeature(project.id, "Spans two, then one");
  const profile = await fakeProfile("shrinking-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const runOnce = async () => {
    const started = await json<{ id: string }>(
      await app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
      }),
    );
    assert.equal(await waitForRun(started.id), "succeeded");
  };
  const workspace = ctx.worktrees.workspacePath(feature.id);
  const checkedOut = async () =>
    (await readdir(workspace, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

  await runOnce();
  assert.deepEqual(await checkedOut(), ["dropped", "kept"]);

  const repos = await json<{ id: string; name: string }[]>(
    await app.request(`/api/projects/${project.id}/repositories`),
  );
  const dropped = repos.find((r) => r.name === "dropped")!;
  await app.request(`/api/projects/${project.id}/repositories/${dropped.id}`, { method: "DELETE" });

  await runOnce();
  assert.deepEqual(await checkedOut(), ["kept"], "the removed repository is no longer mounted for the agent");
  // Its worktree is disowned, not merely unlinked, or git would refuse
  // to check that branch out anywhere else.
  const listed = await run("git", ["-C", second, "worktree", "list"]);
  assert.doesNotMatch(listed.stdout, new RegExp(feature.id), "git no longer lists a worktree for the feature");
});

/**
 * The middle deployment option: the server holds the board, but agents
 * execute on someone's machine. Runs marked for a runner are never
 * queued to the server's own worker; a runner claims them, streams
 * events back, and reports the outcome, which then drives the gate.
 */
test("a runner executes work the server holds for it", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Runner project");
  await app.request(`/api/projects/${project.id}`, { method: "GET" });

  // Switch the project to runner execution.
  await ctx.db.execute(
    sql`update projects set executor = 'runner' where id = ${project.id}`,
  );

  const feature = await createFeature(project.id, "Runner feature");
  const profile = await fakeProfile("runner-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const created = await json<{ id: string; status: string; executor: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(created.executor, "runner");

  // The server's own worker must not pick this up.
  await new Promise((r) => setTimeout(r, 1500));
  const stillQueued = await json<{ status: string }>(await app.request(`/api/runs/${created.id}`));
  assert.equal(stillQueued.status, "queued", "runner work must wait to be claimed");

  // A runner claims it and receives everything needed to execute.
  const claimRes = await app.request("/api/runner/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: "test-laptop" }),
  });
  const claim = (await claimRes.json()) as {
    run: { id: string; prompt: string } | null;
    agent?: { cli: string; model: string };
    repositories?: { name: string; localPath: string }[];
    stagePrompt?: string;
  };
  assert.ok(claim.run, "a queued runner job should be claimable");
  assert.equal(claim.run.id, created.id);
  assert.equal(claim.agent?.cli, "fake");
  assert.equal(claim.repositories?.length, 1);
  assert.match(claim.stagePrompt ?? "", /Runner feature/);

  // Claiming twice yields nothing, so two runners cannot duplicate work.
  const second = (await (
    await app.request("/api/runner/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "other-laptop" }),
    })
  ).json()) as { run: unknown };
  assert.equal(second.run, null, "a claimed run must not be handed out again");

  // The runner streams transcript events back.
  await app.request(`/api/runner/runs/${created.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "test-laptop",
      events: [
        { type: "init", sessionId: "runner-session-1" },
        { type: "message", role: "assistant", text: "Working locally." },
      ],
    }),
  });
  const running = await json<{ status: string }>(await app.request(`/api/runs/${created.id}`));
  assert.equal(running.status, "running", "events move a claimed run into running");

  const transcript = await (await app.request(`/api/runs/${created.id}/transcript`)).text();
  assert.match(transcript, /Working locally\./);

  // And reports the outcome, which drives the gate.
  await app.request(`/api/runner/runs/${created.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: "test-laptop", ok: true, sessionId: "runner-session-1", costUsd: 0.02, exitCode: 0 }),
  });
  const finished = await json<{ status: string; cliSessionId: string }>(
    await app.request(`/api/runs/${created.id}`),
  );
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.cliSessionId, "runner-session-1");

  const approved = await json<{ feature: { currentStageId: string } }>(
    await app.request(`/api/features/${feature.id}/approve`, { method: "POST" }),
  );
  assert.equal(approved.feature.currentStageId, stages[1]!.id);
});

/**
 * One card, one agent. A second Start while a run is queued or working
 * would put two agents on the same branch, so every door refuses it,
 * and cancelling the run opens the door again.
 */
test("a card with a run in flight refuses a second start", { timeout: 90_000 }, async () => {
  const { project } = await setupProject("Busy card");
  // Runner execution keeps the first run queued, so the window this
  // guard closes stays open for the whole test.
  await ctx.db.execute(sql`update projects set executor = 'runner' where id = ${project.id}`);

  const feature = await createFeature(project.id, "Busy feature");
  const profile = await fakeProfile("busy-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const start = () =>
    app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    });
  const first = await json<{ id: string }>(await start());

  const duplicate = await start();
  assert.equal(duplicate.status, 409, "a second start must be refused while one run is in flight");
  const refusal = (await duplicate.json()) as { error: string };
  assert.match(refusal.error, /already working/);

  const quick = await app.request(`/api/features/${feature.id}/quick-run?cli=fake`, { method: "POST" });
  assert.equal(quick.status, 409, "quick-run is the same door");

  const detail = await json<{ runs: unknown[] }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(detail.runs.length, 1, "only one run may exist for the card");

  // Cancelling the run frees the card.
  await app.request(`/api/runs/${first.id}/cancel`, { method: "POST" });
  const retry = await start();
  assert.equal(retry.status, 201, "a cancelled run no longer blocks the card");

  // Leave nothing queued: later tests claim from the shared runner pool.
  const opened = (await retry.json()) as { id: string };
  await app.request(`/api/runs/${opened.id}/cancel`, { method: "POST" });
});

/**
 * Reporting endpoints decide whether a stage passed, which advances a
 * card and can start the next agent, so they need the same care as the
 * orchestrator. A run may only be reported by the machine that claimed
 * it, and only when the caller can see its project.
 */
test("only the machine that claimed a run may report on it", { timeout: 90_000 }, async () => {
  const { project } = await setupProject("Report guard");
  await ctx.db.execute(sql`update projects set executor = 'runner' where id = ${project.id}`);

  const feature = await createFeature(project.id, "Guarded feature");
  const profile = await fakeProfile("guard-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const created = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Nobody has claimed it yet, so no machine may report on it.
  const unclaimed = await post(`/api/runner/runs/${created.id}/complete`, { runnerId: "attacker", ok: true });
  assert.equal(unclaimed.status, 409);

  await post("/api/runner/claim", { runnerId: "owner-laptop" });

  // A different machine cannot inject transcript events or finish it.
  const wrongEvents = await post(`/api/runner/runs/${created.id}/events`, {
    runnerId: "attacker",
    events: [{ type: "message", role: "assistant", text: "injected" }],
  });
  assert.equal(wrongEvents.status, 409);

  const wrongComplete = await post(`/api/runner/runs/${created.id}/complete`, { runnerId: "attacker", ok: true });
  assert.equal(wrongComplete.status, 409);

  const stillRunning = await json<{ status: string }>(await app.request(`/api/runs/${created.id}`));
  assert.notEqual(stillRunning.status, "succeeded", "an unauthorized report must not finish the run");

  const transcript = await (await app.request(`/api/runs/${created.id}/transcript`)).text();
  assert.doesNotMatch(transcript, /injected/, "an unauthorized report must not reach the transcript");

  // The machine that claimed it can.
  const allowed = await post(`/api/runner/runs/${created.id}/complete`, { runnerId: "owner-laptop", ok: true });
  assert.equal(allowed.status, 200);
});

test("server-executed runs cannot be reported by a runner", { timeout: 90_000 }, async () => {
  const { project } = await setupProject("Server executed");
  const feature = await createFeature(project.id, "Server feature");
  const profile = await fakeProfile("server-exec-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  const created = await json<{ id: string; executor: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }),
    }),
  );
  assert.equal(created.executor, "server");
  await waitForRun(created.id);

  const res = await app.request(`/api/runner/runs/${created.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: "any-machine", ok: false, error: "hijack" }),
  });
  assert.equal(res.status, 409);
});

/**
 * Stopping an agent so a person can take over. Cancelling is terminal
 * but is not a failure, so it must not trip the gate or advance the
 * card.
 */
test("a running agent can be cancelled", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Cancellable");
  const feature = await createFeature(project.id, "Stop me");
  // A slow agent, so there is something to interrupt.
  const profile = await fakeProfile("slow-fake");
  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // SLOW makes the fake agent linger so there is a live run to stop.
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "SLOW please wait" }),
    }),
  );

  // Wait until it is genuinely running before interrupting it.
  const deadline = Date.now() + 20_000;
  let status = "queued";
  while (Date.now() < deadline && status !== "running") {
    await new Promise((r) => setTimeout(r, 200));
    status = (await json<{ status: string }>(await app.request(`/api/runs/${run.id}`))).status;
  }
  assert.equal(status, "running", "the agent should be running before we cancel it");

  const cancelled = await app.request(`/api/runs/${run.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal((await json<{ status: string }>(cancelled)).status, "cancelled");

  // Cancelling twice is refused rather than silently repeated.
  const again = await app.request(`/api/runs/${run.id}/cancel`, { method: "POST" });
  assert.equal(again.status, 409);

  // The card stayed put: a cancel is not an outcome the gate should act on.
  const after = await json<{ currentStageId: string; status: string }>(
    await app.request(`/api/features/${feature.id}`),
  );
  assert.equal(after.currentStageId, stages[0]!.id, "cancelling must not advance the card");
});

/**
 * Sending a card back for rework, which the pipeline had no way to
 * express: advancing was the only direction available.
 */
/**
 * A card that goes back must arrive clean.
 *
 * The approval belongs to the attempt that was rejected, not to the
 * card, so a second pass through the same stage has to be decided
 * again rather than inheriting a yes from before the rework.
 */
test("a card can move back a stage, and its stale approval is discarded", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Reworkable");
  const feature = await createFeature(project.id, "Needs rework");
  await patchStage(stages[0]!.id, { gateType: "manual", gateCriteria: [] });
  await patchStage(stages[1]!.id, { gateType: "manual", gateCriteria: [] });

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForStage(feature.id, stages[0]!.id);

  // Approving a manual stage is the decision, so the card moves.
  await app.request(`/api/features/${feature.id}/approve`, { method: "POST" });
  await waitForStage(feature.id, stages[1]!.id);
  const approved = await json<{ checks: { criterion: { type: string }; status: string }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );
  assert.ok(
    !approved.checks.some((c) => c.status === "passed"),
    "the new stage starts undecided, not carrying the last one's approval",
  );

  // All the way back to the backlog, then forward again.
  assert.equal((await app.request(`/api/features/${feature.id}/back`, { method: "POST" })).status, 200);
  assert.equal((await app.request(`/api/features/${feature.id}/back`, { method: "POST" })).status, 200);
  const inBacklog = await json<{ currentStageId: string | null }>(await app.request(`/api/features/${feature.id}`));
  assert.equal(inBacklog.currentStageId, null, "the first stage goes back to the backlog");

  const tooFar = await app.request(`/api/features/${feature.id}/back`, { method: "POST" });
  assert.equal(tooFar.status, 409, "a card in the backlog cannot go back further");

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await waitForStage(feature.id, stages[0]!.id);
  const afterRework = await json<{ checks: { criterion: { type: string }; status: string }[] }>(
    await app.request(`/api/features/${feature.id}/gate`),
  );
  assert.ok(
    !afterRework.checks.some((c) => c.criterion.type === "manual" && c.status === "passed"),
    "an approval given before rework must not survive the trip back",
  );
});



/**
 * A card's history as one ordered log. Stage moves and status changes
 * share a table so answering "what happened to this card" is a single
 * query rather than a union of two.
 */
test("a feature's history records moves and status changes", { timeout: 90_000 }, async () => {
  const { project, stages } = await setupProject("Audited");
  const feature = await createFeature(project.id, "Track me");

  // An automatic gate that cannot pass, so the card gets held and the
  // hold is logged. The mode is set explicitly: stages default to
  // manual, which consults no criteria at all.
  await patchStage(stages[0]!.id, {
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "false", timeoutSec: 30 }],
  });

  await app.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  await app.request(`/api/features/${feature.id}/recheck`, { method: "POST" });
  await app.request(`/api/features/${feature.id}/back`, { method: "POST" });

  const history = await json<
    {
      kind: string;
      fromStageId: string | null;
      toStageId: string | null;
      toStatus: string | null;
      trigger: string;
      actorName: string | null;
      actorEmail: string | null;
      detail: { failedCriteria?: string[] } | null;
    }[]
  >(await app.request(`/api/features/${feature.id}/history`));

  const moves = history.filter((e) => e.kind === "stage_moved");
  assert.equal(moves.length, 2, "entering the first stage and going back are both moves");

  // Entering from the backlog: no origin stage.
  assert.equal(moves[0]!.fromStageId, null);
  assert.equal(moves[0]!.toStageId, stages[0]!.id);
  assert.equal(moves[0]!.trigger, "manual");
  assert.equal(moves[0]!.actorName, "Local User", "a named account is shown as their name");
  assert.equal(moves[0]!.actorEmail, "local@bento.dev");

  // Returning to the backlog: no destination stage, and the direction is
  // readable from the trigger without comparing stage positions.
  assert.equal(moves[1]!.fromStageId, stages[0]!.id);
  assert.equal(moves[1]!.toStageId, null, "returning to the backlog has no destination stage");
  assert.equal(moves[1]!.trigger, "manual_back");

  // The hold was recorded, with the reason.
  const held = history.find((e) => e.kind === "status_changed" && e.toStatus === "gated");
  assert.ok(held, "being held at a gate must appear in the history");
  assert.deepEqual(held.detail?.failedCriteria, ["command"], "the history should say which criterion held it");
  assert.equal(held.actorName, null, "a gate is not a person");

  const plain = await (await app.request(`/api/features/${feature.id}/history/plain`)).text();
  assert.match(plain, /by Local User/, "plain history names the person who moved the card");
  assert.match(plain, /sent back by Local User/);
  assert.match(plain, /by a gate/);

  // The older endpoint still answers, for clients written before this.
  const transitions = await app.request(`/api/features/${feature.id}/transitions`);
  assert.equal(transitions.status, 200);
});

/**
 * The billing surface must not exist here. Local and self-hosted
 * installs load no cloud module, so the routes are absent, the limit
 * checks pass vacuously, and the console's plan card (which probes
 * this endpoint) renders nothing. A regression that mounted billing
 * unconditionally would fail this first.
 */
test("no billing surface exists on a local install", async () => {
  const plan = await app.request("/api/billing/plan");
  assert.equal(plan.status, 404);
  const checkout = await app.request("/api/billing/checkout", { method: "POST" });
  assert.equal(checkout.status, 404);
  assert.equal(ctx.entitlements, undefined, "no plan limits outside a cloud deployment");
});


/**
 * A finished card's sandbox is a machine somebody pays for by the
 * gigabyte month for as long as it exists, whether or not it ever
 * wakes again. Nothing else in this server reclaims one, so this is
 * all that stands between a year of finished cards and a year of
 * storage nobody is using.
 */
test("a finished card's sandbox is destroyed, and only once it is really gone", async () => {
  const { project } = await setupProject("Reaper");
  const feature = await createFeature(project.id, "Card that ends");

  await ctx.db.insert(sandboxes).values({
    projectId: project.id,
    featureId: feature.id,
    provider: "docker",
    externalId: "reaper-box",
    status: "ready",
    workdir: "/workspace",
  });

  const destroyed: string[] = [];
  let stillThere = true;
  const previousDriver = ctx.driver;
  ctx.driver = {
    ...previousDriver,
    async destroy(handle: { externalId: string }) {
      destroyed.push(handle.externalId);
    },
    async exists() {
      return stillThere;
    },
  } as unknown as AppContext["driver"];

  try {
    // A driver that says the machine is still there must not have its
    // row marked destroyed. Believing a failed delete is exactly how a
    // sprite goes on billing with nothing left pointing at it.
    await assert.rejects(() => reapSandbox(ctx, feature.id), /still there/);
    assert.deepEqual(destroyed, ["reaper-box"], "it did try");
    const [afterFailure] = await ctx.db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.featureId, feature.id));
    assert.equal(afterFailure?.status, "ready", "a machine that survived is not recorded as gone");

    stillThere = false;
    await reapSandbox(ctx, feature.id);
    const [afterSuccess] = await ctx.db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.featureId, feature.id));
    assert.equal(afterSuccess?.status, "destroyed");

    // Nothing left to do, and answering rather than throwing is what
    // lets the sweep run over an already tidy deployment.
    await reapSandbox(ctx, feature.id);
  } finally {
    ctx.driver = previousDriver;
  }
});

/**
 * The card is over but an agent is somehow still working it. Killing
 * the machine underneath would leave the branch in a state nobody
 * chose, and skipping quietly would drop the only reference to it, so
 * the job refuses and comes back.
 */
test("a sandbox with a run still working it is not reaped, and is not forgotten either", async () => {
  const { project, stages } = await setupProject("Reaper busy");
  const feature = await createFeature(project.id, "Card still working");
  const profile = await fakeProfile("reaper-busy-agent");
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, stageId: stages[0]!.id }),
    }),
  );
  await ctx.db.insert(sandboxes).values({
    projectId: project.id,
    featureId: feature.id,
    provider: "docker",
    externalId: "busy-box",
    status: "busy",
    workdir: "/workspace",
  });

  let destroyCalls = 0;
  const previousDriver = ctx.driver;
  ctx.driver = {
    ...previousDriver,
    async destroy() {
      destroyCalls += 1;
    },
  } as unknown as AppContext["driver"];
  try {
    await ctx.db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, run.id));
    await assert.rejects(() => reapSandbox(ctx, feature.id), /still working/);
    assert.equal(destroyCalls, 0, "the machine is not touched while an agent is on it");
  } finally {
    ctx.driver = previousDriver;
    await ctx.db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, run.id));
  }
});


/**
 * The metering seam, end to end through the real doors.
 *
 * The open source server knows nothing about hours; what it has is a
 * hook fired when a run ends and a question asked before one starts.
 * A stub standing in for the billing module proves both happen, with
 * the run id the deployment would need and without any billing code
 * present.
 */
test("a finished run is announced once, and the card it belongs to is named at the door", async () => {
  const { project, stages } = await setupProject("Metering");
  const feature = await createFeature(project.id, "Card that costs");
  const profile = await fakeProfile("metering-agent");

  const finished: string[] = [];
  const asked: { organizationId: string; featureId?: string }[] = [];
  ctx.entitlements = {
    async canAddMember() {
      return null;
    },
    async canActivateFeature() {
      return null;
    },
    async canStartRun(organizationId, featureId) {
      asked.push({ organizationId, ...(featureId ? { featureId } : {}) });
      return null;
    },
    async onRunFinished(runId) {
      finished.push(runId);
    },
  };
  try {
    const run = await json<{ id: string }>(
      await app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, stageId: stages[0]!.id }),
      }),
    );

    // Local mode has no organization, so the door has nothing to ask
    // about. What matters is that the card travels when it does: the
    // per card ceiling cannot exist without it.
    assert.equal(asked.length, 0, "no organization, no plan to check");

    await markCancelled(ctx, run.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(finished, [run.id], "the run that ended is the run announced");

    // Cancelling again announces nothing: the terminal write is a
    // compare-and-set, so only the call that actually ended the run
    // speaks. The deployment keys its ledger on the run either way,
    // but "announced once" is now the server's guarantee, not the
    // ledger's cleanup.
    finished.length = 0;
    await markCancelled(ctx, run.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(finished, [], "an already cancelled run is not announced again");
  } finally {
    delete ctx.entitlements;
  }
});

/**
 * Attribution. Compute is pooled across a team, so "who used it all"
 * has to have an answer, and until the column existed it did not.
 */
test("a run records who asked for it", async () => {
  const { project, stages } = await setupProject("Attribution");
  const feature = await createFeature(project.id, "Whose hours");
  const profile = await fakeProfile("attribution-agent");
  const run = await json<{ id: string }>(
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, stageId: stages[0]!.id }),
    }),
  );
  const [row] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  assert.equal(row?.startedBy, ctx.userId, "the person who clicked owns the hours");
});

/**
 * Loop detection: the specific runaway, where a gate that never passes
 * hands the card back to the same agent with nobody in the loop.
 * Starting a run by hand is deliberately unaffected, because the guard
 * is on the automatic door and not on the card.
 */
test("the evaluator stops handing a card to a stage it has already retried", async () => {
  const { project, stages: pipelineStages } = await setupProject("Looping");
  const feature = await createFeature(project.id, "Card going round");
  const profile = await fakeProfile("looping-agent");
  const stage = pipelineStages[0]!;

  // Three runs on this stage already, which is the ceiling.
  for (let i = 0; i < 3; i++) {
    await ctx.db.insert(agentRuns).values({
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "",
      status: "succeeded",
      startedAt: new Date(),
      endedAt: new Date(),
    });
  }
  await ctx.db
    .update(stages)
    .set({ defaultAgentProfileId: profile.id })
    .where(eq(stages.id, stage.id));

  const before = await runCount(feature.id);
  await moveFeatureTo(ctx, feature.id, stage.id, ctx.userId);
  const after = await runCount(feature.id);
  assert.equal(after, before, "a stage that has been round three times is not started again by itself");

  /**
   * Human runs must not trip the guard. Three chat messages in an
   * afternoon each insert a run carrying started_by, and counting them
   * used to silently disable auto hand-off into the stage, the exact
   * opposite of the promise that a person is unaffected.
   */
  const human = await createFeature(project.id, "Card someone talks to");
  for (let i = 0; i < 3; i++) {
    await ctx.db.insert(agentRuns).values({
      featureId: human.id,
      stageId: stage.id,
      agentProfileId: profile.id,
      prompt: "a chat message",
      status: "succeeded",
      startedBy: ctx.userId,
      startedAt: new Date(),
      endedAt: new Date(),
    });
  }
  const humanBefore = await runCount(human.id);
  await moveFeatureTo(ctx, human.id, stage.id, ctx.userId);
  const humanAfter = await runCount(human.id);
  assert.equal(humanAfter, humanBefore + 1, "three human runs do not count as a loop");

  // By hand still works: a person looking at the card is the thing the
  // guard was protecting, not the thing it was blocking.
  const byHand = await app.request(`/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, stageId: stage.id }),
  });
  assert.equal(byHand.status, 201, "a person can always start it themselves");
});

test("a move that cannot be recorded does not happen", async () => {
  const { project } = await setupProject("Atomic advance");
  const feature = await createFeature(project.id, "Stay put");

  /**
   * actor_user_id is a foreign key, so a stranger's id fails the history
   * insert while the stage update on its own would have succeeded. The
   * two share a transaction, so neither lands: before they did, this
   * left a card sitting on a stage with nothing saying how it got there.
   */
  await assert.rejects(() => advanceFeature(ctx, feature.id, "manual", "no-such-user", null));

  const [row] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(row?.currentStageId, null, "the card must still be in the backlog");
  const history = await ctx.db
    .select({ id: featureEvents.id })
    .from(featureEvents)
    .where(eq(featureEvents.featureId, feature.id));
  assert.deepEqual(history, [], "a move that did not happen writes no history");
});

/**
 * Puts a card on a stage without going through advanceFeature, which
 * would queue a gate job. These tests call evaluateFeatureGate
 * themselves, so a job racing them would write the hold they are
 * trying to control.
 */
async function placeOnStage(featureId: string, stageId: string) {
  await ctx.db
    .update(features)
    .set({ status: "active", currentStageId: stageId, updatedAt: new Date() })
    .where(eq(features.id, featureId));
}

test("a failed gate holds the card, writes the reason, and records history", async () => {
  const { project, stages } = await setupProject("Failed gate hold");
  const feature = await createFeature(project.id, "Hold me");
  const stage = stages[0]!;
  const profile = await fakeProfile("failed-gate-hold");
  await patchStage(stage.id, { gateType: "auto", gateCriteria: [{ type: "run_succeeded" }] });
  await placeOnStage(feature.id, stage.id);
  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: profile.id,
    prompt: "work",
    status: "failed",
    executor: "server",
    error: "the agent failed",
  });

  await evaluateFeatureGate(ctx, feature.id);

  const [row] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(row?.status, "gated");
  assert.equal(row?.currentStageId, stage.id, "the card stays on the stage that failed");

  const checks = await ctx.db
    .select({ status: gateChecks.status, criterion: gateChecks.criterion })
    .from(gateChecks)
    .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, stage.id)));
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "failed");
  assert.equal((checks[0]?.criterion as { type?: string } | null)?.type, "run_succeeded");

  const history = await ctx.db
    .select()
    .from(featureEvents)
    .where(eq(featureEvents.featureId, feature.id));
  const held = history.find((e) => e.kind === "status_changed" && e.toStatus === "gated");
  assert.ok(held, "the hold must appear in the history");
  assert.deepEqual((held.detail as { failedCriteria?: string[] } | null)?.failedCriteria, ["run_succeeded"]);
});

test("a late failed gate does not drag a finished card back to gated", async () => {
  const { project, stages } = await setupProject("Late gate vs done");
  const feature = await createFeature(project.id, "Already finished");
  const stage = stages[0]!;
  const profile = await fakeProfile("late-gate-done");
  /**
   * Sleeps inside evaluateGate so finishFeature can commit after this
   * evaluation has already read the card as active, and before it
   * writes gated. The early "feature is done" return would not be
   * the race; this is.
   */
  await patchStage(stage.id, {
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "sleep 2; exit 1", timeoutSec: 30 }],
  });
  await placeOnStage(feature.id, stage.id);
  await ctx.db.insert(sandboxes).values({
    projectId: project.id,
    featureId: feature.id,
    provider: "docker",
    externalId: "late-gate-done",
    status: "ready",
    workdir: path.dirname(repoDir),
  });
  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: profile.id,
    prompt: "work",
    status: "succeeded",
    executor: "server",
  });

  const evaluation = evaluateFeatureGate(ctx, feature.id);
  await new Promise((r) => setTimeout(r, 400));
  await finishFeature(ctx, feature.id, ctx.userId);
  await evaluation;

  const [row] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(row?.status, "done", "a late gate must not drag a finished card back to gated");
  const held = await ctx.db
    .select({ id: featureEvents.id })
    .from(featureEvents)
    .where(and(eq(featureEvents.featureId, feature.id), eq(featureEvents.toStatus, "gated")));
  assert.deepEqual(held, [], "a hold that did not happen writes no history");
});

test("a late failed gate does not hold a card that has already left the stage", async () => {
  const { project, stages } = await setupProject("Late gate vs move");
  const feature = await createFeature(project.id, "Already moved");
  const stage = stages[0]!;
  const next = stages[1]!;
  const profile = await fakeProfile("late-gate-move");
  await patchStage(stage.id, {
    gateType: "auto",
    gateCriteria: [{ type: "command", cmd: "sleep 2; exit 1", timeoutSec: 30 }],
  });
  await placeOnStage(feature.id, stage.id);
  await ctx.db.insert(sandboxes).values({
    projectId: project.id,
    featureId: feature.id,
    provider: "docker",
    externalId: "late-gate-move",
    status: "ready",
    workdir: path.dirname(repoDir),
  });
  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: profile.id,
    prompt: "work",
    status: "succeeded",
    executor: "server",
  });

  const evaluation = evaluateFeatureGate(ctx, feature.id);
  await new Promise((r) => setTimeout(r, 400));
  /**
   * A concurrent move, written directly so the destination stage does
   * not start its own evaluation and hold the card for a different
   * reason. The question is whether THIS evaluation still writes.
   */
  await ctx.db
    .update(features)
    .set({ status: "active", currentStageId: next.id, updatedAt: new Date() })
    .where(eq(features.id, feature.id));
  await evaluation;

  const [row] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
  assert.equal(row?.currentStageId, next.id, "the card stays on the stage it was moved to");
  assert.equal(row?.status, "active", "a failure about the previous stage must not gate it");
  const held = await ctx.db
    .select({ id: featureEvents.id })
    .from(featureEvents)
    .where(and(eq(featureEvents.featureId, feature.id), eq(featureEvents.toStatus, "gated")));
  assert.deepEqual(held, [], "a hold that did not happen writes no history");
});

test("a hold that cannot be recorded does not happen", async () => {
  const { project, stages } = await setupProject("Atomic hold");
  const feature = await createFeature(project.id, "Stay active");
  const stage = stages[0]!;
  const profile = await fakeProfile("atomic-hold");
  await patchStage(stage.id, { gateType: "auto", gateCriteria: [{ type: "run_succeeded" }] });
  await placeOnStage(feature.id, stage.id);
  await ctx.db.insert(agentRuns).values({
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: profile.id,
    prompt: "work",
    status: "failed",
    executor: "server",
    error: "the agent failed",
  });

  /**
   * The history insert fails while the status update and the check
   * rows on their own would have succeeded. They share a transaction,
   * so none of them land: before they did, this left failed checks on
   * a card that was still active, with nothing saying it was held.
   */
  await ctx.db.execute(sql`
    create or replace function bento_test_reject_feature_events() returns trigger as $$
    begin
      raise exception 'test: history insert rejected';
    end;
    $$ language plpgsql
  `);
  await ctx.db.execute(sql`
    create trigger bento_test_reject_feature_events
    before insert on feature_events
    for each row execute function bento_test_reject_feature_events()
  `);
  try {
    await assert.rejects(() => evaluateFeatureGate(ctx, feature.id));

    const [row] = await ctx.db.select().from(features).where(eq(features.id, feature.id));
    assert.equal(row?.status, "active", "the card must still be active");
    assert.equal(row?.currentStageId, stage.id);
    const checks = await ctx.db
      .select({ id: gateChecks.id })
      .from(gateChecks)
      .where(eq(gateChecks.featureId, feature.id));
    assert.deepEqual(checks, [], "a hold that did not happen writes no checks");
    const history = await ctx.db
      .select({ id: featureEvents.id })
      .from(featureEvents)
      .where(eq(featureEvents.featureId, feature.id));
    assert.deepEqual(history, [], "a hold that did not happen writes no history");
  } finally {
    await ctx.db.execute(sql`drop trigger if exists bento_test_reject_feature_events on feature_events`);
    await ctx.db.execute(sql`drop function if exists bento_test_reject_feature_events()`);
  }
});

async function runCount(featureId: string): Promise<number> {
  const rows = await ctx.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.featureId, featureId));
  return rows.length;
}
