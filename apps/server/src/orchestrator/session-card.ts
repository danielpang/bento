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

export { SESSION_TITLE_MAX, sessionTitle } from "@bento/core";
