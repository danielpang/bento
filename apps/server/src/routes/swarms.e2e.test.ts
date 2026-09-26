import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { asc, eq } from "drizzle-orm";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  projects,
  runMigrations,
  sandboxes,
  repositories,
  runArtifacts,
  swarmLandings,
  swarmMessages,
  swarmTaskEvents,
  swarmTasks,
  swarmTemplates,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager, type SandboxHandle } from "@bento/sandbox";
import { createApp } from "../app.js";
import { DiskArtifactStore } from "../artifact-store.js";
import { SecretBox } from "../secrets.js";
import { ensureLocalUser, type AppContext, type Entitlements } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { createFeatureFlags } from "../feature-flags.js";
import { mintRunGrant } from "../mcp/grants.js";
import { tickSwarm } from "../orchestrator/swarm/coordinator.js";
import { takeNodeMessages } from "../orchestrator/swarm/node-messages.js";
import { BENTO_SWARM_SERVER_ID } from "../mcp/swarm-server.js";
import { archiveReapsSandboxes, checkpointSwarmSandboxes } from "../orchestrator/swarm/archive.js";
import { RUNNER_PROJECT_REFUSAL } from "./swarms.js";

/**
 * The swarm routes, driven as a client drives them.
 *
 * Local mode, because that is where both gates collapse and the routes
 * themselves are what is being checked; the foreign tenant refusals are
 * in auth.e2e.test.ts's matrix, where there are two tenants to refuse
 * between.
 */
const run = promisify(execFile);
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_routes_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let db: Db;
let projectId: string;
/** The project's repository on disk, for the route that reads git. */
let repoDir: string;
/** Jobs the routes queued, instead of a real pg-boss. */
let queued: { queue: string; data: unknown; options?: unknown }[];
/** Every statement the pool ran, so a stream can be held to its budget. */
let statements: string[];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  repoDir = await mkdtemp(path.join(tmpdir(), "bento-swarm-repo-"));
  await run("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", ["-C", repoDir, "-c", "user.email=t@b.dev", "-c", "user.name=t", "commit", "-qm", "init"]);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-swarm-data-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  statements = [];
  const query = pool.query.bind(pool);
  // Counted rather than mocked: the streams rule is about how many
  // statements a stream runs, and only the pool knows.
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    statements.push(typeof first === "string" ? first : String((first as { text?: string })?.text ?? ""));
    return (query as (...a: unknown[]) => unknown)(...args);
  };
  db = createDb(pool);
  const userId = await ensureLocalUser(db);
  queued = [];

  ctx = {
    env,
    db,
    pool,
    boss: {
      send: async (queue: string, data: unknown, options?: unknown) => {
        queued.push({ queue, data, options });
        return "job";
      },
      // The tick door starts the reconciler's worker before it queues
      // the job, so a deployment with no swarms registers none.
      createQueue: async () => {},
      work: async () => "worker",
      offWork: async () => {},
      schedule: async () => {},
      unschedule: async () => {},
      notifyWorker: () => {},
    } as unknown as AppContext["boss"],
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
  app = createApp(ctx);

  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, name: "Swarms", defaultBranch: "main" })
    .returning();
  projectId = project!.id;
});

after(async () => {
  await ctx.pool.end();
});

beforeEach(async () => {
  await db.delete(sandboxes);
  await db.delete(swarms);
  await db.update(projects).set({ executor: "server" }).where(eq(projects.id, projectId));
  ctx.running.clear();
  queued = [];
  statements.length = 0;
});

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const patch = (path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function createSwarm(overrides: Record<string, unknown> = {}) {
  const res = await post("/api/swarms", { projectId, title: "Rewrite checkout", goal: "make it work", ...overrides });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; slug: string; status: string; branchName: string; plannerRunId: string };
}

/**
 * The swarm's planner, as it is once its agent is actually away: the
 * row in the running status, this process holding its abort handle, and
 * its sandbox holding a gateway token for Bento's own swarm tools.
 */
async function plannerAtWork(swarmId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.swarmId, swarmId));
  await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, run!.id));
  const controller = new AbortController();
  ctx.running.set(run!.id, controller);
  const token = await mintRunGrant(ctx, {
    runId: run!.id,
    organizationId: null,
    actingUserId: ctx.userId,
    serverIds: [BENTO_SWARM_SERVER_ID],
    swarmId,
    ttlMs: 60_000,
  });
  return { run: run!, controller, token };
}

/**
 * One tool call, made the way the agent makes it: through the gateway,
 * with the run's bearer token and nothing else. A dead grant is a 404
 * there, the same answer as a token that never existed.
 */
async function callSwarmTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/api/mcp-gateway/${BENTO_SWARM_SERVER_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return res.status;
}

const tasksOf = async (swarmId: string) =>
  await db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarmId));

/* ---------------------------------------------------------------- */

test("creating a swarm plans it, and puts a planner to work at once", async () => {
  const swarm = await createSwarm();
  assert.equal(swarm.status, "planning");
  assert.equal(swarm.slug, "rewrite-checkout");
  assert.equal(swarm.branchName, "swarm/rewrite-checkout", "the branch is legible in a repository");

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.swarmId, swarm.id));
  assert.equal(run!.role, "planner");
  assert.equal(run!.type, "swarm");
  assert.equal(run!.status, "queued");
  assert.equal(run!.prompt, "", "the opening prompt is built where the checkout paths are known");
  assert.equal(swarm.plannerRunId, run!.id);
  assert.ok(
    queued.some((job) => job.queue === "run.execute" && (job.data as { runId: string }).runId === run!.id),
    "and it was queued for a worker",
  );

  // A seeded template and its two agents came with it, editable like
  // any other.
  const templates = (await (await app.request("/api/swarm-templates")).json()) as {
    name: string;
    plannerProfileId: string | null;
    workerProfileId: string | null;
  }[];
  assert.equal(templates.length, 1);
  assert.equal(templates[0]!.name, "Default");
  assert.ok(templates[0]!.plannerProfileId, "with a planner");
  assert.ok(templates[0]!.workerProfileId, "and a worker");

  // A second swarm of the same name takes a readable suffix rather
  // than a random one.
  const second = await createSwarm();
  assert.equal(second.slug, "rewrite-checkout-2");
});

test("a project whose agents run on the team's own machines cannot run a swarm", async () => {
  await db.update(projects).set({ executor: "runner" }).where(eq(projects.id, projectId));
  const res = await post("/api/swarms", { projectId, title: "Nope" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "RUNNER_PROJECT");
  assert.equal(body.error, RUNNER_PROJECT_REFUSAL);
  assert.match(body.error, /merge queue/, "the reason is in the response, not just a refusal");
  assert.equal((await db.select().from(swarms)).length, 0, "and nothing was created");
});

test("work starts only once there is a plan to work", async () => {
  const swarm = await createSwarm();
  const empty = await post(`/api/swarms/${swarm.id}/start`);
  assert.equal(empty.status, 409);
  assert.equal(((await empty.json()) as { code: string }).code, "NO_PLAN");
  assert.equal((await readSwarm(swarm.id)).status, "planning", "and the swarm did not move");

  await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Cart page" });
  queued.length = 0;
  const started = await post(`/api/swarms/${swarm.id}/start`);
  assert.equal(started.status, 200);
  assert.equal(((await started.json()) as { status: string }).status, "running");
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "and the reconciler was told, so a worker can be put on the plan",
  );

  // A cancelled node is not a plan.
  const other = await createSwarm({ title: "Other" });
  await db.insert(swarmTasks).values({ swarmId: other.id, title: "withdrawn", status: "cancelled" });
  assert.equal((await post(`/api/swarms/${other.id}/start`)).status, 409);
});

