import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import PgBoss from "pg-boss";
import { createPool, pgBossDatabase, POOL_FROZEN_GAP_MS, postgresPoolConfig } from "@bento/db";

/**
 * What a pooled connection looks like after a Fly machine suspend,
 * against a real Postgres.
 *
 * The machine freezes with its sockets established and resumes hours
 * later; Neon dropped its end long ago, but nothing told this kernel,
 * so the pool still hands the socket out and the query on it hangs
 * until TCP gives up. A proxy in front of Postgres reproduces that:
 * "blackhole" stops forwarding on every live connection without
 * closing the client side, exactly as silent as a forgotten peer, and
 * keeps accepting new connections so a reconnect works.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "pool_recycle_test";
const upstream = new URL(adminUrl);
const upstreamHost = upstream.hostname;
const upstreamPort = Number(upstream.port || 5432);

let proxy: net.Server;
let proxyUrl: string;
/** The same proxy, on a database of its own for pg-boss's schema. */
let proxyTestDbUrl: string;
const live = new Set<{ client: net.Socket; server: net.Socket }>();

function blackhole(): void {
  for (const pair of live) {
    pair.client.unpipe(pair.server);
    pair.server.unpipe(pair.client);
    // Swallow everything the client sends and never answer or close:
    // the client side stays "established" with a peer that is gone.
    pair.client.removeAllListeners("end");
    pair.client.on("data", () => {});
    pair.client.on("error", () => {});
    pair.server.destroy();
  }
}

before(async () => {
  proxy = net.createServer((client) => {
    const server = net.connect(upstreamPort, upstreamHost);
    const pair = { client, server };
    live.add(pair);
    client.pipe(server);
    server.pipe(client);
    const drop = () => {
      live.delete(pair);
    };
    client.on("close", drop);
    client.on("error", () => {});
    server.on("error", () => {});
    server.on("close", () => {
      // A normal upstream close ends the client too; a blackholed one
      // was unpiped above and must not.
      if (live.has(pair) && client.listenerCount("data") === 0) client.end();
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as net.AddressInfo;
  const url = new URL(adminUrl);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  proxyUrl = url.toString();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  url.pathname = `/${testDbName}`;
  proxyTestDbUrl = url.toString();
});

after(async () => {
  for (const pair of live) {
    pair.client.destroy();
    pair.server.destroy();
  }
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

test("a pool woken after a suspend retires the sockets it froze with", async (t) => {
  const pool = createPool(proxyUrl, { max: 4 });
  const retired: string[] = [];
  let connects = 0;
  pool.on("connect", () => connects++);
  pool.on("release", (err) => {
    if (err instanceof Error) retired.push(err.message);
  });
  t.after(() => mock.timers.reset());
  try {
    await pool.query("select 1");
    assert.equal(pool.idleCount, 1, "the first query's client is idle in the pool");
    assert.equal(connects, 1);

    // The machine sleeps: the peer forgets the socket, the process
    // does not run, and on resume the wall clock is hours ahead while
    // the idle timer has not fired.
    blackhole();
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    mock.timers.tick(POOL_FROZEN_GAP_MS);

    const started = performance.now();
    const { rows } = await pool.query("select 2 as n");
    assert.equal(rows[0].n, 2);
    assert.ok(performance.now() - started < 5_000, "the wake-up query did not hang on the dead socket");
    assert.equal(connects, 2, "the wake-up query opened a new connection");
    assert.deepEqual(retired, ["connection predates a process suspend and is presumed dead"]);
    assert.equal(pool.totalCount, 1, "the frozen client is gone from the pool");
  } finally {
    await pool.end();
  }
});

test("a pool that was never suspended keeps reusing its idle client", async () => {
  const pool = createPool(proxyUrl, { max: 4 });
  let connects = 0;
  pool.on("connect", () => connects++);
  try {
    await pool.query("select 1");
    await pool.query("select 2");
    await pool.query("select 3");
    assert.equal(connects, 1, "three quick queries share one connection");
    assert.equal(pool.totalCount, 1);
  } finally {
    await pool.end();
  }
});

test("pg-boss cron and workers come back after a suspend without an error", async (t) => {
  // The path from the PostHog stack: Timekeeper.onCron -> executeSql
  // -> pool.query, on a pool that slept with warm connections. The
  // intervals are shortened so a tick lands during the test.
  const pool = createPool(proxyTestDbUrl, { max: 4 });
  const boss = new PgBoss({
    db: pgBossDatabase(pool),
    schema: "pgboss",
    pollingIntervalSeconds: 1,
    cronMonitorIntervalSeconds: 1,
  });
  const errors: unknown[] = [];
  boss.on("error", (err) => errors.push(err));
  let connects = 0;
  pool.on("connect", () => connects++);
  t.after(() => mock.timers.reset());
  try {
    await boss.start();
    await boss.createQueue("wake");
    const handled: string[] = [];
    await boss.work<{ tag: string }>("wake", { pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) handled.push(job.data.tag);
    });
    // Let cron and the worker settle into polling, then catch the pool
    // between polls: what a suspend freezes is idle connections.
    await sleep(1500);
    while (pool.idleCount !== pool.totalCount || pool.idleCount === 0) await sleep(10);
    const warm = pool.totalCount;
    const connectsBefore = connects;
    assert.equal(errors.length, 0);

    blackhole();
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    mock.timers.tick(POOL_FROZEN_GAP_MS);

    await boss.send("wake", { tag: "after the wake" });
    const deadline = performance.now() + 5_000;
    while (!handled.includes("after the wake") && performance.now() < deadline) await sleep(50);

    assert.deepEqual(handled, ["after the wake"], "the worker fetched a job on a fresh connection");
    assert.deepEqual(errors, [], "no cron or worker query hung on a frozen socket");
    assert.ok(connects > connectsBefore, "the pool reconnected rather than reusing");
    assert.ok(pool.totalCount <= warm, "the frozen clients were retired, not kept alongside");
  } finally {
    await boss.stop({ close: true, timeout: 2_000 }).catch(() => {});
    await pool.end();
  }
});

test("without recycling, a query on a dead socket is bounded by query_timeout", async () => {
  // A plain pg.Pool with the shared options, the timeout shortened so
  // the test does not wait thirty seconds: this is the backstop for a
  // socket that was checked out before the clock caught up.
  const pool = new pg.Pool({ ...postgresPoolConfig(proxyUrl, { max: 4 }), query_timeout: 1_000 });
  pool.on("error", () => {});
  let connects = 0;
  pool.on("connect", () => connects++);
  try {
    await pool.query("select 1");
    blackhole();
    const started = performance.now();
    await assert.rejects(pool.query("select 2"), /Query read timeout/);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 5_000, `failed after the timeout, not a TCP retry: ${elapsed}ms`);
    assert.equal(pool.totalCount, 0, "the client with the hung query was destroyed");

    const { rows } = await pool.query("select 3 as n");
    assert.equal(rows[0].n, 3, "the next query connects fresh");
    assert.equal(connects, 2);
  } finally {
    await pool.end();
  }
});
