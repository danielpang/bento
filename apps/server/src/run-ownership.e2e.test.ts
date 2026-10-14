import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { agentRuns, createDb, createPool, featureMessages, runEvents, runMigrations, sandboxes } from "@bento/db";
import type { AgentEvent } from "@bento/core";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { singleDriver } from "./orchestrator/sandbox-driver.js";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus, type RunControl } from "./events.js";
import { loadEnv } from "./env.js";
import { adoptOrphanedRuns, registerJobs } from "./orchestrator/run-executor.js";
import {
  heartbeatOwnedRuns,
  holdRun,
  ownershipOf,
  releaseOwnedRuns,
  RUN_LEASE_MS,
} from "./orchestrator/run-ownership.js";
import { appendRunEvent } from "./orchestrator/transcript.js";
import { attachPgBus, type PgBus } from "./pg-bus.js";

const run = promisify(execFile);

/**
 * Two full server stacks against one database, standing in for two Fly
 * machines. Server A works the queue, so every agent executes there;
 * server B is where the person's requests land. Before the lease and
 * the control bus, B booting beside A reattached to A's live runs, and
 * a cancel or a message that landed on B changed a row and reached no
 * agent.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "run_ownership_e2e_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctxA: AppContext;
let ctxB: AppContext;
let appA: ReturnType<typeof createApp>;
let appB: ReturnType<typeof createApp>;
let pgBusA: PgBus;
let pgBusB: PgBus;
let repoDir: string;

async function makeContext(): Promise<AppContext> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-ownership-data-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    // Long enough that a live run on A is still held open when the
    // message from B arrives; short enough that the test ends.
    BENTO_LIVE_IDLE_SEC: "20",
  } as NodeJS.ProcessEnv);
  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  const userId = await ensureLocalUser(db);
  return {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    drivers: singleDriver(new LocalProcessDriver()),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  };
}

function replicate(ctx: AppContext): Promise<PgBus> {
  return attachPgBus({
    bus: ctx.bus,
    pool: ctx.pool,
    connectionString: testUrl,
    loadRunEvent: async (runId, seq) => {
      const [row] = await ctx.db
        .select({ payload: runEvents.payload })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.seq, seq)))
        .limit(1);
      return (row?.payload as AgentEvent | undefined) ?? null;
    },
  });
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  repoDir = await mkdtemp(path.join(tmpdir(), "bento-ownership-repo-"));
  await run("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", ["-C", repoDir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "init"]);

  ctxA = await makeContext();
  ctxB = await makeContext();
  // Only A works the queue, so every run executes there. B registers
  // nothing: it is the machine a person's request happens to reach.
  await registerJobs(ctxA);
  pgBusA = await replicate(ctxA);
  pgBusB = await replicate(ctxB);
  appA = createApp(ctxA);
  appB = createApp(ctxB);
});

after(async () => {
  await ctxA.boss.stop({ close: true, timeout: 1000 });
  await ctxB.boss.stop({ close: true, timeout: 1000 });
  await pgBusA.stop();
  await pgBusB.stop();
  await ctxA.pool.end();
  await ctxB.pool.end();
});

async function json<T>(res: Response): Promise<T> {
  if (!res.ok && res.status !== 201) {
    assert.fail(`unexpected status ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function setupCard(name: string) {
  const project = await json<{ id: string }>(
    await appA.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, localPath: repoDir }),
    }),
  );
  // Seeded agents off the stages, or advancing the card would start a
  // real claude-code run instead of the fake.
  const pipeline = await json<{ stages: { id: string }[] }>(await appA.request(`/api/projects/${project.id}/pipeline`));
  for (const stage of pipeline.stages) {
    await json(
      await appA.request(`/api/stages/${stage.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultAgentProfileId: null }),
      }),
    );
  }
  const feature = await json<{ id: string }>(
    await appA.request("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: `${name} card`, description: "e2e" }),
    }),
  );
  const profile = await json<{ id: string }>(
    await appA.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${name}-fake`, cli: "fake", model: "fake-1" }),
    }),
  );
  await appA.request(`/api/features/${feature.id}/advance`, { method: "POST" });
  return { project, feature, profile, stageId: pipeline.stages[0]!.id };
}

async function startRun(featureId: string, profileId: string, prompt: string): Promise<string> {
  const started = await json<{ id: string }>(
    await appA.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId, agentProfileId: profileId, prompt }),
    }),
  );
  return started.id;
}

async function runRow(runId: string) {
  const [row] = await ctxB.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  assert.ok(row, `run ${runId} exists`);
  return row;
}

async function waitFor<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A run row as another server would leave it: driving, lease fresh or stale. */
async function insertHeldRun(input: { featureId: string; stageId: string; profileId: string; owner: string; heartbeatAgoMs: number }) {
  const [row] = await ctxA.db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: input.featureId,
      stageId: input.stageId,
      agentProfileId: input.profileId,
      prompt: "held elsewhere",
      status: "running",
      executor: "server",
      startedAt: new Date(Date.now() - 60_000),
      ownerId: input.owner,
      ownerHeartbeatAt: new Date(Date.now() - input.heartbeatAgoMs),
    })
    .returning();
  return row!;
}

