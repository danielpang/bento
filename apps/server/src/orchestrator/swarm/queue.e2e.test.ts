/**
 * Swarm tick, land and publish on both adapters.
 *
 * Mid-tick coalesce (one rerun), land/publish dedupe, handler
 * redelivery, and boot recovery. Row locks, CAS transitions and the
 * landing uniqueness index stay in Postgres; this file only proves
 * the queue hands work over the way those already assume.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import pg from "pg";
import { eq } from "drizzle-orm";
import { createDb, createPool, runMigrations, swarmLandings, swarmTasks, swarms, type Db } from "@bento/db";
import type { AppContext } from "../../context.js";
import { EventBus } from "../../events.js";
import { loadEnv } from "../../env.js";
import { createTestJobQueue, realQueueBackends, testDatabaseName, type RealQueueBackend } from "../../jobs/test-queue.js";
import { enqueueSwarmTick, tickAllLiveSwarms } from "./coordinator.js";
import { enqueueLanding, performLanding, resumeClaimedLandings } from "./landing.js";
import { enqueueSwarmPublish, publishFinishedSwarm } from "./complete.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
let isolationSeq = 0;

function isolation(backend: RealQueueBackend): string {
  isolationSeq += 1;
  return `${backend}-${process.pid}-${isolationSeq}`;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

/**
 * Register `handler` as the only worker on `queue`.
 *
 * BullMQ enqueue does not start a worker, so we register first.
 * pg-boss enqueue starts one, so we intercept that registration and
 * keep the real tick/land/publish handler from also running.
 */
async function workQueue<T>(
  jobs: AppContext["jobs"],
  queue: "swarm.tick" | "swarm.land" | "swarm.publish",
  handler: (data: T) => Promise<void>,
): Promise<void> {
  const opts = { concurrency: 1, pollingIntervalSeconds: 1 };
  if (jobs.kind === "bullmq") {
    await jobs.work(queue, opts, handler);
    return;
  }
  const original = jobs.work.bind(jobs);
  jobs.work = async (name, workOpts, next) => {
    if (name === queue) return original(name, opts, handler);
    return original(name, workOpts, next);
  };
}

