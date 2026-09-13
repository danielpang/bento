import assert from "node:assert/strict";
import test from "node:test";
import { creationNotes, modeSurfaces, swarmAccess } from "./swarm/plan.js";
import { ComputeBanner } from "./components/SwarmPage.js";
import { OutOfCompute } from "./components/OutOfCompute.js";
import type { PlanState } from "./components/billing-plan.js";

/**
 * One console, two deployment modes.
 *
 * Local mode has one user, no organization, no plan and no billing.
 * That is a difference in what the plan says, not a reason for a
 * second set of screens, and these assert the three places it shows:
 * the creation dialog drops the plan footer and the agent hours line,
 * and the swarm header never renders the out of compute banner.
 *
 * The gate itself is the other half: a team whose plan does not
 * include swarms is offered an upgrade only when somebody there could
 * act on it.
 */

function plan(overrides: Partial<PlanState> = {}): PlanState {
  return {
    plan: "pro",
    planName: "Pro",
    status: "active",
    limits: { members: null },
    usage: { members: 3 },
    agentHours: { used: 4, included: 25, cap: 25, periodStart: "", periodEnd: "" },
    stopped: null,
    overage: { policy: "stop", changeable: true, usdPerAgentHour: 2, ceilingUsd: null, spentUsd: 0 },
    usageByMember: [],
    seats: { held: 3, billable: 3, monthlyTotalUsd: 87, billed: true },
    catalog: [],
    canManageBilling: true,
    upgradable: true,
    manageable: true,
    salesConfigured: true,
    ...overrides,
  };
}

test("local mode has nothing to gate on, so swarms are simply open", () => {
  const access = swarmAccess({ mode: "local", plan: null, absent: true });
  assert.deepEqual(access, { show: true, included: true, canUpgrade: false, prompt: null });
});

test("an install with no billing module at all is open too", () => {
  const access = swarmAccess({ mode: "multi", plan: null, absent: true });
  assert.equal(access.show, true);
  assert.equal(access.included, true);
});

test("nothing renders while the plan is still in flight", () => {
  const access = swarmAccess({ mode: "multi", plan: null, absent: false });
  assert.equal(access.show, false);
  assert.equal(access.included, false);
  assert.equal(access.prompt, null);
});

test("a plan that says nothing about swarms is not a plan that refuses them", () => {
  const access = swarmAccess({ mode: "multi", plan: plan(), absent: false });
  assert.equal(access.included, true);
  assert.equal(access.show, true);
});

test("a plan with swarms on it opens the board with no prompt", () => {
  const access = swarmAccess({ mode: "multi", plan: plan({ swarms: { included: true } }), absent: false });
  assert.equal(access.included, true);
  assert.equal(access.prompt, null);
});

test("a plan without swarms offers the upgrade only to whoever could take it", () => {
  const owner = swarmAccess({
    mode: "multi",
    plan: plan({ swarms: { included: false }, canManageBilling: true }),
    absent: false,
  });
  assert.equal(owner.show, true);
  assert.equal(owner.included, false);
  assert.equal(owner.canUpgrade, true);
  assert.match(owner.prompt ?? "", /Pro/);
  assert.ok(!(owner.prompt ?? "").includes(" - "));

  const member = swarmAccess({
    mode: "multi",
    plan: plan({ swarms: { included: false }, canManageBilling: false }),
    absent: false,
  });
  // A control that can only ever refuse them is an advertisement.
  assert.equal(member.show, false);
  assert.equal(member.included, false);
  assert.equal(member.prompt, null);
});

test("local mode drops the plan footer, drops the agent hours line, and keeps the estimate", () => {
  const estimate = { measuredUsd: 5, estimatedUsd: 1, assumedUsd: 2 };
  const local = creationNotes(modeSurfaces("local"), estimate, 10);
  const hosted = creationNotes(modeSurfaces("multi"), estimate, 10);

  // Absence one and absence two, named.
  assert.deepEqual(local.map((note) => note.id), ["estimate"]);
  assert.deepEqual(hosted.map((note) => note.id), ["estimate", "agent-hours", "plan-footer"]);
  assert.ok(!local.some((note) => /agent hours/i.test(note.text)));
  assert.ok(!local.some((note) => /plan|Billing/i.test(note.text)));

  // The estimate itself is the same line in both, and still three figures.
  assert.equal(local[0]!.text, hosted[0]!.text);
  assert.equal(local[0]!.text, "About $5.00 measured, $1.00 estimated, $2.00 assumed over 10 tasks.");
});

test("the swarm header never carries the out of compute banner in local mode", () => {
  // Absence three: the component itself, so this is the structure and
  // not a reading of the rendered string.
  assert.equal(ComputeBanner({ surfaces: modeSurfaces("local") }), null);
  const hosted = ComputeBanner({ surfaces: modeSurfaces("multi") });
  assert.notEqual(hosted, null);
  assert.equal(hosted?.type, OutOfCompute);
});

test("everything else is the same console in both modes", () => {
  const local = modeSurfaces("local");
  const hosted = modeSurfaces("multi");
  assert.equal(local.dollarEstimate, hosted.dollarEstimate);
  const differences = (Object.keys(hosted) as (keyof typeof hosted)[]).filter(
    (key) => local[key] !== hosted[key],
  );
  assert.deepEqual(differences.sort(), ["agentHoursLine", "outOfComputeBanner", "planFooter"]);
});
