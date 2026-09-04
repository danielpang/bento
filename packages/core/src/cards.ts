/**
 * Wording about a card that spawned other cards.
 *
 * Shared so the console's disabled Delete button and the server's
 * refusal say the same thing. A button whose tooltip and the toast
 * behind it disagree reads as two different rules.
 */

/** Why a card that spawned parts cannot be deleted, naming the count. */
export function parentDeleteRefusal(children: number): string {
  return children === 1
    ? "This card was split into 1 other card. Delete or finish that card first."
    : `This card was split into ${children} other cards. Delete or finish those cards first.`;
}

/**
 * The badge a parent card wears on the board, and what it means.
 *
 * One chip, in the meta row beside the pull request chip. Its tone is
 * the group's worst news first: a failed part is the thing to look at,
 * then one still moving, then all of them finished. A card that spawned
 * nothing wears no chip at all, which is what keeps the board unchanged
 * for teams that never split anything.
 */
export type ChildTone = "failed" | "running" | "done" | "idle";

export interface ChildStats {
  total: number;
  running: number;
  failed: number;
  done: number;
}

export function childTone(stats: ChildStats): ChildTone {
  if (stats.failed > 0) return "failed";
  if (stats.running > 0) return "running";
  if (stats.total > 0 && stats.done === stats.total) return "done";
  return "idle";
}

/** The chip's own words: how many parts, and what they are doing. */
export function childBadgeLabel(stats: ChildStats): string {
  const parts = stats.total === 1 ? "1 part" : `${stats.total} parts`;
  if (stats.failed > 0) return `${parts}, ${stats.failed} failed`;
  if (stats.running > 0) return `${parts}, ${stats.running} running`;
  if (stats.total > 0 && stats.done === stats.total) return `${parts}, all done`;
  return parts;
}

/**
 * The counts behind the badge, from cards the caller already holds.
 *
 * Derived rather than fetched: every child of a card is a card in the
 * same project, so a console showing the board already has all of them
 * and their run statuses. That also makes the badge live, because it
 * repaints from the same board stream everything else does, with no
 * request of its own.
 */
export function childStatsFrom(
  parentId: string,
  cards: { id: string; parentId?: string | null; status: string }[],
  runStatusById: Record<string, string | undefined>,
): ChildStats {
  const children = cards.filter((card) => card.parentId === parentId);
  const stats: ChildStats = { total: children.length, running: 0, failed: 0, done: 0 };
  for (const child of children) {
    const run = runStatusById[child.id];
    // A card's own status outranks its last run, the same rule the
    // board card itself uses: work that is over is over, whatever the
    // run that ended it said.
    if (child.status === "done" || child.status === "cancelled") {
      stats.done += 1;
      continue;
    }
    if (run === "queued" || run === "starting" || run === "running") stats.running += 1;
    else if (run === "failed") stats.failed += 1;
  }
  return stats;
}
