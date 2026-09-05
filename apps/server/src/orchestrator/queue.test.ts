import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type PgBoss from "pg-boss";
import { enqueueRun, INTERACTIVE_POLL_SECONDS, QUEUE_POLL_SECONDS, RUN_WORKER_POLL_SECONDS } from "./queue.js";

function fakeBoss() {
  const calls: Array<{ op: "send" | "notify"; arg: unknown }> = [];
  const boss = {
    send: async (name: string, data: object) => {
      calls.push({ op: "send", arg: [name, data] });
      return "job-1";
    },
    notifyWorker: (id: string) => {
      calls.push({ op: "notify", arg: id });
    },
  };
  return { boss: boss as unknown as PgBoss, calls };
}

test("enqueueRun sends the job before it wakes workers", async () => {
  const { boss, calls } = fakeBoss();
  await enqueueRun({ boss, runWorkers: ["w1", "w2"] }, "run-1");
  assert.deepEqual(calls, [
    { op: "send", arg: ["run.execute", { runId: "run-1" }] },
    { op: "notify", arg: "w1" },
    { op: "notify", arg: "w2" },
  ]);
});

test("enqueueRun still queues when this process has no run workers", async () => {
  const { boss, calls } = fakeBoss();
  await enqueueRun({ boss }, "run-1");
  assert.deepEqual(calls, [{ op: "send", arg: ["run.execute", { runId: "run-1" }] }]);
});

test("run workers poll slower than a queue a person is waiting on", () => {
  assert.ok(RUN_WORKER_POLL_SECONDS > QUEUE_POLL_SECONDS);
  assert.ok(QUEUE_POLL_SECONDS > INTERACTIVE_POLL_SECONDS);
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
      if (src.includes('boss.send("run.execute"') || src.includes("boss.send('run.execute'")) {
        offenders.push(path.slice(srcRoot.length + 1));
      }
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `bare run.execute send in ${offenders.join(", ")}`);
});
