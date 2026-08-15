import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { AgentEvent } from "@bento/core";
import { EventBus } from "./events.js";
import { attachPgBus, type PgBus } from "./pg-bus.js";

/**
 * Two buses against one real Postgres, standing in for two server
 * processes. This is the test that would have caught the production
 * bug where a viewer's SSE stream landed on the machine that was not
 * executing the run and heard nothing.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "pg_bus_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

// The events run_events would hold, keyed by "runId:seq". A table is
// not needed: the bus fetches through this callback, and what is
// under test is the wire, not the schema.
const storedEvents = new Map<string, AgentEvent>();

let poolA: pg.Pool;
let poolB: pg.Pool;
let busA: EventBus;
let busB: EventBus;
let pgBusA: PgBus;
let pgBusB: PgBus;

function attach(bus: EventBus, pool: pg.Pool): Promise<PgBus> {
  return attachPgBus({
    bus,
    pool,
    connectionString: testUrl,
    loadRunEvent: async (runId, seq) => storedEvents.get(`${runId}:${seq}`) ?? null,
  });
}

function waitFor<T>(subscribe: (resolve: (value: T) => void) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for replicated event"));
    }, 5000);
    const unsubscribe = subscribe((value) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
  });
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  poolA = new pg.Pool({ connectionString: testUrl });
  poolB = new pg.Pool({ connectionString: testUrl });
  busA = new EventBus();
  busB = new EventBus();
  pgBusA = await attach(busA, poolA);
  pgBusB = await attach(busB, poolB);
});

after(async () => {
  await pgBusA.stop();
  await pgBusB.stop();
  await poolA.end();
  await poolB.end();
});

test("a run event emitted on one process reaches a subscriber on the other", async () => {
  const runId = crypto.randomUUID();
  const event: AgentEvent = { type: "message", role: "assistant", text: "hello from machine A" } as AgentEvent;
  storedEvents.set(`${runId}:1`, event);

  const received = waitFor<{ seq: number; event: AgentEvent }>((resolve) =>
    busB.onRunEvent(runId, (envelope) => resolve(envelope)),
  );
  busA.emitRunEvent({ runId, seq: 1, event });
  const envelope = await received;
  assert.equal(envelope.seq, 1);
  assert.deepEqual(envelope.event, event);
});

test("a run event is not fetched for a process with no subscriber", async () => {
  const runId = crypto.randomUUID();
  const event: AgentEvent = { type: "message", role: "assistant", text: "unwatched" } as AgentEvent;
  let fetched = 0;
  const bus = new EventBus();
  const pool = new pg.Pool({ connectionString: testUrl });
  const spyBus = await attachPgBus({
    bus,
    pool,
    connectionString: testUrl,
    loadRunEvent: async (id, seq) => {
      fetched += 1;
      return storedEvents.get(`${id}:${seq}`) ?? null;
    },
  });
  try {
    storedEvents.set(`${runId}:1`, event);
    // Subscribed on B, so B fetches; the spy process has no viewer
    // for the run and must not.
    const onB = waitFor<unknown>((resolve) => busB.onRunEvent(runId, resolve));
    busA.emitRunEvent({ runId, seq: 1, event });
    await onB;
    assert.equal(fetched, 0);
  } finally {
    await spyBus.stop();
    await pool.end();
  }
});

test("deltas replicate and rebuild the draft for late subscribers on the other process", async () => {
  const runId = crypto.randomUUID();
  const onB = waitFor<unknown>((resolve) => busB.onRunDelta(runId, resolve));
  busA.emitRunDelta(runId, { channel: "text", text: "Working on ", offset: 0 });
  await onB;
  const onB2 = waitFor<unknown>((resolve) => busB.onRunDelta(runId, resolve));
  busA.emitRunDelta(runId, { channel: "text", text: "it now.", offset: 11 });
  await onB2;
  // The draft snapshot exists on the process that never ran the agent.
  assert.equal(busB.runDraft(runId), "Working on it now.");
});

test("run_done crosses processes", async () => {
  const runId = crypto.randomUUID();
  const done = waitFor<string>((resolve) => busB.onRunDone(runId, resolve));
  busA.emitRunDone(runId, "succeeded");
  assert.equal(await done, "succeeded");
});

test("board events cross processes", async () => {
  const projectId = crypto.randomUUID();
  const received = waitFor<unknown>((resolve) => busB.onBoardEvent(projectId, resolve));
  busA.emitBoardEvent({ type: "run_updated", projectId, featureId: "f1", status: "running" });
  const event = (await received) as { type: string; status?: string };
  assert.equal(event.type, "run_updated");
  assert.equal(event.status, "running");
});

test("the emitting process does not receive its own notification twice", async () => {
  const runId = crypto.randomUUID();
  const event: AgentEvent = { type: "message", role: "assistant", text: "once" } as AgentEvent;
  storedEvents.set(`${runId}:1`, event);
  let deliveries = 0;
  const unsubscribe = busA.onRunEvent(runId, () => {
    deliveries += 1;
  });
  const onB = waitFor<unknown>((resolve) => busB.onRunEvent(runId, resolve));
  busA.emitRunEvent({ runId, seq: 1, event });
  // B receiving proves the notification round-tripped through
  // Postgres; A must still have seen exactly the local delivery.
  await onB;
  unsubscribe();
  assert.equal(deliveries, 1);
});

test("an oversized delta is dropped, not sent broken", async () => {
  const runId = crypto.randomUUID();
  const big = "x".repeat(10_000);
  const small = waitFor<{ text: string }>((resolve) =>
    busB.onRunDelta(runId, (delta) => {
      if (delta.text !== big) resolve(delta);
    }),
  );
  busA.emitRunDelta(runId, { channel: "text", text: big, offset: 0 });
  // A later, small delta still arrives: the drop affected one
  // fragment, not the channel.
  busA.emitRunDelta(runId, { channel: "text", text: "small", offset: big.length });
  assert.equal((await small).text, "small");
});
