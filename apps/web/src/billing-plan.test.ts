import assert from "node:assert/strict";
import test from "node:test";
import {
  filterHoursEntries,
  formatHours,
  formatHoursPhrase,
  formatHoursShare,
  hoursBarFill,
  hoursMeterState,
  hoursRestCopy,
  hoursUsage,
  monthlyTotal,
  rankHoursEntries,
  type PlanOffer,
} from "./components/billing-plan.js";

function offer(overrides: Partial<PlanOffer> & Pick<PlanOffer, "billableSeats" | "monthlyTotalUsd">): PlanOffer {
  return {
    plan: "pro",
    name: "Pro",
    pricing: {
      perSeatUsd: 29,
      fromPrice: false,
      minimumSeats: 1,
      includedAgentHours: 25,
      overageUsdPerAgentHour: 2,
      summary: "",
      highlights: [],
    },
    limits: { members: null },
    ...overrides,
  };
}

test("the team total is seats times the per-user price, before tax", () => {
  assert.equal(
    monthlyTotal(offer({ billableSeats: 1, monthlyTotalUsd: 29 }), 1),
    "$29 a month for this team (1 seat, not including tax)",
  );
  assert.equal(
    monthlyTotal(offer({ billableSeats: 2, monthlyTotalUsd: 58 }), 2),
    "$58 a month for this team (2 seats, not including tax)",
  );
});

test("a seat minimum is named when it is what decides the bill", () => {
  assert.equal(
    monthlyTotal(offer({ billableSeats: 5, monthlyTotalUsd: 145, pricing: {
      perSeatUsd: 29,
      fromPrice: false,
      minimumSeats: 5,
      includedAgentHours: 500,
      overageUsdPerAgentHour: 2,
      summary: "",
      highlights: [],
    } }), 2),
    "$145 a month for this team (5 seats minimum, this team has 2, not including tax)",
  );
});

test("hours figures drop a trailing tenth", () => {
  assert.equal(formatHours(0), "0");
  assert.equal(formatHours(1), "1");
  assert.equal(formatHours(12.4), "12.4");
  assert.equal(formatHours(12.41), "12.4");
  assert.equal(formatHours(19), "19");
  assert.equal(formatHoursPhrase(1), "1 hour");
  assert.equal(formatHoursPhrase(0), "0 hours");
  assert.equal(formatHoursPhrase(12.4), "12.4 hours");
});

test("the hours card splits leftover from overage", () => {
  const inside = hoursUsage({ used: 12.4, included: 25, cap: 25, periodStart: "", periodEnd: "" });
  assert.equal(inside.remaining, 12.6);
  assert.equal(inside.overage, 0);
  assert.equal(inside.fillRatio, 12.4 / 25);

  const spent = hoursUsage({ used: 25, included: 25, cap: 25, periodStart: "", periodEnd: "" });
  assert.equal(spent.remaining, 0);
  assert.equal(spent.overage, 0);
  assert.equal(spent.fillRatio, 1);

  const over = hoursUsage({ used: 28, included: 25, cap: null, periodStart: "", periodEnd: "" });
  assert.equal(over.remaining, 0);
  assert.equal(over.overage, 3);
  assert.equal(over.fillRatio, 1);
});

test("the hours meter colours at three quarters, overage, and a stop", () => {
  const quarter = hoursUsage({ used: 5, included: 25, cap: 25, periodStart: "", periodEnd: "" });
  assert.equal(hoursMeterState(quarter, null), undefined);

  const threeQuarters = hoursUsage({ used: 19, included: 25, cap: 25, periodStart: "", periodEnd: "" });
  assert.equal(hoursMeterState(threeQuarters, null), "warn");

  const over = hoursUsage({ used: 28, included: 25, cap: null, periodStart: "", periodEnd: "" });
  assert.equal(hoursMeterState(over, null), "over");
  assert.equal(hoursMeterState(over, "pool"), "stopped");
  assert.equal(hoursMeterState(over, "ceiling"), "stopped");
});

test("the hours list keeps the heaviest five cards and summarises the rest", () => {
  const entries = [
    { id: "a", name: "Rate limit", agentHours: 8 },
    { id: "b", name: "Idle card", agentHours: 0 },
    { id: "c", name: "Login polish", agentHours: 3 },
    { id: "d", name: "Search", agentHours: 1.2 },
    { id: "e", name: "Email", agentHours: 0.4 },
    { id: "f", name: "Billing meter", agentHours: 6 },
    { id: "g", name: "Webhooks", agentHours: 2 },
    { id: "h", name: "Tiny", agentHours: 0.1 },
  ];
  const ranked = rankHoursEntries(entries);
  assert.deepEqual(
    ranked.preview.map((row) => row.name),
    ["Rate limit", "Billing meter", "Login polish", "Webhooks", "Search"],
  );
  assert.equal(ranked.rest.length, 2);
  assert.equal(ranked.ranked.length, 7);
  assert.equal(ranked.restHours, 0.5);
  assert.equal(
    hoursRestCopy(ranked.rest.length, ranked.restHours, 20.7, { singular: "card", plural: "cards" }),
    "and 2 more cards used 0.5 hours this period (2%).",
  );
  assert.equal(
    hoursRestCopy(1, 0.4, 20, { singular: "card", plural: "cards" }),
    "and 1 more card used 0.4 hours this period (2%).",
  );
});

test("a title filter matches cards and ignores unused ones", () => {
  const ranked = rankHoursEntries([
    { id: "a", name: "Rate limit middleware", agentHours: 4 },
    { id: "b", name: "Login polish", agentHours: 2 },
    { id: "c", name: "Webhooks", agentHours: 1 },
  ]);
  assert.equal(filterHoursEntries(ranked.ranked, "rate").length, 1);
  assert.equal(filterHoursEntries(ranked.ranked, "POLISH").length, 1);
  assert.equal(filterHoursEntries(ranked.ranked, "nobody").length, 0);
});

test("card bars scale to the heaviest spender, not the pool", () => {
  assert.equal(hoursBarFill(12, 12), 1);
  assert.equal(hoursBarFill(6, 12), 0.5);
  assert.equal(hoursBarFill(12, 500), 12 / 500);
  assert.equal(hoursBarFill(0, 12), 0);
  assert.equal(formatHoursShare(12.4, 19), "65%");
  assert.equal(formatHoursShare(0.1, 25), "<1%");
  assert.equal(formatHoursShare(0, 25), null);
});
