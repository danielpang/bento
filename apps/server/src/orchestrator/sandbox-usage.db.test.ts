import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, createPool, projects, sandboxes, sandboxUsageLeases, runMigrations } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import { ensureLocalUser, type AppContext } from "../context.js";
import { withSandboxGeneration } from "./sandbox-generation.js";
import { acquireSandboxUsage, renewSandboxUsage, usingSandboxDriver, withSandboxUsage, SandboxInUse } from "./sandbox-usage.js";
const base = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const url = base.replace(/\/[^/]+$/, "/sandbox_usage_test");
let ctx: AppContext;
let row: typeof sandboxes.$inferSelect;
before(async () => {
  const admin = new pg.Client({ connectionString: base }); await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS sandbox_usage_test WITH (FORCE)");
  await admin.query("CREATE DATABASE sandbox_usage_test"); await admin.end();
  await runMigrations(url);
  const pool = createPool(url), db = createDb(pool);
  const ownerId = await ensureLocalUser(db);
  const [project] = await db.insert(projects).values({ ownerId, name: "Usage" }).returning();
  [row] = await db.insert(sandboxes).values({ projectId: project!.id, provider: "docker", externalId: "usage-box", status: "ready" }).returning() as [typeof row];
  ctx = { db, pool } as AppContext;
});
after(async () => { await ctx?.pool.end(); });

test("multiple readers keep destruction out until the last reader releases", async () => {
  let destroyed = false;
  await withSandboxUsage(ctx, row.id, "export", async () => {
    const other = await acquireSandboxUsage(ctx, row.id, "check");
    await assert.rejects(withSandboxGeneration(ctx, row, async () => { destroyed = true; }), SandboxInUse);
    assert.equal(destroyed, false);
    await ctx.db.delete(sandboxUsageLeases).where(eq(sandboxUsageLeases.id, other.id));
    await assert.rejects(withSandboxGeneration(ctx, row, async () => { destroyed = true; }), SandboxInUse);
  });
  const leases = await ctx.db.select().from(sandboxUsageLeases);
  assert.equal(leases.length, 0);
});

test("an expired lease cannot be renewed after cleanup could have acquired the machine", async () => {
  const lease = await acquireSandboxUsage(ctx, row.id, "expired reader");
  await ctx.db.update(sandboxUsageLeases).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(sandboxUsageLeases.id, lease.id));
  assert.equal(await renewSandboxUsage(ctx, lease.id), false);
  await ctx.db.delete(sandboxUsageLeases).where(eq(sandboxUsageLeases.id, lease.id));
});

test("the execution stream holds a lease until consumption ends, including early return", async () => {
  const raw = { provider: "docker", workspace: "host", async *exec() {
    yield { kind: "stdout", data: "hello" } as const;
    yield { kind: "exit", exitCode: 0 } as const;
  } } as SandboxDriver;
  const driver = usingSandboxDriver(ctx, raw, row.id);
  for await (const chunk of driver.exec({ externalId: row.externalId, provider: "docker", workdir: "/workspace" }, ["test"])) {
    assert.equal(chunk.kind, "stdout");
    const leases = await ctx.db.select().from(sandboxUsageLeases);
    assert.equal(leases.length, 1);
    break;
  }
  assert.equal((await ctx.db.select().from(sandboxUsageLeases)).length, 0);
});

test("destruction commits while holding its lock so a later reader cannot enter the destroyed machine", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const destroying = withSandboxGeneration(ctx, row, async () => { entered(); await gate; });
  await started;
  const reader = assert.rejects(acquireSandboxUsage(ctx, row.id, "late reader"));
  finish();
  await destroying;
  await reader;
});


test("cancelling while a command waits for its usage lease prevents the command from starting", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "cancel-box", status: "ready" }).returning();
  let entered!: () => void, finish!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const locked = ctx.db.transaction(async (tx) => {
    await tx.select().from(sandboxes).where(eq(sandboxes.id, box!.id)).for("update");
    entered();
    await gate;
  });
  await acquired;
  let started = false;
  const raw = { provider: "docker", workspace: "host", async *exec() {
    started = true;
    yield { kind: "exit", exitCode: 0 } as const;
  } } as SandboxDriver;
  const controller = new AbortController();
  const driver = usingSandboxDriver(ctx, raw, box!.id);
  const stream = driver.exec({ externalId: box!.externalId, provider: "docker", workdir: "/workspace" }, ["test"], { signal: controller.signal });
  const rejected = assert.rejects(stream[Symbol.asyncIterator]().next(), /aborted/);
  controller.abort();
  finish();
  await locked;
  await rejected;
  assert.equal(started, false);
  assert.equal((await ctx.db.select().from(sandboxUsageLeases)).length, 0);
});
