import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runMigrations,
  swarmTasks,
  swarmTemplates,
  swarms,
  type Db,
} from "@bento/db";
import {
  applyRunCharge,
  assumedCostFor,
  budgetIsLow,
  budgetRefusal,
  DEFAULT_ASSUMED_USD,
  enforcedSpend,
  resolveCharge,
  spendOf,
} from "./ledger.js";

/**
 * The arithmetic, on its own.
 *
 * Every figure a swarm prints and every refusal it makes comes out of
 * resolveCharge, so this is where the four tiers are actually decided.
 * No database and no catalog: what is worth pinning is which tier a
 * given set of facts lands in and what the figure is, and both are a
 * function of the arguments.
 */

const NO_AUTH_SHARING = { sharedAgentAuth: false, assumedUsd: 0.5 };

/** A rate card, in dollars per million tokens, as models.dev quotes them. */
const SONNET = { input: 3, output: 15 };

test("a tool that printed a price is measured, at the figure it printed", () => {
  const charge = resolveCharge({ reported: { costUsd: 1.23 }, ...NO_AUTH_SHARING });
  assert.equal(charge.tier, "measured");
  assert.equal(charge.usd, 1.23);
  assert.equal(charge.pricePerMtok, null, "a measured figure was not worked out from a rate");
});

test("a free run that was actually measured is measured, not assumed", () => {
  // Zero is a figure. A tool that printed 0.00 has told us something,
  // and filing it as assumed would charge the swarm for a run the tool
  // says was free.
  const charge = resolveCharge({ reported: { costUsd: 0 }, ...NO_AUTH_SHARING });
  assert.equal(charge.tier, "measured");
  assert.equal(charge.usd, 0);
});

test("a tool that printed tokens is estimated, at the catalog's rate", () => {
  const charge = resolveCharge({
    reported: { inputTokens: 1_000_000, outputTokens: 200_000 },
    price: SONNET,
    ...NO_AUTH_SHARING,
  });
  assert.equal(charge.tier, "estimated");
  // 1M in at $3, 200k out at $15.
  assert.equal(charge.usd, 3 + 3);
  assert.equal(charge.inputTokens, 1_000_000);
  assert.equal(charge.outputTokens, 200_000);
  assert.deepEqual(charge.pricePerMtok, SONNET, "the rate is kept with the figure it produced");
});

test("tokens with no price in the catalog fall to assumed rather than being invented", () => {
  const charge = resolveCharge({
    reported: { inputTokens: 900_000, outputTokens: 100_000 },
    ...NO_AUTH_SHARING,
  });
  assert.equal(charge.tier, "assumed", "a rate nobody published is not a rate");
  assert.equal(charge.usd, 0.5);
  assert.equal(charge.inputTokens, 900_000, "the counts are still recorded: they are facts");
  assert.equal(charge.pricePerMtok, null);
});

test("a tool that printed nothing at all is assumed, at the swarm's own figure", () => {
  const charge = resolveCharge({ reported: {}, sharedAgentAuth: false, assumedUsd: 1.75 });
  assert.equal(charge.tier, "assumed");
  assert.equal(charge.usd, 1.75);
});

/**
 * The tier that exists so a cap cannot stop a swarm that is costing
 * nothing. Whatever produced the figure, a subscription had already
 * paid for the work.
 */
test("a run on a borrowed login is notional, whichever way its figure was produced", () => {
  const printed = resolveCharge({ reported: { costUsd: 2 }, sharedAgentAuth: true, assumedUsd: 0.5 });
  assert.equal(printed.tier, "notional");
  assert.equal(printed.usd, 2, "the figure is still recorded; only what it means changes");

  const counted = resolveCharge({
    reported: { inputTokens: 1_000_000, outputTokens: 0 },
    price: SONNET,
    sharedAgentAuth: true,
    assumedUsd: 0.5,
  });
  assert.equal(counted.tier, "notional");
  assert.equal(counted.usd, 3);

  const silent = resolveCharge({ reported: {}, sharedAgentAuth: true, assumedUsd: 0.5 });
  assert.equal(silent.tier, "notional");
});

