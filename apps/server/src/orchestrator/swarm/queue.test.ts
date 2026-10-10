import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeJobQueue } from "../../jobs/index.js";
import type { AppContext } from "../../context.js";
import { enqueueSwarmTick } from "./coordinator.js";
import { enqueueLanding } from "./landing.js";
import { enqueueSwarmPublish } from "./complete.js";

function ctxFor(jobs: FakeJobQueue): AppContext {
  return { jobs } as unknown as AppContext;
}

test("enqueueSwarmTick coalesces on the swarm id", async () => {
  const jobs = new FakeJobQueue();
  await enqueueSwarmTick(ctxFor(jobs), "s1");
  const tick = jobs.sent.find((job) => job.queue === "swarm.tick");
  assert.deepEqual(tick, { queue: "swarm.tick", data: { swarmId: "s1" }, opts: { coalesceKey: "s1" } });
});

test("enqueueSwarmTick starts a pg-boss worker and does not start a BullMQ one", async () => {
  const pg = new FakeJobQueue();
  await enqueueSwarmTick(ctxFor(pg), "s1");
  assert.ok(pg.worked.includes("swarm.tick"), "local/Mac still start the poll on first send");

  const bull = new FakeJobQueue("bullmq");
  await enqueueSwarmTick(ctxFor(bull), "s1");
  assert.ok(!bull.worked.includes("swarm.tick"), "multi mode registered the worker at boot");
  assert.deepEqual(bull.offWorked, []);
});

test("enqueueLanding dedupes on the landing id", async () => {
  const jobs = new FakeJobQueue();
  await enqueueLanding(ctxFor(jobs), "lid");
  assert.deepEqual(jobs.sent, [{ queue: "swarm.land", data: { landingId: "lid" }, opts: { dedupeKey: "lid" } }]);
  assert.ok(jobs.worked.includes("swarm.land"));
});

test("enqueueLanding does not start a BullMQ worker", async () => {
  const jobs = new FakeJobQueue("bullmq");
  await enqueueLanding(ctxFor(jobs), "lid");
  assert.ok(!jobs.worked.includes("swarm.land"));
  assert.deepEqual(jobs.sent, [{ queue: "swarm.land", data: { landingId: "lid" }, opts: { dedupeKey: "lid" } }]);
});

test("enqueueSwarmPublish dedupes on swarm and mode", async () => {
  const jobs = new FakeJobQueue();
  await enqueueSwarmPublish(ctxFor(jobs), "s1", "stacked");
  assert.deepEqual(jobs.sent, [
    { queue: "swarm.publish", data: { swarmId: "s1", mode: "stacked" }, opts: { dedupeKey: "s1:stacked" } },
  ]);
  assert.ok(jobs.worked.includes("swarm.publish"));
});

test("enqueueSwarmPublish does not start a BullMQ worker", async () => {
  const jobs = new FakeJobQueue("bullmq");
  await enqueueSwarmPublish(ctxFor(jobs), "s1");
  assert.ok(!jobs.worked.includes("swarm.publish"));
  assert.deepEqual(jobs.sent, [
    { queue: "swarm.publish", data: { swarmId: "s1", mode: "combined" }, opts: { dedupeKey: "s1:combined" } },
  ]);
});

test("registerJobs starts swarm workers eagerly on BullMQ", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../run-executor.ts"), "utf8");
  assert.match(src, /if \(ctx\.jobs\.kind === "bullmq"\)/);
  assert.match(src, /ensureSwarmTickWorker\(ctx\)/);
  assert.match(src, /ensureLandingWorker\(ctx\)/);
  assert.match(src, /ensureSwarmPublishWorker\(ctx\)/);
});

/**
 * A bare send still works, which is why the helpers exist: coalesce
 * and dedupe live on the enqueue, not on the queue name.
 */
test("swarm.tick jobs go through enqueueSwarmTick, not a bare send", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const allowed = new Set([
    "orchestrator/swarm/coordinator.ts",
    "orchestrator/swarm/landing.ts",
    "orchestrator/swarm/queue.test.ts",
  ]);
  assert.deepEqual(bareSends(srcRoot, "swarm.tick", allowed), []);
});

test("swarm.land jobs go through enqueueLanding, not a bare send", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const allowed = new Set(["orchestrator/swarm/landing.ts", "orchestrator/swarm/queue.test.ts"]);
  assert.deepEqual(bareSends(srcRoot, "swarm.land", allowed), []);
});

test("swarm.publish jobs go through enqueueSwarmPublish, not a bare send", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const allowed = new Set(["orchestrator/swarm/complete.ts", "orchestrator/swarm/queue.test.ts"]);
  assert.deepEqual(bareSends(srcRoot, "swarm.publish", allowed), []);
});

function bareSends(srcRoot: string, queue: string, allowed: Set<string>): string[] {
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "jobs") continue;
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
      const rel = path.slice(srcRoot.length + 1).replaceAll("\\", "/");
      if (allowed.has(rel)) continue;
      const src = readFileSync(path, "utf8");
      if (src.includes(`jobs.send("${queue}"`) || src.includes(`jobs.send('${queue}'`)) {
        offenders.push(rel);
      }
    }
  };
  visit(srcRoot);
  return offenders;
}
