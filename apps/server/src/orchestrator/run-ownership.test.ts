import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesced } from "./run-ownership.js";

const settle = () => new Promise((r) => setImmediate(r));

/**
 * A burst of release controls is one sweep in flight and one more after
 * it, never one per control.
 */
test("coalesced runs a burst as one pass plus one confirming pass", async () => {
  let runs = 0;
  const releases: (() => void)[] = [];
  const task = coalesced(
    () =>
      new Promise<void>((resolve) => {
        runs += 1;
        releases.push(resolve);
      }),
  );
  const burst = Array.from({ length: 30 }, () => task());
  await settle();
  assert.equal(runs, 1, "the burst did not start more passes while one was in flight");
  releases[0]!();
  await settle();
  assert.equal(runs, 2, "one more pass runs, for whatever arrived during the first");
  releases[1]!();
  await Promise.all(burst);
  await settle();
  assert.equal(runs, 2, "and nothing after that without a new request");
  const later = task();
  releases[2]!();
  await later;
  assert.equal(runs, 3, "a request with nothing in flight runs at once");
});

test("coalesced surfaces a failing pass to its callers and recovers after", async () => {
  let attempt = 0;
  const task = coalesced(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("database away");
  });
  await assert.rejects(task(), /database away/);
  await task();
  assert.equal(attempt, 2, "the next request runs a fresh pass");
});

/**
 * The web half of a split deployment drives no runs, orphans included.
 * But the reap schedule it shares with the workers can land on it, so
 * a pass there announces every orphan it finds as a release, which the
 * workers adopt on, and takes none itself.
 */
test("a web role process announces orphans and adopts none", async () => {
  const { adoptOrphanedRuns } = await import("./run-executor.js");
  const announced: Array<{ runId: string; action: string }> = [];
  const rows = [{ id: "run-1", status: "running" }, { id: "run-2", status: "starting" }];
  const ctx = {
    draining: false,
    env: { BENTO_ROLE: "web", BENTO_MAX_CONCURRENT_RUNS: 4 },
    bus: { emitRunControl: (c: { runId: string; action: string }) => announced.push(c) },
    db: {
      select() {
        return this;
      },
      from() {
        return this;
      },
      update() {
        throw new Error("a web process must not adopt");
      },
      where: async () => rows,
    },
  } as unknown as import("../context.js").AppContext;
  assert.deepEqual(await adoptOrphanedRuns(ctx), { resumed: 0, closed: 0 });
  assert.deepEqual(announced, [
    { runId: "run-1", action: "released" },
    { runId: "run-2", action: "released" },
  ]);
});
