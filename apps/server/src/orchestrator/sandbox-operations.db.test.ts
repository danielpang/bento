import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, createPool, projects, sandboxOperations, runMigrations } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import { ensureLocalUser, type AppContext } from "../context.js";
import { singleDriver } from "./sandbox-driver.js";
import { sandboxOperation, reconcileSandboxOperations } from "./sandbox-operations.js";

const base = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const url = base.replace(/\/[^/]+$/, "/sandbox_operations_test");
let ctx: AppContext;
let projectId: string;
let exists = true;
const handle = { externalId: "test-machine", provider: "sprite" as const, workdir: "/workspace" };
before(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS sandbox_operations_test WITH (FORCE)");
  await admin.query("CREATE DATABASE sandbox_operations_test");
  await admin.end();
  await runMigrations(url);
  const pool = createPool(url);
  const db = createDb(pool);
  const ownerId = await ensureLocalUser(db);
  const [project] = await db.insert(projects).values({ ownerId, name: "Operations" }).returning();
  projectId = project!.id;
  ctx = { db, pool, drivers: singleDriver({ provider: "sprite", exists: async () => exists } as SandboxDriver) } as AppContext;
});
after(async () => { await ctx?.pool.end(); });
const spec = () => ({ projectId, workspaceKey: "workspace", provider: "sprite", action: "destroy" as const, handle });

test("intent and acquired handle survive an ambiguous provider error, without saving its text", async () => {
  await assert.rejects(sandboxOperation(ctx, spec(), async (record) => {
    await record(handle);
    const rows = await ctx.db.select().from(sandboxOperations);
    assert.equal(rows.at(-1)!.state, "executing");
    throw new Error("secret that must not be persisted");
  }));
  const [row] = await ctx.db.select().from(sandboxOperations);
  assert.equal(row!.state, "unknown");
  assert.equal(row!.handle!.externalId, handle.externalId);
  assert.equal(row!.errorClass, "Error");
  assert.ok(!JSON.stringify(row).includes("secret that"));
});

test("recovery observes a completed destroy without issuing a second destroy", async () => {
  await ctx.db.update(sandboxOperations).set({ heartbeatAt: sql`now() - interval '10 minutes'` });
  exists = false;
  await reconcileSandboxOperations(ctx);
  const [row] = await ctx.db.select().from(sandboxOperations);
  assert.equal(row!.state, "succeeded");
});

test("a live machine does not prove an interrupted checkout succeeded", async () => {
  await assert.rejects(sandboxOperation(ctx, { ...spec(), action: "provision" }, async () => { throw new Error("disconnected"); }));
  await ctx.db.update(sandboxOperations).set({ heartbeatAt: sql`now() - interval '10 minutes'` }).where(eq(sandboxOperations.state, "unknown"));
  exists = true;
  await reconcileSandboxOperations(ctx);
  const rows = await ctx.db.select().from(sandboxOperations).where(eq(sandboxOperations.action, "provision"));
  assert.equal(rows[0]!.state, "unknown");
});
