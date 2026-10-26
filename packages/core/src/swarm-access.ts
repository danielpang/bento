/**
 * Whether a person may run swarms here, or is shown the waitlist. Local
 * Bento is always "open"; hosted Bento waitlists people its flag has not
 * let in, and says "unavailable" when the flag could not be read, which
 * is never treated as allowed or as a no.
 */
export type SwarmAccessState = "open" | "waitlist" | "unavailable";
