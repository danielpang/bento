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
    ],
  },
  {
    id: "conversations",
    date: "2026-08-07",
    title: "Runs read as conversations",
    summary:
      "An agent run was a transcript you watched scroll. It is now a thread you can talk to, and one that survives the server restarting underneath it.",
    items: [
      {
        title: "A card's run is a conversation",
        body: "Every run on a card shares one thread, with each agent's turns attributed to it by name, so a card that has been through three stages reads as one piece of work rather than three logs.",
      },
      {
        title: "Sessions live through a deploy",
        body: "A deploy no longer strands a running agent. Sessions are re-attached when the server comes back, and open viewers resync from the board snapshot rather than sitting on a stream that will never speak again.",
      },
      {
        title: "You see the message as it is typed",
        body: "A message being composed streams to everyone watching that run, so two people on the same card are not each waiting on a thing the other has already said.",
      },
      {
        title: "Selecting a card brings it out from under the drawer",
        body: "On iPad the drawer covered the lane the selected card was in. The board now scrolls the card clear, one frame at a time, which is what it took for WebKit to agree.",
      },
      {
        title: "Publish a hosted card from its sandbox",
        body: "Cards running on hosted sandboxes can open their pull request on demand instead of only when a stage's gate says so.",
      },
      {
        title: "The board remembers which project you were on",
        body: "A reload lands on the board you were last looking at, and falls back to the first visible project when that one belongs to a team you have since left.",
      },
      {
        title: "Contact from inside the console",
        body: "An issue report or a feature request, sent from the app, landing in our inbox. It is the form the button at the bottom of this page opens.",
      },
    ],
  },
  {
    id: "sprites",
    date: "2026-08-06",
    title: "Hosted sandboxes, and a new mark",
    items: [
      {
        title: "Sprite runs behave like every other run",
        body: "Agent runs on hosted sandboxes emit the same events, report the same statuses, and end the same way as runs on a local Docker sandbox, so the board cannot tell you a different story depending on where the work happened.",
      },
      {
        title: "A quiet agent is not a dead one",
        body: "A run that produced no output for a long stretch was being reaped as stalled. Long silences during a build or a test suite now keep the session alive.",
      },
      {
        title: "One session marker per run",
        body: "Runs that reconnected were recording a second session-started marker, which showed as the same run beginning twice in its history.",
      },
      {
        title: "The bento mark",
        body: "A new logo and a full set of favicons: four compartments on a dark plate, sized unevenly so the silhouette survives a 16px tab.",
      },
      {
        title: "Agents are listed by name",
        body: "Dialogs no longer open a picker on top of a picker, and agents are listed by the name you gave them rather than by the CLI they run on.",
      },
    ],
  },
  {
    id: "github-installations",
    date: "2026-08-04",
    title: "GitHub installations and project creation",
    items: [
      {
        title: "Installations approved from a request are adopted",
        body: "When an organization owner approves a GitHub App installation that someone else requested, Bento now picks it up instead of waiting for an installation it started itself.",
      },
      {
        title: "A project can be created without a repository",
        body: "Project creation was blocked on a session organization and on naming a repository up front. Both are now optional, so a board can exist before its code does.",
      },
    ],
  },
  {
    id: "foundations",
    date: "2026-08-03",
    title: "Migrations and deploys",
    items: [
      {
        title: "db:migrate reports what it did",
        body: "The migration command now says which migrations were applied and which were already in place, rather than exiting silently either way.",
      },
      {
        title: "Continuous deployment",
        body: "Bento and the hosted console deploy from CI.",
      },
    ],
  },
  {
    id: "first-commit",
    date: "2026-07-26",
    title: "Bento",
    summary:
      "A board where cards move through a staged pipeline and a coding agent works each stage: one card, one agent, one branch.",
    items: [],
  },
];
