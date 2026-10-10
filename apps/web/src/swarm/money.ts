import type { SpendTier, SwarmSpend } from "./types.js";
import { SPEND_TIERS } from "./layout.js";

/**
 * What a swarm has spent, and how well that is known.
 *
 * A tool that reports its own cost is measured; a tool that prints
 * tokens is estimated from a published rate. A tool that reports
 * neither has an unknown cost. The legacy assumed field remains on
 * the wire but is never displayed or counted against a budget.
 *
 * The stacked bar is the one place they sit together, and even there
 * they are three segments with three figures beside them.
 */

export interface SpendPart {
  tier: SpendTier;
  usd: number;
  label: string;
  /** Why this figure is in this tier, for the control's title. */
  note: string;
}

const LABELS: Record<SpendTier, string> = {
  measured: "measured",
  estimated: "estimated",
  assumed: "assumed",
  notional: "notional",
};

const NOTES: Record<SpendTier, string> = {
  measured: "Reported by the tool itself.",
  estimated: "Worked out from the tokens this tool printed, at its published rate.",
  assumed: "Legacy synthetic cost. No new runs receive this tier.",
  notional: "A list price for work a subscription had already paid for. The budget does not count it.",
};

export function tierLabel(tier: SpendTier): string {
  return LABELS[tier];
}

export function tierNote(tier: SpendTier): string {
  return NOTES[tier];
}

/** Every tier, always all of them, always in the same order. */
export function spendParts(spend: SwarmSpend): SpendPart[] {
  return SPEND_TIERS.map((tier) => ({
    tier,
    usd: usdFor(spend, tier),
    label: LABELS[tier],
    note: NOTES[tier],
  }));
}

export function usdFor(spend: SwarmSpend, tier: SpendTier): number {
  if (tier === "measured") return spend.measuredUsd;
  if (tier === "estimated") return spend.estimatedUsd;
  if (tier === "assumed") return spend.assumedUsd;
  return spend.notionalUsd;
}

/**
 * What the budget actually counts.
 *
 * The two priced tiers, excluding legacy synthetic costs and subscription
 * list prices. Written
 * here and used everywhere a figure is compared with the cap, because
 * the moment two places work it out one of them will forget which tier
 * is which.
 */
export function cappedUsd(spend: SwarmSpend): number {
  return spend.measuredUsd + spend.estimatedUsd;
}

/**
 * Whether a tool actually reported a priced figure.
 *
 * Measured and estimated only, matching `cappedUsd`: a silent agent
 * and a leftover assumed charge both read as nothing reported.
 */
export function hasReportedSpend(spend: SwarmSpend): boolean {
  return cappedUsd(spend) > 0;
}

/**
 * Whether the swarm goal should print a spend figure.
 *
 * Hidden when the agents reported nothing and the swarm has no
 * budget. A budget is itself a figure, so a zero against a cap
 * still shows; a reported price shows even without a cap.
 */
export function showSwarmSpend(spend: SwarmSpend, budgetUsd: number | null): boolean {
  return budgetUsd !== null || hasReportedSpend(spend);
}

/**
 * Whether this swarm is spending a subscription rather than a bill.
 *
 * True the moment any of its runs borrowed a logged in agent session,
 * which is only ever a local install. The cap still exists and is
 * still shown; what changes is that it warns instead of stopping, so
 * the panel says so rather than leaving somebody to wonder why a swarm
 * sailed past its budget.
 */
export function isNotional(spend: SwarmSpend): boolean {
  return spend.notionalUsd > 0;
}

/** Dollars as every figure in the console prints them. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * The header's spend line: three figures, each with the word that
 * says how much to trust it.
 */
export function spendLine(spend: SwarmSpend): string {
  return spendParts(spend)
    .map((part) => `${formatUsd(part.usd)} ${part.label}`)
    .join(", ");
}

/**
 * The same line for a node, which usually has only one tier on it.
 * Tiers at zero are dropped here and only here: a leaf card is 124px
 * wide, and zero valued tiers add no information. A node with no
 * reported spend prints nothing rather than a placeholder zero.
 */
export function nodeSpendLine(spend: SwarmSpend): string {
  const spent = spendParts(spend).filter((part) => part.usd > 0);
  if (spent.length === 0) return "";
  return spent.map((part) => `${formatUsd(part.usd)} ${part.label}`).join(", ");
}

/** The compact figure on a node's face, with the tiers it stands for. */
export function nodeSpendChip(spend: SwarmSpend): { text: string; title: string } | null {
  const spent = spendParts(spend).filter((part) => part.usd > 0);
  if (spent.length === 0) return null;
  const lead = spent[0]!;
  return {
    // A plus rather than a sum: the other tiers are named in the title
    // and printed in full in the drawer, and neither figure here is
    // pretending to be the other's total.
    text: spent.length > 1 ? `${formatUsd(lead.usd)}+` : formatUsd(lead.usd),
    title: spent.map((part) => `${formatUsd(part.usd)} ${part.label}. ${part.note}`).join(" "),
  };
}

export interface CapSegment extends SpendPart {
  /** This tier's own share of the cap, 0 to 1. Never a combined fill. */
  ratio: number;
}

export interface CapUse {
  segments: CapSegment[];
  capUsd: number | null;
  /** What the cap is, in words. */
  capLine: string;
  /**
   * True when what the budget counts has reached the cap.
   *
   * Reported prices and estimates from reported tokens, matching the
   * server. Silent tools remain unreported.
   */
  spent: boolean;
  /** Whether a cap this swarm passed would warn rather than stop it. */
  notional: boolean;
}

/**
 * The budget bar: one segment per tier, each measured against the cap
 * on its own. There is deliberately no single fill figure to read.
 */
export function capUse(spend: SwarmSpend, capUsd: number | null): CapUse {
  const parts = spendParts(spend);
  const segments = parts.map((part) => ({
    ...part,
    ratio: capUsd && capUsd > 0 ? Math.min(1, Math.max(0, part.usd / capUsd)) : 0,
  }));
  return {
    segments,
    capUsd,
    capLine: capUsd === null ? "no cap set" : `against a ${formatUsd(capUsd)} cap`,
    spent: capUsd !== null && capUsd > 0 && cappedUsd(spend) >= capUsd,
    notional: isNotional(spend),
  };
}

/**
 * The estimate line, in the dialog's own words. Says what it is
 * counting, because an estimate over an unknown number of leaves is
 * the figure people most want the caveat on.
 */
export function estimateLine(spend: SwarmSpend, leaves: number): string {
  const tasks = `${leaves} ${leaves === 1 ? "task" : "tasks"}`;
  /*
   * The tiers this plan actually spends in, and not the others.
   *
   * Spend prints every tier including the zeros, because a zero there
   * is information: nothing has been measured yet. A forecast is the
   * other way round. A plan whose tools all report their cost has
   * no estimated figure to predict, so zero valued tiers are omitted.
   */
  return `About ${nodeSpendLine(spend) || formatUsd(0)} over ${tasks}.`;
}
