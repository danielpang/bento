import assert from "node:assert/strict";
import test from "node:test";
import type { AppContext } from "../context.js";
import { FakeJobQueue } from "../jobs/index.js";
import {
  LINEAR_CONNECTED_PRESENCE_KEY,
  LINEAR_SWEEP_CRON,
  LINEAR_SWEEP_ID,
  linearSweepShouldRun,
  registerLinearJobs,
  runLinearSweep,
  syncLinearConnectedPresence,
} from "./linear-sync.js";

function dbWithOrgs(organizationIds: (string | null)[]) {
  return {
    select() {
      return this;
    },
    from: async () => organizationIds.map((organizationId) => ({ organizationId })),
  };
}

function ctxFor(jobs: FakeJobQueue, organizationIds: (string | null)[] = []): AppContext {
  return {
    jobs,
    db: dbWithOrgs(organizationIds),
    analytics: undefined,
  } as unknown as AppContext;
}

test("the Linear fallback is hourly, not every fifteen minutes", () => {
  assert.equal(LINEAR_SWEEP_CRON, "0 * * * *");
  assert.equal(LINEAR_SWEEP_ID, "linear.sweep");
});

test("a disconnected deployment does not query and does not enqueue", async () => {
  const jobs = new FakeJobQueue();
  let queried = false;
  const ctx = {
    jobs,
    db: {
      select() {
        queried = true;
        return this;
      },
      from: async () => [{ organizationId: "org-1" }],
    },
  } as unknown as AppContext;

  assert.equal(await linearSweepShouldRun(ctx), false);
  await runLinearSweep(ctx);
  assert.equal(queried, false);
  assert.deepEqual(jobs.sent, []);
});

test("a connected org arms the hourly sweep and the sweep enqueues backlog sync", async () => {
  const jobs = new FakeJobQueue();
  const ctx = ctxFor(jobs, ["org-1", null]);

  const count = await syncLinearConnectedPresence(ctx);
  assert.equal(count, 2);
  assert.equal(await jobs.getPresence(LINEAR_CONNECTED_PRESENCE_KEY), 2);
  assert.equal(await linearSweepShouldRun(ctx), true);
  const scheduled = jobs.scheduled.find((row) => row.id === LINEAR_SWEEP_ID);
  assert.ok(scheduled, "a connected org holds the hourly sweep");
  assert.equal(scheduled.cron, LINEAR_SWEEP_CRON);

  await runLinearSweep(ctx);
  assert.deepEqual(
    jobs.sent.map((job) => job.data),
    [{ organizationId: "org-1" }, { organizationId: null }],
  );
  assert.equal(
    jobs.sent.every((job) => job.queue === "linear.backlog-sync"),
    true,
  );
});

test("disconnecting the last org drops the sweep", async () => {
  const jobs = new FakeJobQueue();
  await syncLinearConnectedPresence(ctxFor(jobs, ["org-1"]));
  assert.ok(jobs.scheduled.find((row) => row.id === LINEAR_SWEEP_ID));

  const count = await syncLinearConnectedPresence(ctxFor(jobs, []));
  assert.equal(count, 0);
  assert.equal(await jobs.getPresence(LINEAR_CONNECTED_PRESENCE_KEY), 0);
  assert.equal(await linearSweepShouldRun(ctxFor(jobs, [])), false);
  assert.equal(jobs.scheduled.find((row) => row.id === LINEAR_SWEEP_ID), undefined);
  assert.deepEqual(jobs.unscheduled, [LINEAR_SWEEP_ID]);
});

test("boot recomputes the Linear signal from the rows", async () => {
  const empty = new FakeJobQueue();
  await registerLinearJobs(ctxFor(empty, []));
  assert.equal(await empty.getPresence(LINEAR_CONNECTED_PRESENCE_KEY), 0);
  assert.equal(empty.scheduled.find((row) => row.id === LINEAR_SWEEP_ID), undefined);
  assert.ok(empty.worked.includes("linear.sweep"));

  const connected = new FakeJobQueue();
  await registerLinearJobs(ctxFor(connected, ["org-a"]));
  assert.equal(await connected.getPresence(LINEAR_CONNECTED_PRESENCE_KEY), 1);
  assert.equal(connected.scheduled.find((row) => row.id === LINEAR_SWEEP_ID)?.cron, LINEAR_SWEEP_CRON);
});