test("the swarm reads back with its plan, and the strip reads back with its numbers", async () => {
  const swarm = await createSwarm();
  const [group] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, nodeType: "plan", title: "Checkout", position: 0 })
    .returning();
  await db.insert(swarmTasks).values([
    { swarmId: swarm.id, parentId: group!.id, title: "Cart page", status: "done", position: 0 },
    { swarmId: swarm.id, parentId: group!.id, title: "Payment", status: "blocked", attention: "question", position: 1 },
  ]);

  const detail = (await (await app.request(`/api/swarms/${swarm.id}`)).json()) as {
    swarm: { id: string; title: string };
    tasks: { id: string; parentId: string | null; title: string; status: string }[];
    activeRuns: { role: string; status: string }[];
  };
  assert.equal(detail.swarm.id, swarm.id);
  assert.equal(detail.tasks.length, 3, "the whole tree, flat, each node naming its parent");
  assert.equal(detail.tasks.filter((task) => task.parentId === group!.id).length, 2);
  assert.deepEqual(
    detail.activeRuns.map((r) => `${r.role}:${r.status}`),
    ["planner:queued"],
    "and what is working right now",
  );

  const strip = (await (await app.request(`/api/swarms?projectId=${projectId}`)).json()) as {
    id: string;
    counts: { tasks: number; done: number; attention: number };
  }[];
  assert.equal(strip.length, 1);
  assert.deepEqual(strip[0]!.counts, { tasks: 3, done: 1, attention: 1 });

  // A project that is not there is not a filter, it is a 404.
  assert.equal((await app.request("/api/swarms?projectId=11111111-1111-1111-1111-111111111111")).status, 404);
});

test("the detail carries the merge queue, the queue first and in its own order", async () => {
  const swarm = await createSwarm();
  const [first] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title: "landed one", status: "done", position: 0 })
    .returning();
  const [second] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title: "stuck one", status: "working", position: 1 })
    .returning();
  const [third] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title: "behind it", status: "done", position: 2 })
    .returning();
  await db.insert(swarmLandings).values([
    { swarmId: swarm.id, taskId: third!.id, branchName: "swarm/s-3", position: 2, status: "queued" },
    { swarmId: swarm.id, taskId: second!.id, branchName: "swarm/s-2", position: 1, status: "conflicted", attempt: 2, error: "CONFLICT (content): both changed one file" },
    { swarmId: swarm.id, taskId: first!.id, branchName: "swarm/s-1", position: 0, status: "landed", attempt: 1, endedAt: new Date() },
  ]);

  const detail = (await (await app.request(`/api/swarms/${swarm.id}`)).json()) as {
    landings: { taskId: string; status: string; attempt: number; error: string | null; branchName: string | null }[];
  };
  assert.equal(detail.landings.length, 3);
  assert.deepEqual(
    detail.landings.map((row) => row.taskId),
    [second!.id, third!.id, first!.id],
    "what has not finished, in the queue's own order, and then the history behind it",
  );
  assert.equal(detail.landings[0]!.status, "conflicted", "the server's own word, not a translation of it");
  assert.equal(detail.landings[0]!.attempt, 2);
  assert.match(detail.landings[0]!.error ?? "", /both changed one file/);
  assert.equal(detail.landings[2]!.branchName, "swarm/s-1");
});

test("the merge queue is still visible on a swarm with more landings than the cap", async () => {
  /**
   * A long swarm, which is the shape that made this blind.
   *
   * position is monotonic per acceptance, so one capped query ordered
   * by position hands back the oldest rows: a swarm on its twenty first
   * leaf sent twenty landings that had already finished and left out
   * the branch that was actually landing and the conflict somebody
   * opened the panel to find. The panel then drew "one branch at a
   * time" over a queue whose front it could not see.
   */
  const swarm = await createSwarm();
  for (let index = 0; index < 22; index += 1) {
    const [task] = await db
      .insert(swarmTasks)
      .values({ swarmId: swarm.id, title: `leaf ${index}`, status: "done", position: index })
      .returning();
    await db.insert(swarmLandings).values({
      swarmId: swarm.id,
      taskId: task!.id,
      branchName: `swarm/s-${index}`,
      position: index,
      status: index < 20 ? "landed" : index === 20 ? "conflicted" : "queued",
      attempt: 1,
      ...(index < 20 ? { endedAt: new Date(2026, 0, 1, index) } : {}),
      ...(index === 20 ? { error: "CONFLICT (content): both changed one file" } : {}),
    });
  }

  const detail = (await (await app.request(`/api/swarms/${swarm.id}`)).json()) as {
    landings: { status: string; branchName: string | null; error: string | null }[];
  };
  const byStatus = (status: string) => detail.landings.filter((row) => row.status === status);
  assert.equal(byStatus("conflicted").length, 1, "the row the whole queue is waiting on");
  assert.equal(byStatus("conflicted")[0]!.branchName, "swarm/s-20");
  assert.equal(byStatus("queued").length, 1, "and what is behind it");
  assert.equal(byStatus("landed").length, 10, "with the history capped rather than filling the answer");
  assert.ok(detail.landings.length <= 30, "and the whole thing still bounded");
});

test("pausing and resuming are a person's, and resuming wakes the reconciler", async () => {
  const swarm = await createSwarm();
  await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Cart page" });
  assert.equal((await post(`/api/swarms/${swarm.id}/pause`)).status, 200);
  const paused = await readSwarm(swarm.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedReason, "manual", "so the board knows which sentence to print");

  queued.length = 0;
  assert.equal((await post(`/api/swarms/${swarm.id}/start`)).status, 200);
  const resumed = await readSwarm(swarm.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.pausedReason, null);
  assert.ok(queued.some((job) => job.queue === "swarm.tick"), "leaves waiting for a slot are looked at again");

  // The ceilings a person sets, and a budget cleared rather than zeroed.
  await patch(`/api/swarms/${swarm.id}`, { maxWorkers: 7, budgetUsd: 12.5 });
  assert.equal((await readSwarm(swarm.id)).maxWorkers, 7);
  assert.equal(Number((await readSwarm(swarm.id)).budgetUsd), 12.5);
  await patch(`/api/swarms/${swarm.id}`, { budgetUsd: null });
  assert.equal((await readSwarm(swarm.id)).budgetUsd, null);
});

/**
 * Stopping a swarm stops its agents, which is the whole of what the
 * button means.
 *
 * Setting the swarm's status and leaving the runs alone was cosmetic:
 * the planner kept working, kept calling these tools on a plan the
 * person had already stopped, and kept spending. So the assertion here
 * is not that a row changed but that the agent can no longer act.
 */
test("cancelling a swarm stops the agents working in it, and their tools with them", async () => {
  const swarm = await createSwarm();
  const { run, controller, token } = await plannerAtWork(swarm.id);

  assert.equal(await callSwarmTool(token, "create_task", { title: "before" }), 200);
  assert.equal((await tasksOf(swarm.id)).length, 1, "the planner could act while the swarm was running");

  // A run that ended before the stop is somebody else's ending.
  const endedAt = new Date("2026-01-01T00:00:00.000Z");
  const [finished] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      role: "worker",
      agentProfileId: run.agentProfileId,
      prompt: "",
      status: "succeeded",
      endedAt,
    })
    .returning();

  assert.equal((await post(`/api/swarms/${swarm.id}/cancel`)).status, 200);
  assert.equal((await readSwarm(swarm.id)).status, "cancelled");

  const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  assert.equal(stopped!.status, "cancelled", "the run the person stopped is stopped");
  assert.ok(stopped!.endedAt, "and it has an ending, so nothing counts it as still working");
  assert.ok(controller.signal.aborted, "the agent was interrupted where it was, not left to finish");

  assert.equal(
    await callSwarmTool(token, "create_task", { title: "after the stop" }),
    404,
    "and the token in its sandbox opens nothing",
  );
  assert.equal((await tasksOf(swarm.id)).length, 1, "so nothing it asked for after the stop happened");

  const [untouched] = await db.select().from(agentRuns).where(eq(agentRuns.id, finished!.id));
  assert.equal(untouched!.status, "succeeded", "a run that had already ended is not re-ended");
  assert.equal(untouched!.endedAt?.getTime(), endedAt.getTime(), "and its ending did not move");
});

/**
 * Pausing is the other decision, and it is deliberately the gentler
 * one: a worker mid task finishes and reports. Pinned here because the
 * cancel above is a stop, and the two must not converge by accident.
 */
test("pausing lets the agent in flight finish", async () => {
  const swarm = await createSwarm();
  const { run, controller, token } = await plannerAtWork(swarm.id);

  assert.equal((await post(`/api/swarms/${swarm.id}/pause`)).status, 200);
  const [still] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  assert.equal(still!.status, "running", "the agent keeps its turn");
  assert.equal(controller.signal.aborted, false, "nothing interrupted it");
  assert.equal(await callSwarmTool(token, "create_task", { title: "finishing up" }), 200, "and it can still report");
});

