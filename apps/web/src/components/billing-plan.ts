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
  limits: { members: number | null };
  /** Seats this team would be billed for on this plan, given its headcount. */
  billableSeats: number;
  /** What this team would pay a month on this plan. */
  monthlyTotalUsd: number | null;
}

export interface PlanState {
  plan: string;
  planName: string;
  status: string | null;
  limits: { members: number | null };
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
  /**
   * Which cards spent the hours this billing month. Prefer this over
   * usageByMember: a team of forty people is still a handful of cards
   * doing the work, and "who used it" on a board is the card.
   *
   * Absent when the billing module has not started sending it; the
   * console then rolls the period (from periodStart) up from runs.
   */
  usageByFeature?: { featureId: string; title: string; agentHours: number }[];
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

/**
 * When this billing month began, as a date.
 *
 * The ranking is hours since this instant, not since the first of the
 * calendar month. Printing it next to "By card" is what keeps those
 * two from being mistaken for each other.
 */
export function startedOn(periodStart: string): string {
  return new Date(periodStart).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/**
 * A hours figure as people read it: whole when the tenth is zero,
 * one decimal otherwise. The meter and the per-card rows have to
 * agree, and 12.00 on a billing card looks like a bug.
 */
export function formatHours(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "1 hour" or "12.4 hours", for a row that would otherwise say "1 hours". */
export function formatHoursPhrase(n: number): string {
  return `${formatHours(n)} ${Math.round(n * 10) / 10 === 1 ? "hour" : "hours"}`;
}

export type HoursUsage = {
  used: number;
  included: number;
  remaining: number;
  overage: number;
  /** 0 to 1, against the included allowance, never past full. */
  fillRatio: number;
};

/**
 * The allowance broken into the numbers the hours card prints.
 *
 * Remaining and overage are mutually exclusive: a team still inside
 * the pool has leftover hours, and a team past it has overage, never
 * both. The fill is capped at the included hours so a paying overage
 * does not blow the meter past the track.
 */
export function hoursUsage(hours: PlanState["agentHours"]): HoursUsage {
  const included = Math.max(0, hours.included);
  const used = Math.max(0, hours.used);
  return {
    used,
    included,
    remaining: Math.max(0, included - used),
    overage: Math.max(0, used - included),
    fillRatio: included === 0 ? (used > 0 ? 1 : 0) : Math.min(1, used / included),
  };
}

/**
 * How the hours meter should colour.
 *
 * Stopped is the wall the gate already hit. Overage is a team that
 * chose to pay past the pool. Warn is the same three-quarters line
 * the usage email already sends, so the card and the inbox agree.
 */
export function hoursMeterState(
  usage: HoursUsage,
  stopped: PlanState["stopped"],
): "stopped" | "over" | "warn" | undefined {
  if (stopped) return "stopped";
  if (usage.overage > 0) return "over";
  if (usage.fillRatio >= 0.75) return "warn";
  return undefined;
}

/** How many spenders the hours card shows before collapsing the rest. */
export const HOURS_PREVIEW = 5;

/** Matches shown for a title filter. The rest ask for a longer query. */
export const HOURS_MATCH_CAP = 20;

export type HoursEntry = { id: string; name: string; agentHours: number };

export type RankedHoursEntries = {
  ranked: HoursEntry[];
  preview: HoursEntry[];
  rest: HoursEntry[];
  restHours: number;
};

/**
 * Who spent hours, heaviest first, with the card's preview cut.
 *
 * Zero-hour rows are dropped: a board of forty cards would otherwise
 * be a directory, and Billing is answering which cards used the pool,
 * not which ones could have. The rest are summarised, not listed,
 * because mounting every title (even behind a "show all") is what
 * fails to scale.
 */
export function rankHoursEntries(
  entries: HoursEntry[],
  preview = HOURS_PREVIEW,
): RankedHoursEntries {
  const ranked = [...entries]
    .filter((entry) => entry.agentHours > 0)
    .sort((a, b) => b.agentHours - a.agentHours || a.name.localeCompare(b.name));
  const rest = ranked.slice(preview);
  return {
    ranked,
    preview: ranked.slice(0, preview),
    rest,
    restHours: rest.reduce((sum, entry) => sum + entry.agentHours, 0),
  };
}

/** A title filter over the ranked spenders. */
export function filterHoursEntries(ranked: HoursEntry[], query: string): HoursEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return ranked;
  return ranked.filter((entry) => entry.name.toLowerCase().includes(needle));
}

export function hoursEntriesFromFeatures(
  features: { featureId: string; title: string; agentHours: number }[],
): HoursEntry[] {
  return features.map((entry) => ({
    id: entry.featureId,
    name: entry.title,
    agentHours: entry.agentHours,
  }));
}

/**
 * Width of a row's bar, 0 to 1, against the heaviest spender.
 *
 * Scaling to the included pool draws a 12 hour row as a sliver on a
 * 500 hour Business allowance, which is exactly when a team is large
 * enough to need the breakdown. The heaviest row is full; everyone
 * else is relative to them.
 */
export function hoursBarFill(hours: number, heaviest: number): number {
  if (heaviest <= 0 || hours <= 0) return 0;
  return Math.min(1, hours / heaviest);
}

/** Share of a whole, as people read a percentage. Null when there is nothing to say. */
export function formatHoursShare(part: number, whole: number): string | null {
  if (whole <= 0 || part <= 0) return null;
  const pct = Math.round((part / whole) * 100);
  if (pct < 1) return "<1%";
  return `${pct}%`;
}

/**
 * The collapsed tail of the hours list, in one sentence.
 *
 * Naming the count and the hours is what makes the preview honest:
 * the top five are not "the team".
 */
export function hoursRestCopy(
  count: number,
  hours: number,
  used: number,
  noun: { singular: string; plural: string },
): string {
  const who = count === 1 ? `and 1 more ${noun.singular} used` : `and ${count} more ${noun.plural} used`;
  const body = `${who} ${formatHoursPhrase(hours)} this period`;
  const share = formatHoursShare(hours, used);
  return share ? `${body} (${share}).` : `${body}.`;
}

/** Whole dollars, because every price on the ladder is one. */
export function money(usd: number): string {
  return `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/**
 * The note under the checkout overage choice.
 *
 * Each option's note has to describe that option. The old allow copy
 * opened with "Agents stop if overage passes...", which is what a
 * person who just picked "keep going" would take for the stop policy.
 */
export function overageCheckoutNote(
  policy: "stop" | "allow" | null,
  monthlyTotalUsd: number | null,
): string {
  if (policy === "stop") {
    return "New agents will not start once the included hours are used. You can change this later under Billing.";
  }
  if (policy === "allow" && monthlyTotalUsd !== null) {
    return `Overage is capped at ${money(monthlyTotalUsd)}, so your bill cannot more than double. Change or remove that under Billing whenever you like.`;
  }
  return "You can change this later under Billing.";
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

/**
 * The per-user figure on a paid plan, without the "per user" that the
 * label already says. Null when there is no rate to put in that slot.
 */
export function seatRate(pricing: PlanPricing): string | null {
  if (pricing.perSeatUsd === null || pricing.perSeatUsd === 0) return null;
  const amount = `${money(pricing.perSeatUsd)} a month`;
  return pricing.fromPrice ? `From ${amount}` : amount;
}

export type MonthlyTotalParts = {
  /** "$58 a month", or Free. */
  amount: string;
  /** Who that number is for. Null on Free, where seats are not the bill. */
  seats: string | null;
};

/**
 * What a team pays on a plan, as the figures the card prints.
 *
 * Amount and seats are separate so the Plan card can label them
 * rather than packing both into one sentence beside the name. The
 * seat minimum is named whenever it is what decides the number.
 */
export function monthlyTotalParts(offer: PlanOffer, held: number): MonthlyTotalParts | null {
  if (offer.monthlyTotalUsd === null) return null;
  if (offer.monthlyTotalUsd === 0) return { amount: "Free", seats: null };
  const seats = `${offer.billableSeats} ${offer.billableSeats === 1 ? "seat" : "seats"}`;
  return {
    amount: `${money(offer.monthlyTotalUsd)} a month`,
    seats: offer.billableSeats > held ? `${seats} minimum, this team has ${held}` : seats,
  };
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