for (const backend of realQueueBackends()) {
  const testDbName = testDatabaseName("swarm_queue_test", backend);
  const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

  describe(`queue:${backend}`, () => {
    let pool: ReturnType<typeof createPool>;
    let db: Db;
    let ctx: AppContext;

    before(async () => {
      const admin = new pg.Client({ connectionString: baseUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${testDbName}`);
      await admin.end();
      await runMigrations(testUrl);

      pool = createPool(testUrl);
      db = createDb(pool);
      await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
      await pool.query(
        `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`,
        [PROJECT],
      );
      await pool.query(
        `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
        [PROFILE],
      );

      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      ctx = {
        env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
        db,
        pool,
        bus: new EventBus(),
        userId: "u1",
        jobs,
      } as unknown as AppContext;
    });

    after(async () => {
      await ctx.jobs.stop().catch(() => {});
      await pool?.end();
    });

    beforeEach(async () => {
      await pool.query("delete from swarms");
    });

    async function makeSwarm(status: (typeof swarms.$inferSelect)["status"] = "running") {
      const [swarm] = await db
        .insert(swarms)
        .values({
          workerIsolation: "worktree",
          projectId: PROJECT,
          slug: `s-${Math.random().toString(36).slice(2, 8)}`,
          title: "Swarm",
          status,
        })
        .returning();
      return swarm!;
    }

    test("an enqueue during an active tick produces exactly one following tick", { timeout: 20_000 }, async () => {
      const seen: string[] = [];
      const started = deferred();
      const release = deferred();
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        await workQueue<{ swarmId: string }>(jobs, "swarm.tick", async (data) => {
          seen.push(data.swarmId);
          if (seen.length === 1) {
            started.resolve();
            await release.promise;
          }
        });
        await enqueueSwarmTick(isolated, "swarm-a");
        await enqueueSwarmTick(isolated, "swarm-a");
        await started.promise;
        assert.deepEqual(seen, ["swarm-a"]);
        await enqueueSwarmTick(isolated, "swarm-a");
        await enqueueSwarmTick(isolated, "swarm-a");
        release.resolve();
        await waitFor(() => seen.length === 2);
        assert.deepEqual(seen, ["swarm-a", "swarm-a"]);
      } finally {
        await jobs.stop().catch(() => {});
      }
    });

    test("duplicate landing enqueues are one job until it finishes", { timeout: 20_000 }, async () => {
      const seen: string[] = [];
      const started = deferred();
      const release = deferred();
      const firstDone = deferred();
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        await workQueue<{ landingId: string }>(jobs, "swarm.land", async (data) => {
          seen.push(data.landingId);
          if (seen.length === 1) {
            started.resolve();
            await release.promise;
            firstDone.resolve();
          }
        });
        await enqueueLanding(isolated, "landing-a");
        await enqueueLanding(isolated, "landing-a");
        await started.promise;
        assert.deepEqual(seen, ["landing-a"]);
        release.resolve();
        await firstDone.promise;
        await new Promise((r) => setTimeout(r, 150));
        await enqueueLanding(isolated, "landing-a");
        await waitFor(() => seen.length === 2);
        assert.deepEqual(seen, ["landing-a", "landing-a"]);
      } finally {
        await jobs.stop().catch(() => {});
      }
    });

    test("duplicate publish enqueues are one job until it finishes", { timeout: 20_000 }, async () => {
      const seen: string[] = [];
      const started = deferred();
      const release = deferred();
      const firstDone = deferred();
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        await workQueue<{ swarmId: string }>(jobs, "swarm.publish", async (data) => {
          seen.push(data.swarmId);
          if (seen.length === 1) {
            started.resolve();
            await release.promise;
            firstDone.resolve();
          }
        });
        await enqueueSwarmPublish(isolated, "swarm-p");
        await enqueueSwarmPublish(isolated, "swarm-p");
        await started.promise;
        assert.deepEqual(seen, ["swarm-p"]);
        release.resolve();
        await firstDone.promise;
        await new Promise((r) => setTimeout(r, 150));
        await enqueueSwarmPublish(isolated, "swarm-p");
        await waitFor(() => seen.length === 2);
        assert.deepEqual(seen, ["swarm-p", "swarm-p"]);
      } finally {
        await jobs.stop().catch(() => {});
      }
    });

    test("a redelivered landing is a no-op once the row has left landing", { timeout: 20_000 }, async () => {
      const swarm = await makeSwarm("running");
      const [task] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "leaf" }).returning();
      const [landing] = await db
        .insert(swarmLandings)
        .values({ swarmId: swarm.id, taskId: task!.id, position: 0, status: "landed", attempt: 1 })
        .returning();

      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        const outcomes: Array<string | null> = [];
        await workQueue<{ landingId: string }>(jobs, "swarm.land", async (data) => {
          outcomes.push((await performLanding(isolated, data.landingId))?.status ?? null);
        });
        await enqueueLanding(isolated, landing!.id);
        await waitFor(() => outcomes.length === 1);
        assert.equal(outcomes[0], null, "a finished landing is not performed again");
        assert.equal((await performLanding(isolated, landing!.id))?.status ?? null, null);
        const [row] = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
        assert.equal(row!.status, "landed");
      } finally {
        await jobs.stop().catch(() => {});
      }
    });

    test("a redelivered publish is refused unless the swarm is done", { timeout: 20_000 }, async () => {
      const swarm = await makeSwarm("running");
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        const skipped: string[] = [];
        await workQueue<{ swarmId: string }>(jobs, "swarm.publish", async (data) => {
          skipped.push((await publishFinishedSwarm(isolated, data.swarmId))?.skipped ?? "");
        });
        await enqueueSwarmPublish(isolated, swarm.id);
        await waitFor(() => skipped.length === 1);
        assert.match(skipped[0]!, /not done/);
        assert.match((await publishFinishedSwarm(isolated, swarm.id))?.skipped ?? "", /not done/);
      } finally {
        await jobs.stop().catch(() => {});
      }
    });

    test("recovery requeues a live swarm tick and a claimed landing", { timeout: 20_000 }, async () => {
      const live = await makeSwarm("running");
      const claimedSwarm = await makeSwarm("running");
      const [task] = await db.insert(swarmTasks).values({ swarmId: claimedSwarm.id, title: "leaf" }).returning();
      const [landing] = await db
        .insert(swarmLandings)
        .values({ swarmId: claimedSwarm.id, taskId: task!.id, position: 0, status: "landing", attempt: 1 })
        .returning();

      const ticked: string[] = [];
      const landed: string[] = [];
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: isolation(backend),
      });
      const isolated = { ...ctx, jobs } as AppContext;
      try {
        await workQueue<{ swarmId: string }>(jobs, "swarm.tick", async (data) => {
          ticked.push(data.swarmId);
        });
        await workQueue<{ landingId: string }>(jobs, "swarm.land", async (data) => {
          landed.push(data.landingId);
        });

        const n = await tickAllLiveSwarms(isolated);
        assert.ok(n >= 2, "every live swarm is asked for again");
        const resumed = await resumeClaimedLandings(isolated);
        assert.ok(resumed >= 1);

        await waitFor(
          () => ticked.includes(live.id) && ticked.includes(claimedSwarm.id) && landed.includes(landing!.id),
        );
        assert.ok(ticked.includes(live.id));
        assert.ok(ticked.includes(claimedSwarm.id));
        assert.deepEqual(
          landed.filter((id) => id === landing!.id),
          [landing!.id],
        );
      } finally {
        await jobs.stop().catch(() => {});
      }
    });
  });
}
