import type { FeatureSpend } from "@bento/api-client";

export type SpendSort = "spend-desc" | "spend-asc" | "title-asc" | "title-desc";

/**
 * Highest measured first, unmeasured last. A null is a tool that
 * printed nothing, not a cheap card, so it must not sort as zero.
 */
export function compareFeatureSpend(a: FeatureSpend, b: FeatureSpend, sort: SpendSort): number {
  if (sort === "title-asc" || sort === "title-desc") {
    const titles = a.title.localeCompare(b.title);
    return sort === "title-desc" ? -titles : titles;
  }
  const aVal = a.costUsd;
  const bVal = b.costUsd;
  if (aVal === null && bVal === null) return a.title.localeCompare(b.title);
  if (aVal === null) return 1;
  if (bVal === null) return -1;
  const diff = sort === "spend-desc" ? bVal - aVal : aVal - bVal;
  return diff !== 0 ? diff : a.title.localeCompare(b.title);
}

/** What the spend column says, including how much of it is actually known. */
export function formatFeatureSpend(row: FeatureSpend): string {
  if (row.runs === 0) return "No runs";
  if (row.costUsd === null) return "Not reported";
  const figure = `$${row.costUsd.toFixed(2)}`;
  return row.runsWithoutCost > 0 ? `${figure}+` : figure;
}

/**
 * The sentence at the top of the Spend page.
 *
 * It counts card runs, because that is what the figure beside it is a
 * sum of: a swarm's runs belong to no card and are grouped as swarms
 * further down. So it says so. A project worked entirely by swarms
 * used to open with "No agent runs yet." directly above a table
 * reporting forty dollars, which is the page disagreeing with itself
 * in the two lines a person reads first.
 *
 * The swarm money is deliberately not added in. Its four tiers are
 * kept apart everywhere else precisely so that no single figure stands
 * for a measurement, an estimate, a guess and a list price at once,
 * and the headline is the worst place in the product to start.
 */
export function spendHeadline(
  usage: { totalUsd: number; totalRuns: number; runsWithoutCost: number },
  swarmRuns: number,
): string {
  if (usage.totalRuns === 0) {
    // "on cards" only when there is something else on the page for it
    // to be distinguished from.
    return swarmRuns > 0 ? "No runs on cards yet." : "No agent runs yet.";
  }
  const figure = `$${usage.totalUsd.toFixed(2)}`;
  if (usage.runsWithoutCost > 0) {
    const measured = usage.totalRuns - usage.runsWithoutCost;
    return `${figure}+ across ${measured} of ${usage.totalRuns} runs on cards.`;
  }
  return `${figure} across ${usage.totalRuns} run${usage.totalRuns === 1 ? "" : "s"} on cards.`;
}

/**
 * Compact figure for a finished card's face. Null when there is
 * nothing to print: a missing cost is not shown as zero, and an
 * in-progress card does not wear a number at all.
 */
export function formatCardSpend(
  row: Pick<FeatureSpend, "costUsd" | "runsWithoutCost"> | undefined,
): string | null {
  if (!row || row.costUsd === null) return null;
  const figure = `$${row.costUsd.toFixed(2)}`;
  return row.runsWithoutCost > 0 ? `${figure}+` : figure;
}
