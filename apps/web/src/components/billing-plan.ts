import { useEffect, useState } from "react";

/**
 * The team's plan and the price ladder behind it.
 *
 * Everything here comes from /api/billing, which only exists when the
 * deployment loads the cloud module. On an open source install the
 * fetch 404s and every consumer renders nothing, which is the boundary:
 * the console carries the surface, the closed module carries every
 * decision about money. Nothing in this file knows a price; it asks.
 */
export interface PlanPricing {
  /** Dollars per seat per month. Null when the plan is a conversation. */
  perSeatUsd: number | null;
  /** Whether that number is a floor rather than the price. */
  fromPrice: boolean;
  minimumSeats: number;
  /** The team's pool for the period, whatever its headcount. */
  includedAgentHours: number;
  overageUsdPerAgentHour: number | null;
  summary: string;
  highlights: string[];
}

export interface PlanOffer {
  plan: string;
  name: string;
  pricing: PlanPricing;
  limits: { members: number | null; concurrentRuns: number | null };
  /** Seats this team would be billed for on this plan, given its headcount. */
  billableSeats: number;
  /** What this team would pay a month on this plan. */
  monthlyTotalUsd: number | null;
}

export interface PlanState {
  plan: string;
  planName: string;
  status: string | null;
  limits: { members: number | null; concurrentRuns: number | null };
  usage: { members: number };
  /**
   * Sandbox time this period against what the plan includes. `cap` is
   * the number agents actually stop at, and it is null for a team
   * paying its overage instead. The period runs from the
   * organization's own anniversary, never a calendar month.
   */
  agentHours: { used: number; included: number; cap: number | null; periodStart: string; periodEnd: string };
  /**
   * Whether new runs are being refused right now, and by which wall.
   * Server computed from the same refusals the gate applies, so this
   * cannot disagree with what actually happens when a run asks.
   */
  stopped: "ceiling" | "pool" | null;
  /**
   * What this team has chosen to happen at the end of its allowance.
   * `changeable` is false on Free, which has no subscription for an
   * overage to land on and so has nothing to allow.
   */
  overage: {
    policy: "stop" | "allow";
    changeable: boolean;
    usdPerAgentHour: number | null;
    /** The most this team will pay past the allowance; null for none. */
    ceilingUsd: number | null;
    /** What the overage has come to so far this period. */
    spentUsd: number;
  };
  /**
   * Who spent the hours. Null user means a run nobody started: a stage
   * handed on by the evaluator, or a judge agent.
   *
   * The name is the one recorded when the run finished, not one looked
   * up now, so a month's usage still names the people who spent it
   * after they have left and agrees with the invoice that charged for
   * them.
   */
  usageByMember: { userId: string | null; name: string | null; agentHours: number }[];
  seats: { held: number; billable: number; monthlyTotalUsd: number | null; billed: boolean };
  catalog: PlanOffer[];
  activity?: {
    activity: string;
    fromPlan: string | null;
    toPlan: string | null;
    amountTotal: number | null;
    currency: string | null;
    occurredAt: string;
  }[];
  canManageBilling: boolean;
  upgradable: boolean;
  manageable: boolean;
  salesConfigured: boolean;
}

/**
 * Reads the plan.
 *
 * `absent` and `null` mean different things and both render nothing:
 * absent is an install without billing at all, null is a load still in
 * flight or a request that failed. Latching the two together hid the
 * whole card until a full page reload the first time a fetch dropped.
 */
export function useBillingPlan(reloadKey?: unknown): { plan: PlanState | null; absent: boolean } {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [absent, setAbsent] = useState(false);

  useEffect(() => {
    void fetch("/api/billing/plan", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 404) return setAbsent(true);
        if (!res.ok) return;
        setAbsent(false);
        setPlan((await res.json()) as PlanState);
      })
      .catch(() => {
        // A dropped request says nothing about whether billing exists.
      });
  }, [reloadKey]);

  return { plan, absent };
}

