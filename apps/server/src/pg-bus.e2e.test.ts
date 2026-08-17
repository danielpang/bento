import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { createDb, createPool, runEvents, runMigrations } from "@bento/db";
import type { AgentEvent } from "@bento/core";
import { SseParser } from "@bento/core";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { registerJobs } from "./orchestrator/run-executor.js";
import { attachPgBus, type PgBus } from "./pg-bus.js";

const run = promisify(execFile);

/**
 * The production bug, reproduced end to end: two full server stacks
 * against one database, standing in for two Fly machines. The run
 * executes on server A (only A registers pg-boss workers) and the
 * viewer's SSE stream is served by server B, which never touches the
 * run. Before the bus was replicated, B's stream replayed whatever
 * was persisted at open and then sat silent forever.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "pg_bus_e2e_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctxA: AppContext;
let ctxB: AppContext;
let appA: ReturnType<typeof createApp>;
let appB: ReturnType<typeof createApp>;
let pgBusA: PgBus;
let pgBusB: PgBus;
let repoDir: string;

async function makeContext(): Promise<AppContext> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-pgbus-data-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
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
    driver: new LocalProcessDriver(),
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

  repoDir = await mkdtemp(path.join(tmpdir(), "bento-pgbus-repo-"));
  await run("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n");
  await run("git", ["-C", repoDir, "add", "-A"]);
  await run("git", ["-C", repoDir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "init"]);

  ctxA = await makeContext();
  ctxB = await makeContext();
  // Only A works the queue, so every run executes there; B is purely
  // a viewer's machine.
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

/** Same frame reader the main e2e uses: the parser real clients run. */
function sseFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const pending: { event: string; data: string }[] = [];
  return {
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

test("a run executing on one server streams live to a viewer on the other", { timeout: 120_000 }, async () => {
  // All writes go through A; B first hears of the run when the viewer
  // opens the stream.
  const project = await json<{ id: string }>(
    await appA.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cross machine", localPath: repoDir }),
    }),
  );
  // Seeded agents off the stages, or advancing the card would start a
  // real claude-code run instead of the fake.
  const pipeline = await json<{ stages: { id: string }[] }>(
    await appA.request(`/api/projects/${project.id}/pipeline`),
  );
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
      body: JSON.stringify({ projectId: project.id, title: "Cross machine card", description: "e2e" }),
    }),
  );
  const profile = await json<{ id: string }>(
    await appA.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pgbus-fake", cli: "fake", model: "fake-1" }),
    }),
  );
  await appA.request(`/api/features/${feature.id}/advance`, { method: "POST" });

  const started = await json<{ id: string }>(
    await appA.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id, prompt: "LIVE hello" }),
    }),
  );

  // The viewer lands on the machine that is not executing the run,
  // subscribed before the worker picks it up.
  const live = await appB.request(`/api/runs/${started.id}/events?since=0`);
  assert.ok(live.body, "the events endpoint streams on the non-executing server");
  const frames = sseFrames(live.body!);
  const deltas: { channel: string; text: string }[] = [];
  let sawMessage = false;
  let status = "";
  try {
    while (true) {
      const frame = await frames.next();
      assert.ok(frame, "the stream ends with done, not a bare EOF");
      if (frame.event === "run_delta") deltas.push(JSON.parse(frame.data) as { channel: string; text: string });
      if (frame.event === "run_event" && frame.data.includes("Heard.")) sawMessage = true;
      if (frame.event === "done") {
        status = (JSON.parse(frame.data) as { status: string }).status;
        break;
      }
    }
  } finally {
    await frames.cancel();
  }
  assert.equal(status, "succeeded", "the terminal status crossed servers instead of the stream hanging");
  assert.ok(
    deltas.some((d) => d.channel === "text" && d.text.includes("Heard.")),
    "the fragment being typed on server A reached the viewer on server B",
  );
  assert.ok(sawMessage, "the finished message crossed servers as a run event");

  // And the replay path still works from B once the run is over.
  const replay = await appB.request(`/api/runs/${started.id}/events?since=0`);
  const replayFrames = sseFrames(replay.body!);
  let replayed = false;
  try {
    while (true) {
      const frame = await replayFrames.next();
      assert.ok(frame, "the replay ends with done");
      if (frame.event === "run_event" && frame.data.includes("Heard.")) replayed = true;
      if (frame.event === "done") break;
    }
  } finally {
    await replayFrames.cancel();
  }
  assert.ok(replayed, "the persisted transcript replays from the non-executing server");
});
