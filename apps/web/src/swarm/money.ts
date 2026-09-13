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
};

const NOTES: Record<SpendTier, string> = {
  measured: "Reported by the tool itself.",
  estimated: "Worked out from the tokens this tool printed, at its published rate.",
  assumed: "The template's own figure, because this tool reports no cost at all.",
};

export function tierLabel(tier: SpendTier): string {
  return LABELS[tier];
}

export function tierNote(tier: SpendTier): string {
  return NOTES[tier];
}

/** Every tier, always all three, always in the same order. */
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
  return spend.assumedUsd;
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
   * True when the measured spend alone has reached the cap. Only the
   * measured tier can close a budget: stopping a swarm on a figure
   * nobody measured is a refusal we could not defend to whoever set
   * the number.
   */
  spent: boolean;
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
    spent: capUsd !== null && capUsd > 0 && spend.measuredUsd >= capUsd,
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
  };
}

/**
 * The estimate line, in the dialog's own words. Says what it is
 * counting, because an estimate over an unknown number of leaves is
 * the figure people most want the caveat on.
 */
export function estimateLine(spend: SwarmSpend, leaves: number): string {
  const tasks = `${leaves} ${leaves === 1 ? "task" : "tasks"}`;
  return `About ${spendLine(spend)} over ${tasks}.`;
}