/** A queue nothing will ever serve is not a queue, it is a lie. */
test("a cancelled swarm's landings are not left queued", async () => {
  const swarm = await createSwarm();
  const [a, b, c, d] = await db
    .insert(swarmTasks)
    .values([
      { swarmId: swarm.id, title: "Cart", position: 0 },
      { swarmId: swarm.id, title: "Payment", position: 1 },
      { swarmId: swarm.id, title: "Receipts", position: 2 },
      { swarmId: swarm.id, title: "Emails", position: 3 },
    ])
    .returning();
  await db.insert(swarmLandings).values([
    { swarmId: swarm.id, taskId: a!.id, position: 0, status: "landed" },
    { swarmId: swarm.id, taskId: b!.id, position: 1, status: "conflicted" },
    { swarmId: swarm.id, taskId: c!.id, position: 2, status: "queued" },
    { swarmId: swarm.id, taskId: d!.id, position: 3, status: "queued" },
  ]);

  assert.equal((await post(`/api/swarms/${swarm.id}/cancel`)).status, 200);

  const landings = await db.select().from(swarmLandings).where(eq(swarmLandings.swarmId, swarm.id));
  const byTask = new Map(landings.map((row) => [row.taskId, row]));
  assert.equal(byTask.get(c!.id)!.status, "cancelled", "a branch waiting its turn waits for nothing now");
  assert.equal(byTask.get(d!.id)!.status, "cancelled");
  assert.ok(byTask.get(c!.id)!.endedAt, "and each says when it stopped");
  assert.equal(
    byTask.get(b!.id)!.status,
    "cancelled",
    "a conflict nobody will resolve is over too",
  );
  assert.equal(byTask.get(a!.id)!.status, "landed", "and what already landed keeps its ending");
});

/**
 * Deletion refuses while agents are working (the run would keep going
 * in its sandbox with nothing left to report to), so the way to delete
 * a live swarm is to stop it first. That only works if stopping it
 * really stops the runs, which is what this walks: cancel, then delete.
 */
test("a stopped swarm can then be deleted, agents and all", async () => {
  const swarm = await createSwarm();
  await plannerAtWork(swarm.id);

  const busy = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  assert.equal(busy.status, 409, "not while an agent is working");

  assert.equal((await post(`/api/swarms/${swarm.id}/cancel`)).status, 200);
  const gone = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  assert.equal(gone.status, 200, await gone.clone().text());
  assert.equal((await db.select().from(swarms).where(eq(swarms.id, swarm.id))).length, 0);
});

/**
 * Where a swarm is in its life is not a field a client sets.
 *
 * Every rule about it (a plan to start, and refusing a swarm that is
 * over) lives on the lifecycle routes, so a status accepted on the
 * general update would be a second door past all of them: PATCH
 * {status: "running"} used to resurrect a stopped swarm and set the
 * reconciler going on it again.
 */
test("status and the original goal cannot be patched onto a swarm", async () => {
  const swarm = await createSwarm();
  await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Cart page" });
  assert.equal((await post(`/api/swarms/${swarm.id}/cancel`)).status, 200);
  assert.equal((await readSwarm(swarm.id)).status, "cancelled");

  queued.length = 0;
  const patched = await patch(`/api/swarms/${swarm.id}`, { status: "running", title: "Renamed" });
  assert.equal(patched.status, 400, "the status is not a field this route takes");
  const after = await readSwarm(swarm.id);
  assert.equal(after.status, "cancelled", "a stopped swarm stays stopped");
  assert.equal(after.title, "Rewrite checkout", "and a refused body changes nothing else either");
  assert.deepEqual(queued, [], "nothing was set going again");

  const changedGoal = await patch(`/api/swarms/${swarm.id}`, {
    goal: "quietly turn this into different work",
  });
  assert.equal(changedGoal.status, 400, "follow-up work goes through reopen instead");
  assert.equal((await readSwarm(swarm.id)).goal, "make it work", "the request the swarm was created from is history");

  // The door that does move a swarm keeps its own refusals.
  const restarted = await post(`/api/swarms/${swarm.id}/start`);
  assert.equal(restarted.status, 409);
  assert.match(((await restarted.json()) as { error: string }).error, /cancelled/);
  assert.equal((await post(`/api/swarms/${swarm.id}/pause`)).status, 409, "nor is there anything to pause");

  // A rename is still a rename.
  assert.equal((await patch(`/api/swarms/${swarm.id}`, { title: "Renamed" })).status, 200);
  assert.equal((await readSwarm(swarm.id)).title, "Renamed");
});

test("a message waits for the planner rather than starting a second one", async () => {
  const swarm = await createSwarm();
  await db.update(swarms).set({ pausedReason: "attention" }).where(eq(swarms.id, swarm.id));
  queued.length = 0;

  const sent = await post(`/api/swarms/${swarm.id}/messages`, { text: "use Stripe" });
  assert.equal(sent.status, 201);
  const message = (await sent.json()) as { text: string; status: string; taskId: string | null };
  assert.equal(message.status, "queued", "the coordinator folds it into the next wake");
  assert.equal(message.taskId, null, "no task named means the plan itself");
  assert.equal(
    (await readSwarm(swarm.id)).pausedReason,
    null,
    "an answer is what a swarm waiting on a question was waiting for",
  );
  assert.ok(queued.some((job) => job.queue === "swarm.tick"));

  const listed = (await (await app.request(`/api/swarms/${swarm.id}/messages`)).json()) as { text: string }[];
  assert.deepEqual(listed.map((row) => row.text), ["use Stripe"]);

  // A task from another swarm is not this swarm's to address.
  const other = await createSwarm({ title: "Other" });
  const [foreign] = await db.insert(swarmTasks).values({ swarmId: other.id, title: "theirs" }).returning();
  const refused = await post(`/api/swarms/${swarm.id}/messages`, { text: "hi", taskId: foreign!.id });
  assert.equal(refused.status, 404);
});

test("a swarm with agents working is not deleted out from under them", async () => {
  const swarm = await createSwarm();
  const busy = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  assert.equal(busy.status, 409);
  assert.match(((await busy.json()) as { error: string }).error, /Agents are working/);
  assert.ok(await readSwarm(swarm.id), "still there");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));
  const gone = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.equal((await db.select().from(swarms).where(eq(swarms.id, swarm.id))).length, 0);
});

test("deleting a swarm takes its machines with it", async () => {
  const swarm = await createSwarm();
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));

  // The swarm's own machine, and one a worker was given for a leaf.
  const [leaf] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Cart" }).returning();
  await db.insert(sandboxes).values([
    { projectId, swarmId: swarm.id, provider: "docker", externalId: "bento-swarm-1", status: "ready" },
    {
      projectId,
      swarmId: swarm.id,
      swarmTaskId: leaf!.id,
      provider: "docker",
      externalId: "bento-swarm-1-leaf",
      status: "ready",
    },
  ]);

  const destroyed: string[] = [];
  const realDestroy = ctx.driver.destroy.bind(ctx.driver);
  ctx.driver.destroy = async (handle: SandboxHandle) => void destroyed.push(handle.externalId);

  const gone = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  ctx.driver.destroy = realDestroy;
  assert.equal(gone.status, 200, await gone.clone().text());
  assert.deepEqual(
    [...destroyed].sort(),
    ["bento-swarm-1", "bento-swarm-1-leaf"],
    "every machine the swarm held was destroyed, not just the first",
  );
  assert.equal(
    (await db.select().from(sandboxes)).length,
    0,
    "and no row is left pointing at a machine that is gone",
  );
});

test("a machine that will not go stops the delete rather than being abandoned", async () => {
  const swarm = await createSwarm();
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));
  await db
    .insert(sandboxes)
    .values({ projectId, swarmId: swarm.id, provider: "docker", externalId: "bento-stuck", status: "ready" });

  const realDestroy = ctx.driver.destroy.bind(ctx.driver);
  ctx.driver.destroy = async () => {
    throw new Error("fly said no");
  };
  const refused = await app.request(`/api/swarms/${swarm.id}`, { method: "DELETE" });
  ctx.driver.destroy = realDestroy;
  assert.equal(refused.status, 502);
  assert.match(((await refused.json()) as { error: string }).error, /fly said no/);
  assert.ok(await readSwarm(swarm.id), "the swarm is still there to try again from");
  assert.equal((await db.select().from(sandboxes)).length, 1, "and its machine is still named by a row");
});

