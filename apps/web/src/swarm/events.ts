/**
 * Which board a live event belongs to.
 *
 * Both boards travel on the project's one channel, so the pipeline
 * screen hears a swarm's events as well as its own. It must ignore
 * them: the card board's handler falls through to a debounced full
 * refresh, so one running swarm re-fetched stages, features and usage
 * up to four times a second for everybody looking at the Pipeline, and
 * none of those figures had changed. The swarm page has its own stream
 * and is what those events are for.
 */
export function isSwarmEvent(event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("swarm_");
}
