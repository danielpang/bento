import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHours,
  formatHoursPhrase,
  hoursMeterState,
  hoursUsage,
  monthlyTotal,
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
