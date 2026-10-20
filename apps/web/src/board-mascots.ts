/**
 * When the board's two mascots come out.
 *
 * They are company for a quiet board, not decoration for a busy one, so
 * they show only while the board holds a handful of cards: past that,
 * the bottom of the last lane is where cards are, and the mascots would
 * sit on top of work. They also stay away while the drawer is open (it
 * covers the corner they stand in), while a search or a filter is
 * narrowing the board (an empty lane then means "no matches", not "no
 * work"), and in the list view, which has no lanes to stand beside.
 */
export const MASCOT_MAX_CARDS = 3;

export function showBoardMascots({
  cards,
  drawerOpen,
  narrowed,
}: {
  /** Every card on the board, finished ones included. */
  cards: number;
  drawerOpen: boolean;
  /** A search query or a focus filter is applied. */
  narrowed: boolean;
}): boolean {
  return cards <= MASCOT_MAX_CARDS && !drawerOpen && !narrowed;
}
