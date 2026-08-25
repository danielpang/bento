import assert from "node:assert/strict";
import test from "node:test";
import { displayHighlights } from "./components/billing-plan.js";

/**
 * The cloud module still ships the old bullets. The console is what
 * people read, so these are the lines as they arrive today and the
 * lines the plans panel should show instead.
 */
const FROM_CLOUD: Record<string, string[]> = {
  free: [
    "Up to 3 members",
    "Unlimited cards on the board",
    "1 agent running at a time",
    "5 agent hours a period for the team",
  ],
  pro: [
    "Unlimited members, billed per seat",
    "Unlimited cards on the board",
    "5 agents running at a time",
    "25 agent hours a period for the team",
    "30 day transcript history",
  ],
  business: [
    "Everything in Pro",
    "25 agents running at a time",
    "500 agent hours a period for the team",
    "90 day transcript history and audit log",
    "Priority run queue",
    "Billed for 5 seats minimum",
  ],
  enterprise: [
    "Everything in Business",
    "Unlimited agents running at once",
    "2000 agent hours a period, negotiable",
    "SSO and SCIM",
    "Sandboxes in your own Fly organization",
    "Custom sandbox images",
    "99.9% uptime commitment and a DPA",
  ],
};

test("Free does not claim a concurrent agent cap", () => {
  assert.deepEqual(displayHighlights(FROM_CLOUD.free!), [
    "Up to 3 members",
    "Unlimited cards on the board",
    "5 agent hours a period for the team",
  ]);
});

test("Pro names per-seat billing and does not invent transcript retention", () => {
  assert.deepEqual(displayHighlights(FROM_CLOUD.pro!), [
    "Billed per seat",
    "Unlimited cards on the board",
    "25 agent hours a period for the team",
  ]);
});

test("Business keeps history and the seat minimum, not a concurrent cap", () => {
  assert.deepEqual(displayHighlights(FROM_CLOUD.business!), [
    "Everything in Pro",
    "500 agent hours a period for the team",
    "90 day transcript history and audit log",
    "Priority run queue",
    "Billed for 5 seats minimum",
  ]);
});

test("Enterprise drops negotiable hours, custom images, and the uptime promise", () => {
  assert.deepEqual(displayHighlights(FROM_CLOUD.enterprise!), [
    "Everything in Business",
    "2000 agent hours a period",
    "SSO and SCIM",
    "Sandboxes in your own Fly organization",
  ]);
});

test("already honest bullets pass through", () => {
  const honest = ["Billed per seat", "Unlimited cards on the board", "25 agent hours a period for the team"];
  assert.deepEqual(displayHighlights(honest), honest);
});
