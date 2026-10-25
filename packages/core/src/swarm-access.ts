/**
 * Whether a person may run swarms here, or is shown the waitlist. Local
 * Bento is always "open"; hosted Bento waitlists people its flag has not
 * let in.
 */
export type SwarmAccessState = "open" | "waitlist";
