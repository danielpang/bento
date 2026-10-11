import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeJobQueue } from "../jobs/index.js";
import { enqueueGateEvaluate, enqueueRun, INTERACTIVE_POLL_SECONDS, QUEUE_POLL_SECONDS, RUN_WORKER_POLL_SECONDS } from "./queue.js";
import { QUEUED_RUN_REQUEUE_MIN, serverRunQueuedKey } from "./work-timers.js";

function executeAndRecovery(runId: string) {
  return [
    { queue: "run.execute" as const, data: { runId } },
    {
      queue: "runner.reap" as const,
      data: { runId, kind: "stranded" },
      opts: { debounceKey: serverRunQueuedKey(runId), delayMs: QUEUED_RUN_REQUEUE_MIN * 60_000 },
    },
  ];
}

test("enqueueRun sends the job before it wakes pg-boss workers", async () => {
  const jobs = new FakeJobQueue();
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, executeAndRecovery("run-1"));
  assert.deepEqual(jobs.woken, ["run.execute"]);
});

test("enqueueRun still queues when this process has no run workers", async () => {
  const jobs = new FakeJobQueue();
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, executeAndRecovery("run-1"));
});

test("enqueueRun does not wake a BullMQ queue", async () => {
  const jobs = new FakeJobQueue("bullmq");
  await enqueueRun({ jobs }, "run-1");
  assert.deepEqual(jobs.sent, executeAndRecovery("run-1"));
  assert.deepEqual(jobs.woken, []);
});

test("enqueueGateEvaluate coalesces on the feature id", async () => {
  const jobs = new FakeJobQueue();
  await enqueueGateEvaluate({ jobs }, "feat-1");
  await enqueueGateEvaluate({ jobs }, "feat-1");
  assert.deepEqual(jobs.sent, [
    { queue: "gate.evaluate", data: { featureId: "feat-1" }, opts: { coalesceKey: "feat-1" } },
    { queue: "gate.evaluate", data: { featureId: "feat-1" }, opts: { coalesceKey: "feat-1" } },
  ]);
});

test("enqueueGateEvaluate does not wake workers", async () => {
  const jobs = new FakeJobQueue();
  await enqueueGateEvaluate({ jobs }, "feat-1");
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

test("registerJobs does not poll gated cards or runner claims on a five-minute cron", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-executor.ts"), "utf8");
  assert.doesNotMatch(src, /schedule\("gate\.sweep",\s*"gate\.sweep",\s*"\*\/5/);
  assert.doesNotMatch(src, /schedule\("runner\.reap",\s*"runner\.reap",\s*"\*\/5/);
  assert.match(src, /armServerRunStallRecovery\(ctx,\s*runId\)/);
  assert.match(src, /reconcileServerRunRecoveries\(ctx\)/);
});

test("registerJobs keeps Modal cleanup daily and snapshots from the queue", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "run-executor.ts"), "utf8");
  const snapshot = readFileSync(join(here, "queue-snapshot.ts"), "utf8");
  assert.match(src, /schedule\(MODAL_SWEEP_QUEUE,\s*MODAL_SWEEP_QUEUE,\s*MODAL_SWEEP_CRON\)/);
  assert.match(snapshot, /jobs\.counts\("run\.execute"\)/);
});

test("Linear sweep is hourly and connect/disconnect recompute the signal", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sync = readFileSync(join(here, "linear-sync.ts"), "utf8");
  const routes = readFileSync(join(here, "..", "routes", "linear.ts"), "utf8");
  const executor = readFileSync(join(here, "run-executor.ts"), "utf8");
  assert.match(sync, /LINEAR_SWEEP_CRON = "0 \* \* \* \*"/);
  assert.doesNotMatch(sync, /\*\/15 \* \* \* \*/);
  assert.match(sync, /syncLinearConnectedPresence\(ctx\)/);
  assert.match(routes, /syncLinearConnectedPresence\(ctx\)/);
  assert.match(executor, /syncLinearConnectedPresence\(ctx\)/);
});

test("runner claim and events refresh the per-run lease", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "runner.ts"), "utf8");
  assert.match(src, /refreshRunnerLease\(ctx,\s*candidate\.run\.id\)/);
  assert.match(src, /refreshRunnerLease\(ctx,\s*runId\)/);
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
 * A bare send still works, and two of the same card would each run.
 * The helper is what keeps a burst of webhooks and finishing runs
 * one evaluation, plus one rerun if that evaluation is already going.
 */
test("gate.evaluate jobs go through enqueueGateEvaluate, not a bare send", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "jobs") continue;
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      if (ent.name === "queue.ts" || ent.name === "queue.test.ts") continue;
      const src = readFileSync(path, "utf8");
      if (src.includes('jobs.send("gate.evaluate"') || src.includes("jobs.send('gate.evaluate'")) {
        offenders.push(path.slice(srcRoot.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `bare gate.evaluate send in ${offenders.join(", ")}`);
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

/**
 * Named route producers that write a row the worker will re-read.
 * A send from inside the tenant transaction can be claimed before that
 * row is visible; the worker then finds nothing and acks.
 */
const ROUTE_QUEUE_PRODUCERS = [
  "enqueueRun",
  "queueRunFinishedSlack",
  "markSandboxAwake",
  "armModalHibernation",
] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function matchingParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isInsideDeferAfterCommit(src: string, index: number): boolean {
  let from = 0;
  while (from < index) {
    const start = src.indexOf("deferAfterCommit", from);
    if (start === -1 || start >= index) return false;
    const paren = src.indexOf("(", start + "deferAfterCommit".length);
    if (paren === -1) return false;
    const end = matchingParen(src, paren);
    if (end === -1) return false;
    if (index > paren && index < end) return true;
    from = start + 1;
  }
  return false;
}

/** Route enqueue sites that are not wrapped in deferAfterCommit. */
function undeferredRouteEnqueues(src: string): string[] {
  const body = stripComments(src);
  const re = new RegExp(`\\b(${ROUTE_QUEUE_PRODUCERS.join("|")})\\s*\\(`, "g");
  const offenders: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    if (!isInsideDeferAfterCommit(body, match.index)) offenders.push(match[1]!);
  }
  return offenders;
}

test("the queue source guard rejects an undeferred route enqueue", () => {
  assert.deepEqual(
    undeferredRouteEnqueues(`
      if (executor === "server") await enqueueRun(ctx, run.id);
      deferAfterCommit(c, () => enqueueGateEvaluate(ctx, feature.id));
    `),
    ["enqueueRun"],
  );
});

test("the queue source guard accepts a deferred route enqueue", () => {
  assert.deepEqual(
    undeferredRouteEnqueues(`
      if (executor === "server") deferAfterCommit(c, () => enqueueRun(ctx, run.id));
      deferAfterCommit(c, async () => { await enqueueRun(ctx, started.id); });
      deferAfterCommit(c, () => queueRunFinishedSlack(ctx, runId));
      deferAfterCommit(c, () => markSandboxAwake(ctx.db, ctx, sandbox.id));
    `),
    [],
  );
});

test("named route producers enqueue only after commit", () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
  const offenders: string[] = [];
  for (const ent of readdirSync(routesDir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
    const rel = `routes/${ent.name}`;
    const found = undeferredRouteEnqueues(readFileSync(join(routesDir, ent.name), "utf8"));
    for (const name of found) offenders.push(`${rel}:${name}`);
  }
  assert.deepEqual(offenders, [], `undeferred route enqueue in ${offenders.join(", ")}`);
});