test("the stream queries at setup and then never again", async () => {
  const swarm = await createSwarm();
  statements.length = 0;

  const controller = new AbortController();
  const response = await app.request(`/api/swarms/${swarm.id}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  /**
   * Three reads, and no more: the swarm, the project it hangs off
   * (together the access check), and the caller's address for the beta
   * gate. Pinned exactly, because the number that matters is what
   * happens after: a stream that queried anything on a timer would hold
   * a pooled connection for the length of a swarm, which is what the
   * card stream was fixed for.
   */
  const setup = statements.filter((sql) => /select/i.test(sql)).length;
  assert.equal(setup, 3, `the stream ran ${setup} statements at setup, not 3:\n${statements.join("\n")}`);

  // Events reach it off the bus, and cost nothing.
  ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId, swarmId: swarm.id, status: "running" });
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /event: swarm_event/);
  assert.match(first, /"status":"running"/);

  // Another swarm's event is not this stream's business.
  ctx.bus.emitBoardEvent({
    type: "swarm_task_updated",
    projectId,
    swarmId: "99999999-9999-9999-9999-999999999999",
    status: "working",
  });
  ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId, swarmId: swarm.id, status: "blocked" });
  const second = decoder.decode((await reader.read()).value);
  assert.match(second, /"status":"blocked"/);
  assert.doesNotMatch(second, /99999999/);

  assert.equal(
    statements.filter((sql) => /select/i.test(sql)).length,
    setup,
    "and not one query since the stream opened",
  );
  controller.abort();
  await reader.cancel().catch(() => {});
});

/* ---------------------------------------------------------------- *
 * Finishing a leaf by hand.                                        *
 * ---------------------------------------------------------------- */

/**
 * A plan node over two leaves, which is the smallest tree where a
 * rollup is visible: finishing both children has to move the parent,
 * and finishing one must not.
 */
async function treeOf(swarmId: string) {
  const [plan] = await db
    .insert(swarmTasks)
    .values({ swarmId, title: "Build it", nodeType: "plan" })
    .returning();
  const [first] = await db
    .insert(swarmTasks)
    .values({ swarmId, parentId: plan!.id, title: "First", nodeType: "leaf", position: 0 })
    .returning();
  const [second] = await db
    .insert(swarmTasks)
    .values({ swarmId, parentId: plan!.id, title: "Second", nodeType: "leaf", position: 1 })
    .returning();
  return { plan: plan!, first: first!, second: second! };
}

const readTask = async (id: string) => {
  const [row] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, id));
  return row!;
};

test("a leaf a person marks done is done, and the node above it follows when its last child is", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).status, "done");

  // The route writes the leaf and queues the rollup rather than doing
  // it inline: one place decides what a finished leaf means above it.
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "and the reconciler was woken to roll it up",
  );

  await tickSwarm(ctx, swarm.id);
  assert.notEqual((await readTask(tree.plan.id)).status, "done", "one of two children is not the group");

  await post(`/api/swarms/${swarm.id}/tasks/${tree.second.id}/done`);
  await tickSwarm(ctx, swarm.id);
  assert.equal(
    (await readTask(tree.plan.id)).status,
    "done",
    "a group whose children are all finished is finished, which is the ring moving",
  );
});

test("marking a leaf done stops the agent still working it", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const [planner] = await db.select().from(agentRuns).where(eq(agentRuns.swarmId, swarm.id));

  const [worker] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: tree.first.id,
      role: "worker",
      agentProfileId: planner!.agentProfileId,
      prompt: "work the leaf",
      status: "running",
      startedBy: ctx.userId,
    })
    .returning();
  const controller = new AbortController();
  ctx.running.set(worker!.id, controller);
  await db.update(swarmTasks).set({ assignedRunId: worker!.id, status: "working" }).where(eq(swarmTasks.id, tree.first.id));

  await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);

  const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, worker!.id));
  assert.equal(after!.status, "cancelled", "an agent working a task the board calls done is spending for nobody");
  assert.equal(controller.signal.aborted, true, "and it was interrupted, not only marked");
  // The task keeps no pointer at a run that is over: the drawer reads
  // this to decide whether anything is on the node.
  assert.equal((await readTask(tree.first.id)).assignedRunId, null);
});

test("a plan node is not a person's to finish directly", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.plan.id}/done`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "NOT_A_LEAF");
  assert.notEqual((await readTask(tree.plan.id)).status, "done", "its subtree would have been left open under it");
});

test("a leaf of another swarm is not this swarm's to finish", async () => {
  const mine = await createSwarm();
  const theirs = await createSwarm({ title: "Theirs" });
  const tree = await treeOf(theirs.id);

  const res = await post(`/api/swarms/${mine.id}/tasks/${tree.first.id}/done`);
  assert.equal(res.status, 404, "a task is reached through the swarm that owns it, or not at all");
  assert.notEqual((await readTask(tree.first.id)).status, "done");
});

test("finishing a leaf twice is not an error the second time", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);
  const again = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);
  assert.equal(again.status, 200, "a second click, or a second person in the drawer, got what they wanted");
  assert.equal((await again.json()).status, "done");
});

test("a stopped swarm's leaves are not moved by hand", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await post(`/api/swarms/${swarm.id}/cancel`);

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "SWARM_STOPPED");
});

