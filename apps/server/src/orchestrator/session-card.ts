import type { features } from "@bento/db";

type Feature = Pick<typeof features.$inferSelect, "standalone" | "currentStageId">;

/**
 * Whether a card's runs are a plain conversation rather than stage work.
 *
 * A session started from the Sessions tab has no stage, and its runs
 * carry the pipeline's first stage only because every card run names
 * one. While it sits in the backlog the agent hears the person, not a
 * stage's goal, and nothing publishes on its own. Once somebody moves
 * it into a stage it is an ordinary card, so the flag alone does not
 * decide.
 */
export function isSessionCard(feature: Feature): boolean {
  return feature.standalone && feature.currentStageId === null;
}

/** How long a session's title may be before it is cut, in characters. */
export const SESSION_TITLE_MAX = 80;

/**
 * A session's title, from the first thing the person said: its first
 * non-empty line, cut at a word where it can be. The whole message is
 * kept as the card's description, so nothing is lost by cutting.
 */
export function sessionTitle(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const flat = line.replace(/\s+/g, " ");
  if (flat.length <= SESSION_TITLE_MAX) return flat || "New session";
  const cut = flat.slice(0, SESSION_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SESSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
