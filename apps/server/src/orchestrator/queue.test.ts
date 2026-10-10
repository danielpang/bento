import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeJobQueue } from "../jobs/index.js";
import { enqueueRun, INTERACTIVE_POLL_SECONDS, QUEUE_POLL_SECONDS, RUN_WORKER_POLL_SECONDS } from "./queue.js";

test("enqueueRun sends the job before it wakes pg-boss workers", async () => {
  const jobs = new FakeJobQueue();
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, [{ queue: "run.execute", data: { runId: "run-1" } }]);
  assert.deepEqual(jobs.woken, ["run.execute"]);
});

test("enqueueRun still queues when this process has no run workers", async () => {
  const jobs = new FakeJobQueue();
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, [{ queue: "run.execute", data: { runId: "run-1" } }]);
});

test("enqueueRun does not wake a BullMQ queue", async () => {
  const jobs = new FakeJobQueue("bullmq");
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, [{ queue: "run.execute", data: { runId: "run-1" } }]);
  assert.deepEqual(jobs.woken, []);
});

test("run workers poll slower than a queue a person is waiting on", () => {
  assert.ok(RUN_WORKER_POLL_SECONDS > QUEUE_POLL_SECONDS);
  assert.ok(QUEUE_POLL_SECONDS > INTERACTIVE_POLL_SECONDS);
});

test("registerJobs uses one run.execute worker width and re-arms Modal sandboxes", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-executor.ts"), "utf8");
  assert.match(src, /concurrency:\s*ctx\.env\.BENTO_MAX_CONCURRENT_RUNS/);
  assert.match(src, /rearmReadyModalSandboxes\(ctx\)/);
});

/**
 * A bare send still works, which is exactly why nothing else would
 * catch one: the run starts on the next poll, thirty seconds later,
 * and reads as a slow server rather than a bug.
 */
test("run.execute jobs go through enqueueRun, not a bare send", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      if (ent.name === "queue.ts" || ent.name === "queue.test.ts") continue;
      const src = readFileSync(path, "utf8");
      if (src.includes('jobs.send("run.execute"') || src.includes("jobs.send('run.execute'")) {
        offenders.push(path.slice(srcRoot.length + 1));
      }
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `bare run.execute send in ${offenders.join(", ")}`);
});

/**
 * AppContext.jobs is the only door. The pg-boss client lives inside
 * the adapter, so a leftover ctx.boss is a call that skipped it.
 */
test("ctx.boss stays inside the pg-boss adapter", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const allowed = new Set(["jobs/pg-boss.ts"]);
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      const rel = path.slice(srcRoot.length + 1).replaceAll("\\", "/");
      if (allowed.has(rel) || rel === "orchestrator/queue.test.ts") continue;
      const src = readFileSync(path, "utf8");
      if (src.includes("ctx.boss") || src.includes("context.boss")) {
        offenders.push(rel);
      }
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `ctx.boss outside the adapter in ${offenders.join(", ")}`);
});