test("a leaf wanting attention stops wanting it once it is finished", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await db.update(swarmTasks).set({ attention: "failed" }).where(eq(swarmTasks.id, tree.first.id));

  await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/done`);
  assert.equal(
    (await readTask(tree.first.id)).attention,
    null,
    "a finished node left lit is a board that sends people to work that is over",
  );
});

async function readSwarm(id: string) {
  const [row] = await db.select().from(swarms).where(eq(swarms.id, id));
  return row!;
}

/* ---------------------------------------------------------------- *
 * One node, opened.
 * ---------------------------------------------------------------- */

/** The project's checkout, for the tests that need git to answer. */
async function withRepository<T>(run: () => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(repositories)
    .values({ projectId, name: "app", localPath: repoDir, defaultBranch: "main", position: 0 })
    .returning();
  try {
    return await run();
  } finally {
    await db.delete(repositories).where(eq(repositories.id, row!.id));
  }
}

test("a node answers with the commits its trailer names and the history it has", async () => {
  /**
   * The commits are found through the `Bento-Task` trailer rather than
   * through a column, which is what makes them survive the rebase a
   * landing performs. So the test writes a real commit with a real
   * trailer on a real branch and asks the route for it.
   */
  const swarm = await createSwarm();
  const [task] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title: "Totals", branchName: `${swarm.branchName}-aaaaaaaa` })
    .returning();
  await db.insert(swarmTaskEvents).values([
    { taskId: task!.id, kind: "assigned", toStatus: "assigned" },
    {
      taskId: task!.id,
      kind: "attention_raised",
      runId: swarm.plannerRunId,
      detail: { conflict: "shared.txt: both modified", resolver: "started" },
    },
  ]);

  const git = (...args: string[]) =>
    run("git", ["-C", repoDir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@b.dev", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@b.dev" },
    });
  await git("checkout", "-q", "-b", task!.branchName!);
  await writeFile(path.join(repoDir, "totals.ts"), "export const total = 1;\n");
  await git("add", "-A");
  await git("commit", "-qm", `Line item totals\n\nBento-Task: ${task!.id}`);
  await git("checkout", "-q", "main");

  const body = await withRepository(async () => {
    const res = await app.request(`/api/swarms/${swarm.id}/tasks/${task!.id}`);
    assert.equal(res.status, 200);
    return (await res.json()) as {
      task: { id: string };
      commits: { repository: string; sha: string; subject: string }[];
      events: { kind: string; runId: string | null; detail: Record<string, unknown> | null }[];
    };
  });

  assert.equal(body.task.id, task!.id);
  assert.equal(body.commits.length, 1, "the commit carrying this task's trailer, and only that one");
  assert.equal(body.commits[0]!.subject, "Line item totals");
  assert.equal(body.commits[0]!.repository, "app");
  assert.deepEqual(
    body.events.map((event) => event.kind),
    ["assigned", "attention_raised"],
    "oldest first, so the drawer reads down",
  );
  assert.equal(body.events[1]!.runId, swarm.plannerRunId, "and a resolver's run is named on the node it served");

  await git("branch", "-qD", task!.branchName!);
});

test("a node of another swarm is not this swarm's to read", async () => {
  const mine = await createSwarm();
  const theirs = await createSwarm({ title: "Another" });
  const [task] = await db.insert(swarmTasks).values({ swarmId: theirs.id, title: "Theirs" }).returning();
  assert.equal((await app.request(`/api/swarms/${mine.id}/tasks/${task!.id}`)).status, 404);
});

test("a message to a node is queued against that node, and is refused for a node that is not there", async () => {
  /**
   * The composer in the node drawer sends here. The row carries the
   * task, which is what keeps it out of the planner's wake: the planner
   * is woken by messages addressed to the plan, and this one is for
   * whichever agent works the leaf next.
   */
  const swarm = await createSwarm();
  const [task] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Totals" }).returning();

  const res = await post(`/api/swarms/${swarm.id}/messages`, { text: "use the existing helper", taskId: task!.id });
  assert.equal(res.status, 201);

  const rows = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.taskId, task!.id);
  assert.equal(rows[0]!.status, "queued");

  const stranger = await post(`/api/swarms/${swarm.id}/messages`, {
    text: "nope",
    taskId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(stranger.status, 404, "a node that is not this swarm's is not there");
});

test("a node's messages are handed to one run, oldest first, and never twice", async () => {
  /**
   * The other end of the composer. A message that stayed queued after
   * an agent read it would be shown to the next one as well, which on
   * a leaf that keeps being sent back is the same note every time; and
   * one handed to two runs would be two agents acting on it.
   */
  const swarm = await createSwarm();
  const [task] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Totals" }).returning();
  const [other] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Elsewhere" }).returning();

  await post(`/api/swarms/${swarm.id}/messages`, { text: "first", taskId: task!.id });
  await post(`/api/swarms/${swarm.id}/messages`, { text: "second", taskId: task!.id });
  await post(`/api/swarms/${swarm.id}/messages`, { text: "not this leaf", taskId: other!.id });
  await post(`/api/swarms/${swarm.id}/messages`, { text: "for the plan" });

  const taken = await takeNodeMessages(db, task!.id, swarm.plannerRunId);
  assert.deepEqual(
    taken.map((message) => message.text),
    ["first", "second"],
    "this node's, in the order they were typed",
  );

  const again = await takeNodeMessages(db, task!.id, swarm.plannerRunId);
  assert.deepEqual(again, [], "a delivered message is not handed to the next run as well");

  const rows = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  const byText = new Map(rows.map((row) => [row.text, row]));
  assert.equal(byText.get("first")!.status, "delivered");
  assert.equal(byText.get("first")!.runId, swarm.plannerRunId);
  assert.equal(byText.get("not this leaf")!.status, "queued", "another node's is left where it was");
  assert.equal(byText.get("for the plan")!.status, "queued", "and the planner's is still the planner's");
});

test("a local install's default template runs its agents in worktrees, two at a time", async () => {
  /**
   * The shape is written onto the template rather than read off the
   * driver every time a run starts. A container per worker is a
   * container on the machine somebody is also using, which is why a
   * local install wants worktrees and two of them; recording it is
   * what stops that shape changing under a swarm if the install later
   * joins a team.
   */
  const swarm = await createSwarm({ title: "Shape" });
  const [template] = await db.select().from(swarmTemplates).where(eq(swarmTemplates.id, swarm.templateId!));
  assert.equal(template!.name, "Default");
  assert.equal(template!.workerIsolation, "worktree");
  assert.equal(template!.maxWorkers, 2);
});

test("a template states its shape, and takes the one it is given", async () => {
  const made = await post("/api/swarm-templates", { name: "Hosted shape", workerIsolation: "sandbox" });
  assert.equal(made.status, 201);
  const row = (await made.json()) as { workerIsolation: string };
  assert.equal(row.workerIsolation, "sandbox", "a caller that states one is taken at its word");

  const implied = await post("/api/swarm-templates", { name: "Local shape" });
  assert.equal(implied.status, 201);
  assert.equal(
    ((await implied.json()) as { workerIsolation: string }).workerIsolation,
    "worktree",
    "and this deployment's own shape otherwise",
  );

  const nonsense = await post("/api/swarm-templates", { name: "Nope", workerIsolation: "vm" });
  assert.equal(nonsense.status, 400, "a shape nothing can run is not stored");
});

/**
 * A refusal that leaves a swarm behind is worse than a refusal.
 *
 * The plan question used to be asked at the planner's door, which is
 * after the swarm row is written: a team over its limit got a 402 and
 * a swarm nobody had asked for, in the planning state, with no planner
 * and no way to start one. The allowance is asked first now, and the
 * door asks again for the run itself.
 */
test("a team over its plan is told before a swarm is written, not after", async () => {
  await ctx.pool.query(
    `insert into identity.organization (id,name,slug) values ('org-a','A','org-a') on conflict do nothing`,
  );
  const [team] = await db
    .insert(projects)
    .values({ ownerId: ctx.userId!, organizationId: "org-a", name: "Team", defaultBranch: "main" })
    .returning();
  const asked: string[] = [];
  ctx.entitlements = {
    canAddMember: async () => null,
    canActivateFeature: async () => null,
    canStartRun: async (organizationId: string) => {
      asked.push(organizationId);
      return { reason: "This team has used its agent hours for the month." };
    },
  } as unknown as Entitlements;
  try {
    const res = await post("/api/swarms", { projectId: team!.id, title: "Over the line", goal: "go" });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "PLAN_LIMIT");
    assert.match(body.error, /agent hours/);
    assert.deepEqual(asked, ["org-a"], "the organization is the project's");

    const rows = await db.select().from(swarms).where(eq(swarms.projectId, team!.id));
    assert.deepEqual(rows, [], "and nothing was persisted for a swarm that was refused");
    assert.deepEqual(await db.select().from(agentRuns), [], "no planner either");
  } finally {
    delete ctx.entitlements;
    await db.delete(projects).where(eq(projects.id, team!.id));
  }
});

/**
 * A swarm's own machine outlives everything else it has.
 *
 * Its planner and its coordinator work in one sprite from before the
 * plan exists until the last leaf lands, and a sprite is billed for as
 * long as it exists rather than for as long as it is used. Stopping a
 * swarm is the moment nothing will work in it again.
 */
test("stopping a swarm hands its own machine to the reaper", async () => {
  const swarm = await createSwarm();
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));
  queued.length = 0;

  assert.equal((await post(`/api/swarms/${swarm.id}/cancel`)).status, 200);
  assert.deepEqual(
    queued.filter((job) => job.queue === "sandbox.reap").map((job) => job.data),
    [{ swarmId: swarm.id }],
    "the machine is queued rather than destroyed inline, the way a finished card's is",
  );
});

/* ---------------------------------------------------------------- *
 * The node controls: retry, cancel, split, reassign, and editing the
 * description that made the retry worth doing.
 * ---------------------------------------------------------------- */

/**
 * The whole point of retrying: the leaf goes back in the queue with the
 * attempt that failed cleared off it, and the reconciler is what puts a
 * new agent on it.
 */
test("retrying a leaf puts it back in the queue and clears the attempt that failed", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await db
    .update(swarmTasks)
    .set({ status: "failed", attention: "failed", report: "I could not do it", flags: { plannerToldAt: "yesterday" } })
    .where(eq(swarmTasks.id, tree.first.id));

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/retry`);
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(tree.first.id);
  assert.equal(after.status, "assigned", "assigned, not working: the reconciler decides when there is room");
  assert.equal(after.attention, null);
  assert.equal(after.report, null, "the old report was about the attempt being discarded");
  assert.equal((after.flags as { retries?: number }).retries, 1, "and the board can say this is the second try");
  assert.equal(
    (after.flags as { plannerToldAt?: string }).plannerToldAt,
    undefined,
    "the latch is cleared, or the planner would never hear how this one goes",
  );
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "and the reconciler was woken to spawn on it",
  );
});

