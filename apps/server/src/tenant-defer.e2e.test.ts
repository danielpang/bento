import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pg from "pg";
import { createDb, createPool, projects, runMigrations, type Db } from "@bento/db";
import type { AppContext } from "./context.js";
import { loadEnv } from "./env.js";
import { ACTOR_KEY, ORG_KEY } from "./middleware/actor.js";
import { deferAfterCommit, tenantDb, tenantMiddleware } from "./middleware/tenant.js";

/**
 * Work deferred to after the tenant transaction, checked in multi mode
 * against a real database.
 *
 * The reason this is worth a test of its own: in multi mode a request
 * runs entirely inside one transaction, and anything queued from inside
 * it is visible to the queue before the rows it refers to are visible to
 * anyone. A worker that claims such a job finds nothing and acks, which
 * looks exactly like a job whose subject was deleted. Nothing in a type
 * check or a local mode test can see that, because local mode has no
 * transaction to be inside of.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "tenant_defer_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  await pool.query(`insert into identity.organization (id,name,slug) values ('org-a','A','org-a')`);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);

  // Only env and db are reached on this path.
  ctx = {
    env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
  } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
});

test("deferred work runs after the tenant transaction commits", async () => {
  let seenDuring: number | null = null;
  let seenAfter: number | null = null;

  const app = new Hono();
  app.use(async (c, next) => {
    c.set(ACTOR_KEY, "u1");
    c.set(ORG_KEY, "org-a");
    await next();
  });
  app.use(tenantMiddleware(ctx));
  app.post("/make", async (c) => {
    await tenantDb(c, ctx)
      .insert(projects)
      .values({ ownerId: "u1", organizationId: "org-a", name: "Deferred" });
    // Another connection, which is what a worker is.
    seenDuring = (await db.select().from(projects).where(eq(projects.name, "Deferred"))).length;
    deferAfterCommit(c, async () => {
      seenAfter = (await db.select().from(projects).where(eq(projects.name, "Deferred"))).length;
    });
    return c.json({ ok: true });
  });

  const res = await app.request("/make", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(seenDuring, 0, "the row must still be invisible to other connections mid request");
  assert.equal(seenAfter, 1, "deferred work must run late enough to see the committed row");
});

test("a deferred task that throws does not take the response with it", async () => {
  const app = new Hono();
  app.use(async (c, next) => {
    c.set(ACTOR_KEY, "u1");
    c.set(ORG_KEY, "org-a");
    await next();
  });
  app.use(tenantMiddleware(ctx));
  let second = false;
  app.post("/boom", async (c) => {
    deferAfterCommit(c, async () => {
      throw new Error("queue is down");
    });
    deferAfterCommit(c, async () => {
      second = true;
    });
    return c.json({ ok: true });
  });

  const res = await app.request("/boom", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(second, true, "one failed task must not cancel the rest");
});
