import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, createPool, projects, sandboxes, sandboxUsageLeases, runMigrations } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import { ensureLocalUser, type AppContext } from "../context.js";
import { stopLeftoverAgent } from "./leftover-agent.js";
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

test("stopping a leftover agent releases its attachment lease on the exit chunk", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "attach-leak", status: "ready" }).returning();
  let calls = 0;
  const raw = { provider: "docker", workspace: "host", async attach() {
    if (++calls > 1) return null;
    return (async function* () { yield { kind: "exit", exitCode: 0 } as const; })();
  } } as unknown as SandboxDriver;
  const driver = usingSandboxDriver(ctx, raw, box!.id);
  assert.equal(await stopLeftoverAgent(driver, { externalId: "attach-leak", provider: "docker", workdir: "/workspace" }, [["agent"]], { stopMs: 100 }), "stopped");
  const leases = await ctx.db.select().from(sandboxUsageLeases).where(eq(sandboxUsageLeases.sandboxId, box!.id));
  assert.equal(leases.length, 0);
  await withSandboxGeneration(ctx, box!, async () => {});
});

test("returning an attachment before its first next releases its lease", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "unstarted", status: "ready" }).returning();
  const raw = { provider: "docker", workspace: "host", async attach() {
    return (async function* () { yield { kind: "exit", exitCode: 0 } as const; })();
  } } as unknown as SandboxDriver;
  const driver = usingSandboxDriver(ctx, raw, box!.id);
  const stream = await driver.attach!({ externalId: "unstarted", provider: "docker", workdir: "/workspace" }, ["agent"]);
  await stream![Symbol.asyncIterator]().return!();
  assert.equal((await ctx.db.select().from(sandboxUsageLeases).where(eq(sandboxUsageLeases.sandboxId, box!.id))).length, 0);
});

test("renewal cannot resurrect a lease that expires while its row is locked", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "renew-race", status: "ready" }).returning();
  const lease = await acquireSandboxUsage(ctx, box!.id, "renewing");
  await ctx.db.update(sandboxUsageLeases).set({ expiresAt: sql`clock_timestamp() + interval '1 second'` }).where(eq(sandboxUsageLeases.id, lease.id));
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { unlock = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const blocker = ctx.db.transaction(async (tx) => {
    await tx.select().from(sandboxUsageLeases).where(eq(sandboxUsageLeases.id, lease.id)).for("update");
    locked();
    await gate;
  });
  await ready;
  const renewal = renewSandboxUsage(ctx, lease.id);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  unlock();
  await blocker;
  assert.equal(await renewal, false);
  await withSandboxGeneration(ctx, box!, async () => {});
});

test("acquisition dates the lease after its sandbox lock wait", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "acquire-wait", status: "ready" }).returning();
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { unlock = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const blocker = ctx.db.transaction(async (tx) => {
    await tx.select().from(sandboxes).where(eq(sandboxes.id, box!.id)).for("update");
    locked();
    await gate;
  });
  await ready;
  const acquisition = acquireSandboxUsage(ctx, box!.id, "waiting");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  unlock();
  await blocker;
  const lease = await acquisition;
  const result = await ctx.db.execute<{ remaining: number }>(sql`select extract(epoch from (expires_at - clock_timestamp()))::float8 as remaining from sandbox_usage_leases where id = ${lease.id}`);
  assert.ok(result.rows[0]!.remaining > 89, "the lock wait must not consume the newly issued lease");
  await ctx.db.delete(sandboxUsageLeases).where(eq(sandboxUsageLeases.id, lease.id));
});

test("repository transfers receive the usage signal combined with caller cancellation", async () => {
  const [box] = await ctx.db.insert(sandboxes).values({ projectId: row.projectId, provider: "docker", externalId: "transfer-cancel", status: "ready" }).returning();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const raw = { provider: "docker", workspace: "host", async exportRepository(_handle, _repository, _base, options) {
    assert.ok(options?.signal);
    assert.notEqual(options.signal, controller.signal);
    assert.equal(options.signal.aborted, false);
    const leases = await ctx.db.select().from(sandboxUsageLeases).where(eq(sandboxUsageLeases.sandboxId, box!.id));
    assert.equal(leases.length, 1);
    const cancelled = new Promise<never>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    entered();
    return cancelled;
  } } as SandboxDriver;
  const driver = usingSandboxDriver(ctx, raw, box!.id);
  const transfer = driver.exportRepository!({ externalId: box!.externalId, provider: "docker", workdir: "/workspace" }, "repo", "main", { signal: controller.signal });
  const rejected = assert.rejects(transfer, /cancelled transfer/);
  await started;
  controller.abort(new Error("cancelled transfer"));
  await rejected;
  assert.equal((await ctx.db.select().from(sandboxUsageLeases).where(eq(sandboxUsageLeases.sandboxId, box!.id))).length, 0);
});
