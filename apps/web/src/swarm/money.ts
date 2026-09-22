import type { SpendTier, SwarmSpend, SwarmTemplate } from "./types.js";
import { SPEND_TIERS } from "./layout.js";

/**
 * What a swarm has spent, and how well that is known.
 *
 * Three figures, never one. A tool that reports its own cost is
 * measured; a tool that prints tokens is estimated from a published
 * rate; a tool that prints nothing at all is assumed from the
 * template's own figure. Adding them would produce a number whose
 * accuracy nobody could state, printed next to a budget people set
 * real limits with, so nothing in this module returns a total and
 * every line it writes keeps the three apart.
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
  assumed: "The template's own figure, because this tool reports no cost at all.",
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
 * The three tiers somebody is billed for, and not the fourth. Written
 * here and used everywhere a figure is compared with the cap, because
 * the moment two places work it out one of them will forget which tier
 * is which.
 */
export function cappedUsd(spend: SwarmSpend): number {
  return spend.measuredUsd + spend.estimatedUsd + spend.assumedUsd;
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

/**
 * How much of what a swarm has spent is a figure nobody measured.
 *
 * Past a quarter, the cap is soft and the product says so: a budget
 * enforced against mostly assumed figures is a budget enforced against
 * a guess, and somebody who set $40 deserves to know that before the
 * swarm stops rather than after.
 */
export const SOFT_CAP_SHARE = 0.25;

export function assumedShare(spend: SwarmSpend): number {
  const counted = cappedUsd(spend);
  return counted <= 0 ? 0 : spend.assumedUsd / counted;
}

export function capIsSoft(spend: SwarmSpend): boolean {
  return assumedShare(spend) > SOFT_CAP_SHARE;
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
 * wide, and "$0.00 estimated, $0.00 assumed" is the two thirds of it
 * that says nothing. A node that has spent nothing at all still
 * prints one figure rather than an empty slot.
 */
export function nodeSpendLine(spend: SwarmSpend): string {
  const spent = spendParts(spend).filter((part) => part.usd > 0);
  if (spent.length === 0) return formatUsd(0);
  return spent.map((part) => `${formatUsd(part.usd)} ${part.label}`).join(", ");
}

/** The compact figure on a node's face, with the tiers it stands for. */
export function nodeSpendChip(spend: SwarmSpend): { text: string; title: string } {
  const spent = spendParts(spend).filter((part) => part.usd > 0);
  if (spent.length === 0) return { text: formatUsd(0), title: "Nothing reported yet." };
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
   * All three billed tiers, which is what the server enforces: a swarm
   * whose tools print nothing would otherwise run forever against any
   * budget, because nothing it ever spent would be measured. The
   * notional tier is left out here for the same reason it is left out
   * there, and the panel says when a cap is soft.
   */
  spent: boolean;
  /** Whether a cap this swarm passed would warn rather than stop it. */
  notional: boolean;
  /** Whether more than a quarter of the counted spend was assumed. */
  soft: boolean;
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
    soft: capIsSoft(spend),
  };
}

/**
 * What the New swarm dialog prints before anybody presses Create.
 *
 * Split the three ways the run will report in, from the template's own
 * per leaf figures: a person choosing a template is choosing how much
 * of their bill will be a measurement and how much a guess, and one
 * blended number would hide exactly that.
 */
export function estimateSwarm(
  template: Pick<SwarmTemplate, "perLeaf" | "typicalLeaves">,
  leaves = template.typicalLeaves,
): SwarmSpend {
  const count = Math.max(0, Math.round(leaves));
  return {
    measuredUsd: template.perLeaf.measuredUsd * count,
    estimatedUsd: template.perLeaf.estimatedUsd * count,
    assumedUsd: template.perLeaf.assumedUsd * count,
    notionalUsd: template.perLeaf.notionalUsd * count,
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
   * The tiers this template actually spends in, and not the others.
   *
   * Spend prints every tier including the zeros, because a zero there
   * is information: nothing has been measured yet. A forecast is the
   * other way round. A template whose tools all report their cost has
   * no assumed figure to predict, and "$0.00 assumed" in a dialog
   * somebody reads before pressing Create is a line about a thing that
   * is not going to happen.
   */
  return `About ${nodeSpendLine(spend)} over ${tasks}.`;
}
