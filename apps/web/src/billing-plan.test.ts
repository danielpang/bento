import assert from "node:assert/strict";
import test from "node:test";
import { monthlyTotal, type PlanOffer } from "./components/billing-plan.js";

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