test("counts that are not counts are not multiplied", () => {
  const charge = resolveCharge({
    reported: { inputTokens: Number.NaN, outputTokens: -5 },
    price: SONNET,
    ...NO_AUTH_SHARING,
  });
  assert.equal(charge.tier, "assumed");
  assert.equal(charge.inputTokens, null);
  assert.equal(charge.outputTokens, null);
});

/* ---------------------------------------------------------------- *
 * What the budget counts, and what it refuses.
 * ---------------------------------------------------------------- */

const spent = (measured: string, estimated = "0", assumed = "0", notional = "0") => ({
  budgetUsd: "10",
  spentMeasuredUsd: measured,
  spentEstimatedUsd: estimated,
  spentAssumedUsd: assumed,
  spentNotionalUsd: notional,
});

test("all three real tiers count against the cap", () => {
  assert.equal(enforcedSpend(spendOf(spent("4", "3", "2", "100"))), 9);
  assert.equal(budgetRefusal(spent("4", "3", "2", "100")), null, "nine of ten, so there is room for one more run");
  const refusal = budgetRefusal(spent("4", "4", "2"));
  assert.ok(refusal, "ten of ten is spent");
  assert.match(refusal, /Raise the budget/, "and the sentence says what to do about it");
});

/**
 * The tier the cap does not count, which is the whole of local mode's
 * spend when it lends its runs a logged in subscription.
 */
test("notional spend never closes a budget", () => {
  assert.equal(budgetRefusal(spent("0", "0", "0", "999")), null);
});

test("a swarm with no budget is never refused", () => {
  assert.equal(
    budgetRefusal({
      budgetUsd: null,
      spentMeasuredUsd: "9999",
      spentEstimatedUsd: "0",
      spentAssumedUsd: "0",
      spentNotionalUsd: "0",
    }),
    null,
  );
});

test("a zero budget refuses the first run", () => {
  const refusal = budgetRefusal({
    budgetUsd: "0",
    spentMeasuredUsd: "0",
    spentEstimatedUsd: "0",
    spentAssumedUsd: "0",
    spentNotionalUsd: "0",
  });
  assert.ok(refusal, "zero means spend nothing, not unlimited spend");
  assert.match(refusal, /\$0\.00 budget/);
});

test("an invalid stored budget fails closed", () => {
  const refusal = budgetRefusal({
    budgetUsd: "not-a-number",
    spentMeasuredUsd: "0",
    spentEstimatedUsd: "0",
    spentAssumedUsd: "0",
    spentNotionalUsd: "0",
  });
  assert.match(refusal ?? "", /invalid budget/);
});

test("the planner is warned when what is left is less than one more run", () => {
  assert.equal(budgetIsLow(spent("9.80"), 0.5), true, "twenty cents left, half a dollar a run");
  assert.equal(budgetIsLow(spent("5.00"), 0.5), false, "five dollars is ten more runs");
  assert.equal(budgetIsLow(spent("10.00"), 0.5), false, "spent is not low, it is gone: that is the refusal's job");
});

test("the default assumed figure is a number, because zero is the one answer that is wrong", () => {
  assert.ok(DEFAULT_ASSUMED_USD > 0);
});

/* ---------------------------------------------------------------- *
 * What a silent run is charged, which is the one part of the ledger
 * that has to read rows: the figure comes from what this swarm's own
 * agents have been costing.
 * ---------------------------------------------------------------- */

const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_ledger_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "33333333-3333-3333-3333-333333333333";

let pool: ReturnType<typeof createPool>;
let db: Db;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);
  pool = createPool(testUrl);
  db = createDb(pool);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`,
    [PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
    [PROFILE],
  );
  await pool.query(
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers,worker_isolation)
     values ($1,'u1',null,'T',$2,$2,2,'worktree')`,
    [TEMPLATE, PROFILE],
  );
});

after(async () => {
  await pool?.end();
});