/** Retrying replaces the agent, so the one that is there stops first. */
test("retrying a leaf that still has an agent on it stops that agent", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: tree.first.id,
      role: "worker",
      agentProfileId: (await db.select().from(agentProfiles).limit(1))[0]!.id,
      prompt: "",
      status: "running",
    })
    .returning();
  const controller = new AbortController();
  ctx.running.set(run!.id, controller);
  await db.update(swarmTasks).set({ status: "working", assignedRunId: run!.id }).where(eq(swarmTasks.id, tree.first.id));

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/retry`);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(controller.signal.aborted, true, "the agent that was on it is stopped");
  const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
  assert.equal(stopped!.status, "cancelled");
  assert.equal((await readTask(tree.first.id)).status, "assigned");
});

/** A plan node is worked through its children, so there is nothing to retry. */
test("a plan node is not a person's to retry", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.plan.id}/retry`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "NOT_A_LEAF");
});

/**
 * A retry that is refused has to leave everything where it was.
 *
 * The planner's own cancel deliberately lets a worker finish its turn,
 * so a cancelled leaf can still have an agent on it for a while. Open
 * a swarm just before that happens, press Retry just after, and the
 * route answered "this task was cancelled, nothing changed" having
 * already destroyed the run and abandoned its branch. Refusing is
 * something a route decides before it touches anything, which is how
 * split has always done it.
 */
test("a retry that is refused does not stop the agent first", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: tree.first.id,
      role: "worker",
      agentProfileId: (await db.select().from(agentProfiles).limit(1))[0]!.id,
      prompt: "",
      status: "running",
    })
    .returning();
  const controller = new AbortController();
  ctx.running.set(run!.id, controller);
  // The planner cancelled the leaf, and its worker is finishing its turn.
  await db
    .update(swarmTasks)
    .set({ status: "cancelled", assignedRunId: run!.id })
    .where(eq(swarmTasks.id, tree.first.id));

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/retry`);
  assert.equal(res.status, 409);
  assert.equal(controller.signal.aborted, false, "nothing was stopped on the caller's behalf");
  const [untouched] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
  assert.equal(untouched!.status, "running", "and the agent is still working its branch");
});

/**
 * Cancelling takes the subtree, the same rule the planner's own tool
 * follows, because both call the same function.
 */
test("cancelling a plan node cancels everything under it and stops its agents", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.plan.id}/cancel`);
  assert.equal(res.status, 200, await res.clone().text());
  const { cancelled } = (await res.json()) as { cancelled: string[] };
  assert.equal(cancelled.length, 3, "the node and both leaves under it");
  for (const id of [tree.plan.id, tree.first.id, tree.second.id]) {
    assert.equal((await readTask(id)).status, "cancelled");
  }
});

test("splitting a leaf turns it into a plan node with the tasks it should have been", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await db.update(swarmTasks).set({ status: "assigned" }).where(eq(swarmTasks.id, tree.first.id));

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/split`, {
    children: [{ title: "The read path" }, { title: "The write path", description: "and its tests", weight: 2 }],
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { created } = (await res.json()) as { created: string[] };
  assert.equal(created.length, 2);

  const split = await readTask(tree.first.id);
  assert.equal(split.nodeType, "plan", "it is no longer something an agent is given");
  assert.equal(split.status, "open", "and its own assignment went to its children");
  const children = (await tasksOf(swarm.id)).filter((task) => task.parentId === tree.first.id);
  assert.deepEqual(children.map((task) => task.title).sort(), ["The read path", "The write path"]);
  assert.equal(children.every((task) => task.status === "open"), true, "none of them is started");
});

/** Splitting a leaf an agent is on would orphan the work it is doing. */
test("a leaf being worked is not split out from under its agent", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await db.update(swarmTasks).set({ status: "working" }).where(eq(swarmTasks.id, tree.first.id));

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/split`, {
    children: [{ title: "Too late" }],
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "CANNOT_SPLIT");
});

/**
 * Reassigning writes the agent on the node, so the next spawn uses it
 * and every other leaf keeps the template's own worker.
 */
test("reassigning a leaf puts a different agent on that leaf alone", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const [stronger] = await db
    .insert(agentProfiles)
    .values({ ownerId: ctx.userId!, name: "Stronger", cli: "fake", model: "fake-2" })
    .returning();

  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/reassign`, {
    agentProfileId: stronger!.id,
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await readTask(tree.first.id)).agentProfileId, stronger!.id);
  assert.equal((await readTask(tree.second.id)).agentProfileId, null, "and its sibling is untouched");

  // Reassigning does not start anything: a leaf waiting its turn keeps
  // its place, and the retry is what pushes it.
  assert.equal((await readTask(tree.first.id)).status, tree.first.status);

  const back = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/reassign`, { agentProfileId: null });
  assert.equal(back.status, 200);
  assert.equal((await readTask(tree.first.id)).agentProfileId, null, "and it can be put back on the template's own");
});

/** An agent id nobody can reach is not an agent this swarm can run. */
test("a leaf cannot be reassigned to an agent that is not there", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  const res = await post(`/api/swarms/${swarm.id}/tasks/${tree.first.id}/reassign`, {
    agentProfileId: "00000000-0000-0000-0000-000000000000",
  });
  assert.equal(res.status, 404);
});

/**
 * The half of "edit before retry" that is not the retry. A leaf that
 * failed because its description was wrong fails again against the same
 * description.
 */
test("a task's description can be corrected, and its status cannot", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);

  const res = await patch(`/api/swarms/${swarm.id}/tasks/${tree.first.id}`, {
    description: "Only the totals, not the tax rules.",
    weight: 3,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const edited = await readTask(tree.first.id);
  assert.equal(edited.description, "Only the totals, not the tax rules.");
  assert.equal(edited.weight, 3);

  const refused = await patch(`/api/swarms/${swarm.id}/tasks/${tree.first.id}`, { status: "done" });
  assert.equal(refused.status, 400, "where a task is in its life is not something a patch decides");
  assert.equal((await readTask(tree.first.id)).status, tree.first.status);
});

/**
 * Raising a budget has to wake the reconciler, or it does nothing.
 *
 * A swarm that spent its budget is stopped rather than slowed, and
 * money coming back is a person's decision rather than an event
 * anything fires on: without a tick from here, the swarm would sit at
 * budget_exhausted with a budget it was no longer over.
 */
test("raising the budget wakes the swarm, and the planner's warning is due again", async () => {
  const swarm = await createSwarm();
  await db
    .update(swarms)
    .set({ status: "budget_exhausted", pausedReason: "budget", budgetUsd: "5", budgetWarnedAt: new Date() })
    .where(eq(swarms.id, swarm.id));
  queued = [];

  const res = await patch(`/api/swarms/${swarm.id}`, { budgetUsd: 40 });
  assert.equal(res.status, 200, await res.clone().text());

  const [after] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  assert.equal(Number(after!.budgetUsd), 40);
  assert.equal(after!.budgetWarnedAt, null, "a raised budget is a different budget: running low on it is news again");
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "and the reconciler is asked to try spawning again",
  );
});

/**
 * The clock's ending gets what the budget's ending got.
 *
 * Both are ceilings a person raises to reopen, and only one of them was
 * wired for it. Raising the time limit changed a column and woke
 * nothing, and the console offers Resume on a timed out swarm, so the
 * button was there and the swarm stayed exactly where it was.
 */
test("raising the time limit wakes the swarm the clock stopped", async () => {
  const swarm = await createSwarm();
  await db
    .update(swarms)
    .set({ status: "timed_out", pausedReason: "time_limit", timeLimitMin: 120 })
    .where(eq(swarms.id, swarm.id));
  queued = [];

  const res = await patch(`/api/swarms/${swarm.id}`, { timeLimitMin: 240 });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "a raised ceiling is a reason to try spawning again, whichever ceiling it is",
  );
});

/**
 * The Spend page is not a way around the allowlist.
 *
 * Every swarm route answers 404 to somebody who is not a beta tester,
 * because a 402 would tell them the feature exists. The project's usage
 * route is not a swarm route and was never gated, and it grew a section
 * listing every swarm's title, status and spend: the one page in the
 * console that would have told a non-tester swarms exist, and told them
 * what their colleagues had been spending on them.
 *
 * The cards are not beta, so the route still answers. The swarms come
 * off it, which is the same thing the console does with a section a
 * person may not see.
 */
