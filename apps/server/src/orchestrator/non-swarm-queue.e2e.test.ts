import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  createDb,
  createPool,
  features,
  pipelines,
  projects,
  runMigrations,
  sandboxes,
  stages,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import pg from "pg";
import { createApp } from "../app.js";
import { DiskArtifactStore } from "../artifact-store.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { createTestJobQueue, realQueueBackends, testDatabaseName } from "../jobs/test-queue.js";
import { SecretBox } from "../secrets.js";
import { singleDriver } from "./sandbox-driver.js";
import { HIBERNATE_SANDBOX_QUEUE } from "./hibernate-sandbox.js";
import { registerJobs } from "./run-executor.js";

const run = promisify(execFile);

/**
 * Non-swarm cutover: registerJobs on both adapters, one run.execute
 * Worker (BullMQ) vs paced pg-boss workers, and boot re-arm of ready
 * Modal sandboxes. Linear and Slack registration is covered by their
 * own dual-run suites; this file is the run / gate / sandbox door.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbBase = "non_swarm_queue_test";

for (const backend of realQueueBackends()) {
  const testDbName = testDatabaseName(testDbBase, backend);
  const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

  describe(`queue:${backend}`, () => {
    let ctx: AppContext;
    let app: ReturnType<typeof createApp>;
    let repoDir: string;
    let readySandboxId: string;

    async function json<T>(res: Response): Promise<T> {
      if (!res.ok && res.status !== 201) {
        assert.fail(`unexpected status ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    }

    before(async () => {
      const admin = new pg.Client({ connectionString: baseUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${testDbName}`);
      await admin.end();
      await runMigrations(testUrl);

      repoDir = await mkdtemp(path.join(tmpdir(), "bento-nonswarm-repo-"));
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

      const dataDir = await mkdtemp(path.join(tmpdir(), "bento-nonswarm-data-"));
      const env = loadEnv({
        BENTO_MODE: "local",
        DATABASE_URL: testUrl,
        BENTO_DATA_DIR: dataDir,
        BENTO_SANDBOX_DRIVER: "local-process",
        BENTO_LIVE_IDLE_SEC: "0",
        BENTO_MAX_CONCURRENT_RUNS: "4",
      } as NodeJS.ProcessEnv);
      const pool = createPool(testUrl);
      const db = createDb(pool);
      const jobs = await createTestJobQueue({
        backend,
        postgresUrl: testUrl,
        isolation: `${testDbName}-${backend}`,
      });
      const userId = await ensureLocalUser(db);
      ctx = {
        env,
        db,
        pool,
        jobs,
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

      const [project] = await db
        .insert(projects)
        .values({ ownerId: userId, name: "Boot re-arm", localPath: repoDir })
        .returning({ id: projects.id });
      const [pipeline] = await db
        .insert(pipelines)
        .values({ projectId: project!.id, name: "Default", isDefault: true })
        .returning({ id: pipelines.id });
      await db
        .insert(stages)
        .values({ pipelineId: pipeline!.id, position: 0, name: "Implementation", slug: "implementation" });
      const [feature] = await db
        .insert(features)
        .values({ projectId: project!.id, pipelineId: pipeline!.id, title: "Ready modal" })
        .returning({ id: features.id });
      const [sandbox] = await db
        .insert(sandboxes)
        .values({
          projectId: project!.id,
          featureId: feature!.id,
          provider: "modal",
          externalId: `bento-${feature!.id}`,
          status: "ready",
          workdir: "/workspace",
          lastUsedAt: new Date(),
        })
        .returning({ id: sandboxes.id });
      readySandboxId = sandbox!.id;

      await registerJobs(ctx);
      app = createApp(ctx);
    });

    after(async () => {
      await ctx.jobs.stop();
      await ctx.pool.end();
    });

    test("registerJobs re-arms a ready Modal sandbox at boot", async () => {
      const counts = await ctx.jobs.counts(HIBERNATE_SANDBOX_QUEUE);
      assert.ok(
        counts.delayed + counts.waiting + counts.active >= 1,
        `expected a hibernate job after boot, got ${JSON.stringify(counts)}`,
      );
      const [row] = await ctx.db
        .select({ status: sandboxes.status, provider: sandboxes.provider })
        .from(sandboxes)
        .where(eq(sandboxes.id, readySandboxId));
      assert.equal(row?.provider, "modal");
      assert.equal(row?.status, "ready");
    });

    test("a fake-agent run finishes and the gate evaluates without a poll wake", { timeout: 90_000 }, async () => {
      if (backend === "bullmq") assert.equal(ctx.jobs.kind, "bullmq");
      if (backend === "pg-boss") assert.equal(ctx.jobs.kind, "pg-boss");

      const project = await json<{ id: string }>(
        await app.request("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Cutover", localPath: repoDir }),
        }),
      );
      const pipeline = await json<{ stages: { id: string }[] }>(
        await app.request(`/api/projects/${project.id}/pipeline`),
      );
      for (const stage of pipeline.stages) {
        await json(
          await app.request(`/api/stages/${stage.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ defaultAgentProfileId: null }),
          }),
        );
      }
      const feature = await json<{ id: string }>(
        await app.request("/api/features", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, title: "Cutover run", description: "e2e" }),
        }),
      );
      await json(
        await app.request(`/api/features/${feature.id}/advance`, { method: "POST" }),
      );
      const profile = await json<{ id: string }>(
        await app.request("/api/profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Fake ${backend}`, cli: "fake", model: "fake-1" }),
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

      const deadline = Date.now() + 60_000;
      let runStatus = "";
      while (Date.now() < deadline) {
        const current = await json<{ status: string }>(await app.request(`/api/runs/${created.id}`));
        if (["succeeded", "failed", "cancelled"].includes(current.status)) {
          runStatus = current.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(runStatus, "succeeded");

      let featureStatus = "";
      const gateDeadline = Date.now() + 30_000;
      while (Date.now() < gateDeadline) {
        const current = await json<{ status: string }>(await app.request(`/api/features/${feature.id}`));
        if (current.status === "gated") {
          featureStatus = current.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(featureStatus, "gated");
    });
  });
}