async function makeSwarm(overrides: Partial<typeof swarms.$inferInsert> = {}) {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug: `s-${Math.random().toString(36).slice(2, 8)}`,
      title: "Swarm",
      templateId: TEMPLATE,
      status: "running",
      startedBy: "u1",
      ...overrides,
    })
    .returning();
  return swarm!;
}

/** A finished run in this swarm, at a figure and a tier. */
async function chargedRun(swarmId: string, costUsd: string, costTier: "measured" | "estimated" | "assumed") {
  await db.insert(agentRuns).values({
    type: "swarm",
    swarmId,
    role: "worker",
    agentProfileId: PROFILE,
    prompt: "",
    status: "succeeded",
    costUsd,
    costTier,
  });
}

test("the first silent run in a swarm is charged the fixed default", async () => {
  const swarm = await makeSwarm();
  assert.equal(await assumedCostFor(db, swarm), DEFAULT_ASSUMED_USD);
});

/**
 * The case the tier exists for: a swarm that has measured some of its
 * runs knows what its own agents cost, and that beats a constant.
 */
test("a swarm's own average of what it measured seeds what it assumes", async () => {
  const swarm = await makeSwarm();
  await chargedRun(swarm.id, "1.00", "measured");
  await chargedRun(swarm.id, "2.00", "estimated");
  // An assumed run is left out of the average on purpose: averaging
  // guesses back into the next guess is a figure that drifts on its
  // own, further from the measurements with every silent run.
  await chargedRun(swarm.id, "9.00", "assumed");

  assert.equal(await assumedCostFor(db, swarm), 1.5);
});

test("a template that states a figure is believed over the average", async () => {
  const [template] = await db
    .insert(swarmTemplates)
    .values({
      ownerId: "u1",
      name: "Stated",
      plannerProfileId: PROFILE,
      workerProfileId: PROFILE,
      workerIsolation: "worktree",
      assumedCostUsd: "0.25",
    })
    .returning();
  const swarm = await makeSwarm({ templateId: template!.id });
  await chargedRun(swarm.id, "4.00", "measured");

  assert.equal(await assumedCostFor(db, swarm), 0.25, "a team that says what its tools cost knows better than we do");
});

/**
 * One run's charge, added to the two rows that carry it.
 *
 * The node gets what its own work cost; the swarm gets everything,
 * including the charges that hang off no node at all.
 */
test("a charge lands on its node and on its swarm, in the tier it was resolved at", async () => {
  const swarm = await makeSwarm();
  const [task] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "Leaf" }).returning();

  await applyRunCharge(db, { swarmId: swarm.id, swarmTaskId: task!.id }, {
    tier: "estimated",
    usd: 1.25,
    inputTokens: 1_000,
    outputTokens: 100,
    pricePerMtok: SONNET,
  });
  await applyRunCharge(db, { swarmId: swarm.id, swarmTaskId: null }, {
    tier: "notional",
    usd: 3,
    inputTokens: null,
    outputTokens: null,
    pricePerMtok: null,
  });

  const [afterSwarm] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  assert.equal(Number(afterSwarm!.spentEstimatedUsd), 1.25);
  assert.equal(Number(afterSwarm!.spentNotionalUsd), 3, "a planner's turn belongs to the swarm and to no node");
  assert.equal(Number(afterSwarm!.spentMeasuredUsd), 0, "and nothing bleeds into the tiers it did not belong to");

  const [afterTask] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, task!.id));
  assert.equal(Number(afterTask!.costEstimatedUsd), 1.25);
  assert.equal(Number(afterTask!.costNotionalUsd), 0);
});

test("a swarm on a borrowed login runs past a budget its real spend would have closed", async () => {
  const swarm = await makeSwarm({ budgetUsd: "1" });
  await applyRunCharge(db, { swarmId: swarm.id, swarmTaskId: null }, {
    tier: "notional",
    usd: 40,
    inputTokens: null,
    outputTokens: null,
    pricePerMtok: null,
  });

  const [after] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  assert.equal(
    budgetRefusal(after!),
    null,
    "forty dollars of list price against a one dollar cap, and nothing is refused: the subscription already paid",
  );
});