test("a person who is not a beta tester is not told the swarms exist", async () => {
  const swarm = await createSwarm();
  await db
    .update(swarms)
    .set({ spentMeasuredUsd: "40", title: "Rewrite checkout" })
    .where(eq(swarms.id, swarm.id));

  const asTester = await app.request(`/api/projects/${projectId}/usage`);
  assert.equal(asTester.status, 200);
  const seen = (await asTester.json()) as { bySwarm: { swarmId: string }[] };
  assert.equal(seen.bySwarm.length, 1, "a tester sees the swarm section");

  const flags = ctx.featureFlags;
  ctx.featureFlags = { isBetaTester: async () => false } as unknown as typeof flags;
  try {
    const res = await app.request(`/api/projects/${projectId}/usage`);
    assert.equal(res.status, 200, "the cards on this page are not behind the flag");
    const body = (await res.json()) as { bySwarm: unknown[] };
    assert.deepEqual(body.bySwarm, [], "and the swarms are not on it at all");
  } finally {
    ctx.featureFlags = flags;
  }
});

test("a swarm somebody moved says so on the bus, so every other viewer hears it", async () => {
  /**
   * The routes wrote their rows and said nothing.
   *
   * The console masked it, because it refetches after its own action,
   * so it looked right as long as it was the only viewer. A second
   * tab, a teammate watching the same swarm, and `bento swarm watch`
   * in a terminal all heard nothing at all: stopping a swarm from one
   * window left it reading as running on every other screen until some
   * unrelated tick happened to fire. Found by running the terminal
   * against a live server, which is the only place it shows.
   */
  const swarm = await createSwarm();
  const heard: { type: string; status?: string }[] = [];
  const stop = ctx.bus.onBoardEvent(projectId, (event) => {
    if ("swarmId" in event && event.swarmId === swarm.id) heard.push({ type: event.type, ...("status" in event ? { status: event.status } : {}) });
  });

  try {
    await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Leaf" });
    await post(`/api/swarms/${swarm.id}/start`);
    await post(`/api/swarms/${swarm.id}/pause`);
    await app.request(`/api/swarms/${swarm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxWorkers: 3 }),
    });
    await post(`/api/swarms/${swarm.id}/cancel`);

    assert.deepEqual(
      heard.map((event) => event.status ?? event.type),
      ["running", "paused", "swarm_updated", "cancelled"],
      "every door that moves a swarm says so",
    );
  } finally {
    stop();
  }
});

test("reopening a finished swarm adds a follow up subtree and says so on the bus", async () => {
  const swarm = await createSwarm();
  await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Leaf", status: "done" });
  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, swarm.id));
  // The planner this swarm was created with has settled by the time a
  // real swarm is done, and the reopen route refuses while one has not.
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));

  const heard: string[] = [];
  const stop = ctx.bus.onBoardEvent(projectId, (event) => {
    if ("swarmId" in event && event.swarmId === swarm.id && event.type === "swarm_updated") {
      heard.push(event.status ?? "");
    }
  });

  try {
    const res = await post(`/api/swarms/${swarm.id}/reopen`, {
      instruction: "Address the review comments.",
      budgetUsd: 50,
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { followUpTaskId: string; followUp: number };
    assert.equal(body.followUp, 1);

    const [node] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, body.followUpTaskId));
    assert.equal(node!.parentId, null);
    assert.equal(node!.nodeType, "plan");
    assert.equal(node!.followUpInstruction, "Address the review comments.");

    const [row] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
    assert.equal(row!.status, "running");
    assert.equal(row!.reopenCount, 1);
    assert.equal(row!.budgetUsd, "50");
    assert.deepEqual(heard, ["running"]);
  } finally {
    stop();
  }
});

test("a swarm that is still running is not reopened", async () => {
  const swarm = await createSwarm();
  const res = await post(`/api/swarms/${swarm.id}/reopen`, { instruction: "more" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "NOT_FINISHED");
  assert.equal((await db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarm.id))).length, 0);
});

test("a swarm's artifacts are listed by the swarm, and served by the artifact routes", async () => {
  const swarm = await createSwarm();
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      role: "planner",
      swarmId: swarm.id,
      agentProfileId: (await db.select().from(agentProfiles).limit(1))[0]!.id,
      prompt: "plan it",
      status: "succeeded",
    })
    .returning();
  const [artifact] = await db
    .insert(runArtifacts)
    .values({
      runId: run!.id,
      type: "swarm",
      swarmId: swarm.id,
      stageSlug: "document",
      stageName: "Document",
      path: "docs/plan.md",
      kind: "markdown",
      mime: "text/markdown",
      size: 5,
      content: "# Hi\n",
    })
    .returning();

  const listed = (await (await app.request(`/api/swarms/${swarm.id}/artifacts`)).json()) as {
    id: string;
    path: string;
    kind: string;
  }[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.path, "docs/plan.md");
  assert.equal(listed[0]!.kind, "markdown");

  // And the bytes come from the artifact routes, under the rules that
  // keep agent output from ever running as the console.
  const content = await app.request(`/api/artifacts/${artifact!.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-security-policy"), "sandbox");
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await content.text(), "# Hi\n");
});

/* ---------------------------------------------------------------- *
 * Putting a swarm away, and taking it out again.
 * ---------------------------------------------------------------- */

/** A machine this swarm holds, as the executor records one. */
async function sandboxFor(swarmId: string, externalId = "bento-swarm-1") {
  const [row] = await db
    .insert(sandboxes)
    .values({ projectId, swarmId, provider: "docker", externalId, status: "ready" })
    .returning();
  return row!;
}

test("pausing a swarm checkpoints the machines it holds", async () => {
  /**
   * A paused swarm is one nobody is working in and everybody is still
   * paying for. The machine stays, because a person means to come
   * back to it, and the point of the checkpoint is that coming back
   * starts from where it stopped rather than from a fresh clone.
   */
  const swarm = await createSwarm();
  const box = await sandboxFor(swarm.id);
  const asked: { externalId: string; label: string }[] = [];
  const driver = {
    provider: "docker" as const,
    snapshot: async (handle: { externalId: string }, label: string) => {
      asked.push({ externalId: handle.externalId, label });
      return `snap-${handle.externalId}`;
    },
  };

  const result = await checkpointSwarmSandboxes(db, driver, swarm.id, "swarm-pause");
  assert.equal(result.skipped, null);
  assert.deepEqual(result.checkpointed, [{ sandboxId: box.id, checkpointId: "snap-bento-swarm-1" }]);
  assert.deepEqual(asked, [{ externalId: "bento-swarm-1", label: "swarm-pause" }]);

  const [after] = await db.select().from(sandboxes).where(eq(sandboxes.id, box.id));
  assert.equal(after!.checkpointId, "snap-bento-swarm-1");
  assert.equal(after!.status, "hibernated", "and the row says nothing is working in it");
});

test("a driver that cannot snapshot is not a failure to pause", async () => {
  const swarm = await createSwarm();
  await sandboxFor(swarm.id, "bento-swarm-2");
  const result = await checkpointSwarmSandboxes(db, { provider: "docker" }, swarm.id, "swarm-pause");
  assert.deepEqual(result.checkpointed, []);
  assert.match(result.skipped ?? "", /cannot be snapshotted/);
});

test("a snapshot that fails leaves the row alone rather than failing the pause", async () => {
  const swarm = await createSwarm();
  const box = await sandboxFor(swarm.id, "bento-swarm-3");
  const driver = {
    provider: "docker" as const,
    snapshot: () => Promise.reject(new Error("the provider was unreachable")),
  };

  const result = await checkpointSwarmSandboxes(db, driver, swarm.id, "swarm-pause");
  assert.deepEqual(result.checkpointed, []);
  const [after] = await db.select().from(sandboxes).where(eq(sandboxes.id, box.id));
  assert.equal(after!.checkpointId, null);
  assert.equal(after!.status, "ready", "the machine is still there and still what it was");
});

test("archiving a finished swarm reaps its machine, and archiving a live one does not", async () => {
  /**
   * Putting a swarm away is a person saying they are finished with it,
   * and a machine kept for a swarm nobody will open again is pure
   * cost. But somebody tidying their strip while a swarm still runs is
   * not saying that, and destroying a machine an agent is working in
   * would leave a branch nobody chose.
   */
  const live = await createSwarm();
  assert.equal(archiveReapsSandboxes({ status: "running" }), false);
  assert.equal(archiveReapsSandboxes({ status: "planning" }), false);
  assert.equal(archiveReapsSandboxes({ status: "paused" }), false);
  for (const status of ["done", "failed", "cancelled", "budget_exhausted", "timed_out"] as const) {
    assert.equal(archiveReapsSandboxes({ status }), true, `${status} is finished with`);
  }

  await sandboxFor(live.id, "bento-swarm-4");
  queued.length = 0;
  await patch(`/api/swarms/${live.id}`, { archived: true });
  assert.equal(
    queued.filter((job) => job.queue === "sandbox.reap").length,
    0,
    "a swarm that is still planning keeps its machine",
  );

  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, live.id));
  queued.length = 0;
  await patch(`/api/swarms/${live.id}`, { archived: true });
  const reaps = queued.filter((job) => job.queue === "sandbox.reap");
  assert.equal(reaps.length, 1, "a finished one does not");
  assert.deepEqual(reaps[0]!.data, { swarmId: live.id });

  // And restoring it simply takes it out again: the next run
  // provisions a machine the way the first one appeared.
  queued.length = 0;
  await patch(`/api/swarms/${live.id}`, { archived: false });
  const [restored] = await db.select().from(swarms).where(eq(swarms.id, live.id));
  assert.equal(restored!.archivedAt, null);
  assert.equal(queued.filter((job) => job.queue === "sandbox.reap").length, 0);
});