test("a server adopts only the runs whose lease has lapsed", { timeout: 60_000 }, async () => {
  const { feature, profile, stageId } = await setupCard("Lease");
  const live = await insertHeldRun({ featureId: feature.id, stageId, profileId: profile.id, owner: "server-elsewhere", heartbeatAgoMs: 0 });

  // A fresh lease is another server still driving: hands off.
  let adopted = await adoptOrphanedRuns(ctxB);
  assert.deepEqual(adopted, { resumed: 0, closed: 0 }, "a run with a live lease is nobody else's to touch");
  let row = await runRow(live.id);
  assert.equal(row.status, "running");
  assert.equal(row.ownerId, "server-elsewhere", "the owner is unchanged");

  // The same row once its server has been silent past the lease. It has
  // no sandbox, which is the shape of a server that died mid provision,
  // so adoption closes it as interrupted, as a boot always has.
  await ctxA.db
    .update(agentRuns)
    .set({ ownerHeartbeatAt: new Date(Date.now() - RUN_LEASE_MS - 5_000) })
    .where(eq(agentRuns.id, live.id));
  adopted = await adoptOrphanedRuns(ctxB);
  assert.deepEqual(adopted, { resumed: 0, closed: 1 }, "a stale lease is adopted");
  row = await runRow(live.id);
  assert.equal(row.status, "failed", "closed as interrupted, since there is no agent to follow");
  assert.equal(row.ownerId, ownershipOf(ctxB).instanceId, "the adopter's name is on the row");
  assert.match(row.error ?? "", /restart/i);
});

test("two servers sweeping at once split the orphans rather than both taking all", { timeout: 60_000 }, async () => {
  const { feature, profile, stageId } = await setupCard("Race");
  const stale = await insertHeldRun({ featureId: feature.id, stageId, profileId: profile.id, owner: "server-gone", heartbeatAgoMs: RUN_LEASE_MS * 2 });
  const [first, second] = await Promise.all([adoptOrphanedRuns(ctxA), adoptOrphanedRuns(ctxB)]);
  assert.equal(first.closed + second.closed, 1, "exactly one server adopted it");
  const row = await runRow(stale.id);
  assert.ok(
    row.ownerId === ownershipOf(ctxA).instanceId || row.ownerId === ownershipOf(ctxB).instanceId,
    "the winner's name is on the row",
  );
});

test("a server whose run was taken stops writing for it", { timeout: 60_000 }, async () => {
  const { feature, profile, stageId } = await setupCard("Disown");
  const ownership = ownershipOf(ctxA);
  const mine = await insertHeldRun({ featureId: feature.id, stageId, profileId: profile.id, owner: ownership.instanceId, heartbeatAgoMs: 0 });
  holdRun(ctxA, mine.id);
  try {
    // While A owns it, a line lands and the lease renews.
    await appendRunEvent(ctxA, mine.id, { type: "message", role: "system", text: "still mine" });
    let beat = await heartbeatOwnedRuns(ctxA);
    assert.deepEqual(beat, { renewed: [mine.id], disowned: [] });

    // Another server took it (A was suspended past its lease, say).
    await ctxA.db.update(agentRuns).set({ ownerId: "server-adopter" }).where(eq(agentRuns.id, mine.id));

    // A write racing the heartbeat is refused by the database and
    // disowns the run on the spot...
    await appendRunEvent(ctxA, mine.id, { type: "message", role: "system", text: "one more from the old owner" });
    const lines = await ctxA.db.select({ payload: runEvents.payload }).from(runEvents).where(eq(runEvents.runId, mine.id));
    assert.equal(lines.length, 1, "the old owner's late line did not land");
    assert.ok(ownership.disowned.has(mine.id), "and the run is disowned");
    assert.ok(!ownership.owned.has(mine.id));

    // ...and so does the heartbeat, for a run it still thought it held.
    holdRun(ctxA, mine.id);
    beat = await heartbeatOwnedRuns(ctxA);
    assert.deepEqual(beat, { renewed: [], disowned: [mine.id] });
    assert.ok(ownership.disowned.has(mine.id));
    await appendRunEvent(ctxA, mine.id, { type: "message", role: "system", text: "nothing" });
    const after = await ctxA.db.select({ id: runEvents.id }).from(runEvents).where(eq(runEvents.runId, mine.id));
    assert.equal(after.length, 1, "a disowned run takes no lines at all");
  } finally {
    ownership.owned.delete(mine.id);
    ownership.disowned.delete(mine.id);
  }
});

test("a cancel that lands on one server stops the agent running on the other", { timeout: 60_000 }, async () => {
  const { feature, profile } = await setupCard("Cancel");
  // SLOW keeps the fake alive for half a minute.
  const runId = await startRun(feature.id, profile.id, "SLOW keep going");
  await waitFor("the run to execute on A", async () => ctxA.running.has(runId) || null);
  const before = await runRow(runId);
  assert.equal(before.ownerId, ownershipOf(ctxA).instanceId, "A's claim named it as the owner");

  // The person's Stop reaches B, which has nothing in memory for it.
  assert.equal(ctxB.running.has(runId), false);
  const stopped = Date.now();
  await json(await appB.request(`/api/runs/${runId}/cancel`, { method: "POST" }));

  await waitFor("A to drop the agent", async () => (ctxA.running.has(runId) ? null : true), 15_000);
  const row = await runRow(runId);
  assert.equal(row.status, "cancelled");
  assert.ok(Date.now() - stopped < 15_000, "the agent stopped on the cancel, not on its own schedule");
});