/**
 * Whether this team's runs are being refused right now.
 *
 * Reads the server's own answer rather than re-deriving it from the
 * cap. Re-deriving is how the ceiling stop went silent: the cap is
 * null on the allow policy, so a team stopped by its own overage
 * ceiling had every surface stay quiet while every run was refused.
 */
export function outOfCompute(state: PlanState): boolean {
  return state.stopped !== null;
}

/**
 * When the allowance comes back, as a date.
 *
 * "Next month" is wrong for all but a thirtieth of teams: every
 * organization's period runs from its own anniversary, a paying one
 * from Stripe's period start and a free one from the day it signed up.
 */
export function resetsOn(state: PlanState): string {
  return new Date(state.agentHours.periodEnd).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/** Whole dollars, because every price on the ladder is one. */
export function money(usd: number): string {
  return `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/**
 * The comparison list people read, after dropping claims this product
 * does not keep.
 *
 * Highlights arrive from the cloud module with the prices. A few of
 * those lines still describe a concurrent-agent cap, a 30 day
 * transcript window we never close, and Enterprise extras that are
 * not on the contract. The console is what a person compares, so the
 * rewrite lives here rather than waiting for the module.
 */
export function displayHighlights(highlights: string[]): string[] {
  const out: string[] = [];
  for (const raw of highlights) {
    const line = raw.replace(/,\s*negotiable\b/gi, "").trim();
    if (!line) continue;
    if (/agents? running at (a time|once)\b/i.test(line)) continue;
    if (/^30[ -]day transcript history$/i.test(line)) continue;
    if (/^custom sandbox images$/i.test(line)) continue;
    if (/uptime commitment/i.test(line) || /\ba DPA\b/i.test(line)) continue;
    if (/^unlimited members\b/i.test(line)) {
      out.push("Billed per seat");
      continue;
    }
    out.push(line);
  }
  return out;
}

/** What a plan costs per seat, in words, including the plans that have no price. */
export function seatPrice(pricing: PlanPricing): string {
  if (pricing.perSeatUsd === null) return "Talk to us";
  if (pricing.perSeatUsd === 0) return "Free";
  const price = `${money(pricing.perSeatUsd)} per user a month`;
  return pricing.fromPrice ? `From ${price}` : price;
}

/**
 * What a team pays on a plan, said once so every surface says it the
 * same way. The seat minimum is named whenever it is what decides the
 * number, since a team of two on a five seat plan should meet that fact
 * here rather than on the invoice.
 */
export function monthlyTotal(offer: PlanOffer, held: number): string | null {
  if (offer.monthlyTotalUsd === null) return null;
  if (offer.monthlyTotalUsd === 0) return "Free";
  const total = `${money(offer.monthlyTotalUsd)} a month`;
  const seats = `${offer.billableSeats} ${offer.billableSeats === 1 ? "seat" : "seats"}`;
  if (offer.billableSeats > held) return `${total} (${seats} minimum, this team has ${held})`;
  return `${total} for ${seats}`;
}

/**
 * What changing the headcount by one does to the bill, in words, or
 * null when it does nothing.
 *
 * Said before the click rather than after, because the seat is billed
 * the moment the invitation exists. A team on a plan with a seat
 * minimum often finds that the answer is "nothing", and that is worth
 * saying too: it is the difference between hesitating over an invite
 * and sending it.
 */
export function seatChangeNote(state: PlanState, direction: 1 | -1): string | null {
  const offer = state.catalog.find((entry) => entry.plan === state.plan);
  const perSeat = offer?.pricing.perSeatUsd ?? null;
  if (!offer || !state.seats.billed || perSeat === null || perSeat === 0) return null;

  const minimum = offer.pricing.minimumSeats;
  const before = Math.max(state.seats.held, minimum);
  const after = Math.max(state.seats.held + direction, minimum);
  if (after === before) {
    return `This team pays for ${before} seats, the minimum on ${offer.name}, so the bill does not change.`;
  }
  const verb = direction === 1 ? "goes from" : "drops from";
  return `The bill ${verb} ${money(before * perSeat)} to ${money(after * perSeat)} a month, prorated from today.`;
}
