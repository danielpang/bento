import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  projects,
  runMigrations,
  sandboxes,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager, type SandboxHandle } from "@bento/sandbox";
import { createApp } from "../app.js";
import { DiskArtifactStore } from "../artifact-store.js";
import { SecretBox } from "../secrets.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { createFeatureFlags } from "../feature-flags.js";
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

  const repoDir = await mkdtemp(path.join(tmpdir(), "bento-swarm-repo-"));
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
 * Where a swarm is in its life is not a field a client sets.
 *
 * Every rule about it (a plan to start, and refusing a swarm that is
 * over) lives on the lifecycle routes, so a status accepted on the
 * general update would be a second door past all of them: PATCH
 * {status: "running"} used to resurrect a stopped swarm and set the
 * reconciler going on it again.
 */
test("a status cannot be patched onto a swarm, whatever else the body carries", async () => {
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

async function readSwarm(id: string) {
  const [row] = await db.select().from(swarms).where(eq(swarms.id, id));
  return row!;
}