/* ---------------------------------------------------------------- *
 * Adding a task by hand.
 * ---------------------------------------------------------------- */

test("a person can add a task, and the planner is told and can object", async () => {
  /**
   * The tree is an agent's to fill in and a person's to correct. A
   * task added by hand goes in ready to be worked, because somebody
   * who adds one has decided it needs doing and leaving it open would
   * be the planner overruling them by inaction. What keeps that
   * honest is the notice: the planner hears about it and can cancel
   * it, which is a decision somebody can see.
   */
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);

  const res = await post(`/api/swarms/${swarm.id}/tasks`, {
    parentId: tree.plan.id,
    title: "Add the retry",
    description: "The upload path has no retry, and the planner did not split one out.",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const created = (await res.json()) as { id: string; parentId: string; status: string; nodeType: string };
  assert.equal(created.parentId, tree.plan.id);
  assert.equal(created.nodeType, "leaf");
  assert.equal(created.status, "assigned", "ready to be worked, not waiting on the planner");

  const messages = await db
    .select()
    .from(swarmMessages)
    .where(eq(swarmMessages.swarmId, swarm.id))
    .orderBy(asc(swarmMessages.createdAt));
  const notice = messages.at(-1)!;
  assert.equal(notice.source, "system", "Bento's own sentence about a row it holds");
  assert.match(notice.text, new RegExp(created.id));
  assert.match(notice.text, /Add the retry/, "with what the person wrote, quoted inside it");
  assert.match(notice.text, /use cancel_task or split_task/, "and how to object");
});

test("a swarm's tuned ceilings are saved as a template, and its template's shape is carried across", async () => {
  /**
   * The point of saving a swarm is the tuning nobody wrote down: the
   * workers raised when the plan turned out wider than planned, the
   * budget lifted when it nearly ran out. So the saved template must
   * carry what the swarm has now, not what the template it started
   * from said, while everything a swarm has no opinion about comes
   * across untouched.
   */
  const swarm = await createSwarm();
  const [before] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  const source = (await db.select().from(swarmTemplates).where(eq(swarmTemplates.id, before!.templateId!)))[0]!;

  await patch(`/api/swarms/${swarm.id}`, { maxWorkers: 7, budgetUsd: 12.5, timeLimitMin: 90 });

  const res = await post(`/api/swarms/${swarm.id}/template`, { name: "Wide checkout" });
  assert.equal(res.status, 201, await res.clone().text());
  const saved = (await res.json()) as {
    id: string;
    name: string;
    description: string;
    maxWorkers: number;
    budgetUsd: string | null;
    timeLimitMin: number | null;
    plannerProfileId: string | null;
    workerProfileId: string | null;
    workerIsolation: string;
    maxPlanDepth: number;
  };

  assert.equal(saved.name, "Wide checkout");
  assert.equal(saved.maxWorkers, 7, "the number the swarm ended up running, not the one it started with");
  assert.equal(Number(saved.budgetUsd), 12.5, "and the budget as it stands");
  assert.equal(saved.timeLimitMin, 90);
  assert.match(saved.description, /Rewrite checkout/, "and says which swarm it came from");

  assert.equal(saved.plannerProfileId, source.plannerProfileId, "the agents come from the template, not from nowhere");
  assert.equal(saved.workerProfileId, source.workerProfileId);
  assert.equal(saved.workerIsolation, source.workerIsolation, "and where its workers work");
  assert.equal(saved.maxPlanDepth, source.maxPlanDepth);

  assert.notEqual(saved.id, source.id, "a copy, so editing one does not reach the other");
  const sourceAfter = (await db.select().from(swarmTemplates).where(eq(swarmTemplates.id, source.id)))[0]!;
  assert.equal(sourceAfter.maxWorkers, source.maxWorkers, "and the template it came from is left as it was");
});

test("a swarm whose template was deleted is refused rather than half saved", async () => {
  /**
   * templateId is set null when a template is deleted, and the four
   * fields a swarm carries name no agents. A template invented out of
   * them would list in the picker and fail at the first run, which is
   * the worst moment to find out.
   */
  const swarm = await createSwarm();
  await db.update(swarms).set({ templateId: null }).where(eq(swarms.id, swarm.id));

  const res = await post(`/api/swarms/${swarm.id}/template`, { name: "Orphan" });
  assert.equal(res.status, 409, await res.clone().text());
  assert.match(((await res.json()) as { error: string }).error, /has been deleted/);
});

test("a task cannot hang off another task", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);

  const res = await post(`/api/swarms/${swarm.id}/tasks`, { parentId: tree.first.id, title: "Under a leaf" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "CANNOT_ADD");
  assert.match(body.error, /cannot hang off another task/);
});

test("a task added at the top of the plan needs no parent, and a foreign node is not there", async () => {
  const swarm = await createSwarm();
  const top = await post(`/api/swarms/${swarm.id}/tasks`, { title: "At the top" });
  assert.equal(top.status, 201);
  assert.equal(((await top.json()) as { parentId: string | null }).parentId, null);

  // A node from another swarm reads as not there rather than as one
  // this caller may add work under.
  const other = await createSwarm({ title: "Another" });
  const otherTree = await treeOf(other.id);
  const foreign = await post(`/api/swarms/${swarm.id}/tasks`, {
    parentId: otherTree.plan.id,
    title: "Injected",
  });
  assert.equal(foreign.status, 404);
});

test("nothing is added to a swarm somebody stopped", async () => {
  const swarm = await createSwarm();
  await post(`/api/swarms/${swarm.id}/cancel`);
  const res = await post(`/api/swarms/${swarm.id}/tasks`, { title: "Too late" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "SWARM_STOPPED");
});

test("finished work cannot be changed without reopening the swarm", async () => {
  const swarm = await createSwarm();
  const tree = await treeOf(swarm.id);
  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, swarm.id));

  for (const [path, body] of [
    [`/api/swarms/${swarm.id}/tasks`, { title: "Too late" }],
    [`/api/swarms/${swarm.id}/tasks/${tree.first.id}/retry`, undefined],
    [`/api/swarms/${swarm.id}/tasks/${tree.first.id}/cancel`, undefined],
    [`/api/swarms/${swarm.id}/tasks/${tree.first.id}/split`, { children: [{ title: "Too late" }] }],
  ] as const) {
    const response = await post(path, body);
    assert.equal(response.status, 409, path);
    assert.equal(((await response.json()) as { code: string }).code, "SWARM_FINISHED", path);
  }
});
