/**
 * What has shipped, newest first.
 *
 * Written by hand rather than generated from git. A commit subject is
 * addressed to whoever maintains this repository; a changelog entry is
 * addressed to whoever uses the console, and the two rarely want the
 * same sentence. "Keep quiet agent runs alive on Sprites" is the honest
 * name of the change and tells a user nothing about what stopped
 * happening to their cards.
 *
 * `id` is the address of the entry: /changelog#<id>. Once an id is
 * published it is a permanent link that somebody may have pasted into
 * an issue, so rename the heading freely and leave the id alone.
 */
export interface ChangelogEntry {
  /** The anchor this entry answers to. Never change a published one. */
  id: string;
  /** ISO date. Rendered in the reader's locale, sorted as written. */
  date: string;
  title: string;
  /** A line under the heading, in prose. Skipped when the items say it. */
  summary?: string;
  items: { title: string; body: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "cursor-composer-2",
    date: "2026-08-19",
    title: "Composer 2 and Composer 2.5 in the Cursor CLI picker",
    items: [
      {
        title: "Cursor's own models include the current Composer ids",
        body: "Choosing Cursor CLI, then the Cursor provider, listed Composer 1 and Auto. Composer 2, Composer 2.5, and their Fast variants are in that list now, using the same ids the CLI takes on --model.",
      },
      {
        title: "Grok for Cursor CLI refreshes from models.dev",
        body: "The xAI list the Cursor CLI offers is now the models.dev snapshot, billed through your Cursor key, so ids such as Grok 4.6 show up when that snapshot is refreshed. Composer is still listed by hand: models.dev has no Cursor provider for it.",
      },
    ],
  },
  {
    id: "finish-early",
    date: "2026-08-17",
    title: "Move a card to Done from anywhere",
    items: [
      {
        title: "The Done lane takes drops",
        body: "Drag a card onto Done from any lane, including the backlog, and it is marked done with the remaining stages skipped rather than approved one at a time. A one-line copy fix does not need a design review, and a card somebody finished by hand wants recording rather than running.",
      },
      {
        title: "Mark done in the card's drawer",
        body: "The same move without a mouse, beside the stage actions. The card keeps the stage it was in, so Reopen puts it back there, and a card finished from the backlog reopens into the backlog.",
      },
    ],
  },
  {
    id: "board-navigation",
    date: "2026-08-07",
    title: "A board you can work from a phone",
    summary:
      "The console's chrome was built for a wide screen and said so on a narrow one. This release is about the parts around the board rather than the board itself.",
    items: [
      {
        title: "The topbar collapses into a menu",
        body: "Below 720px the project tools (agents, pipeline, repositories, contact, settings) move behind one button instead of wrapping into three rows of text above a board with no height left.",
      },
      {
        title: "A Done lane",
        body: "Finished and cancelled cards leave the stage they ended in and collect at the right of the board. A five-card review lane where four were already shipped used to read as a queue.",
      },
      {
        title: "Search the board",
        body: "One field over every lane, matching a card's title, its description, and any ticket id written in either. Punctuation is ignored, so ENG-441, eng 441, and eng441 all find the same card.",
      },
      {
        title: "Contact moved to the bottom bar",
        body: "Contact and this changelog now sit in a strip along the bottom of the console, reachable from any width without opening a menu first.",
      },
      {
        title: "The tab icon updates when it changes",
        body: "Icon links now carry a hash of the file behind them, so replacing an icon changes its address and browsers stop drawing the one they cached. The Mac app also picks up the bento mark, which it had never been given.",
      },
    ],
  },
];