test("a message that lands on one server reaches the live session on the other", { timeout: 90_000 }, async () => {
  const { feature, profile } = await setupCard("Message");
  const runId = await startRun(feature.id, profile.id, "LIVE hello");
  await waitFor("the live session to exist on A", async () => ctxA.liveInputs.has(runId) || null);
  assert.equal(ctxB.liveInputs.has(runId), false, "B holds no session for it");

  const sent = await json<{ queued: boolean; live?: boolean; delivery?: string }>(
    await appB.request(`/api/features/${feature.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "change of plan" }),
    }),
  );
  // B cannot see A's stdin, so it watches the row for A's answer and
  // reports what the row said once A had pumped the message in.
  assert.equal(sent.queued, false, "the row read sent within the wait, so B answers live");
  assert.equal(sent.live, true);
  assert.equal(sent.delivery, "queue", "the delivery mode comes from the run's adapter, not a local handle");

  // A heard the nudge, claimed the row and wrote it into the agent.
  const message = await waitFor("the message to be sent", async () => {
    const [row] = await ctxB.db.select().from(featureMessages).where(eq(featureMessages.featureId, feature.id));
    return row?.status === "sent" ? row : null;
  });
  assert.equal(message.runId, runId, "sent into the run A was driving");

  await waitFor("the agent's second turn", async () => {
    const lines = await ctxB.db.select({ payload: runEvents.payload }).from(runEvents).where(eq(runEvents.runId, runId));
    const results = lines.filter((l) => (l.payload as { type: string }).type === "result").length;
    const said = lines.some((l) => {
      const p = l.payload as { type: string; role?: string; text?: string };
      return p.type === "message" && p.role === "user" && p.text === "change of plan";
    });
    return results >= 2 && said ? true : null;
  }, 60_000);

  // Let the held session close so the worker slot is free for the next test.
  ctxA.liveInputs.get(runId)?.close?.();
  await waitFor("the run to end", async () => {
    const row = await runRow(runId);
    return row.status === "succeeded" ? true : null;
  }, 60_000);
});

test("a shutting down server releases its runs and the other adopts them at once", { timeout: 60_000 }, async () => {
  const { feature, profile, stageId } = await setupCard("Release");
  const ownership = ownershipOf(ctxA);
  const mine = await insertHeldRun({ featureId: feature.id, stageId, profileId: profile.id, owner: ownership.instanceId, heartbeatAgoMs: 0 });
  holdRun(ctxA, mine.id);

  const heard = new Promise<RunControl>((resolve) => {
    const off = ctxB.bus.onRunControl((control) => {
      if (control.runId === mine.id) {
        off();
        resolve(control);
      }
    });
  });
  // As on a real shutdown: draining first, so A's own control handler
  // hears the release and declines to adopt what A just let go of.
  ctxA.draining = true;
  try {
    const released = await releaseOwnedRuns(ctxA);
    assert.deepEqual(released, [mine.id]);
    const row = await runRow(mine.id);
    assert.equal(row.ownerId, null, "the row reads as nobody's at once");

    const control = await heard;
    assert.equal(control.action, "released", "B heard the release over the bus");
    // What B's control handler does with it: adopt without waiting out a lease.
    const adopted = await adoptOrphanedRuns(ctxB);
    assert.equal(adopted.closed, 1);
    assert.equal((await runRow(mine.id)).ownerId, ownershipOf(ctxB).instanceId);
  } finally {
    ctxA.draining = false;
  }
});

test("a stray sandbox row does not make a live run an orphan", { timeout: 60_000 }, async () => {
  // Guards the shape of the orphan query: a run with a fresh lease and a
  // sandbox is exactly what a reattach used to grab, and must not be.
  const { project, feature, profile, stageId } = await setupCard("Sandboxed");
  const [sandbox] = await ctxA.db
    .insert(sandboxes)
    .values({ projectId: project.id, featureId: feature.id, provider: "sprite", externalId: `bento-${feature.id}`, status: "busy", workdir: "/workspace" })
    .returning();
  const [row] = await ctxA.db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: feature.id,
      stageId,
      agentProfileId: profile.id,
      prompt: "working elsewhere",
      status: "running",
      executor: "server",
      sandboxId: sandbox!.id,
      startedAt: new Date(),
      ownerId: "server-elsewhere",
      ownerHeartbeatAt: new Date(),
    })
    .returning();
  const adopted = await adoptOrphanedRuns(ctxB);
  assert.deepEqual(adopted, { resumed: 0, closed: 0 });
  assert.equal((await runRow(row!.id)).status, "running");
  await ctxA.db.update(agentRuns).set({ status: "cancelled", endedAt: new Date() }).where(eq(agentRuns.id, row!.id));
});
