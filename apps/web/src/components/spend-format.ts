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
