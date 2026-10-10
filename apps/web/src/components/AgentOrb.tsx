import { ThinkingOrb, type OrbState } from "thinking-orbs";

/** Animation is decoration; a stilled frame carries the same meaning. */
export const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which orb animation fits what the agent is doing right now. */
export function orbStateFor(tool: string | null): OrbState {
  if (!tool) return "shaping";
  if (/read|grep|glob|search|fetch|ls|find/i.test(tool)) return "searching";
  if (/edit|write|patch|notebook/i.test(tool)) return "composing";
  if (/task|todo|plan|agent|think/i.test(tool)) return "solving";
  return "working";
}

/**
 * The orb that says an agent is processing, wherever one is shown: a
 * card's conversation, a swarm's planner, a swarm's worker on its node
 * and in its logs. One component so the swarm board and the card board
 * cannot drift into two ideas of "working".
 *
 * Inline sized, the one preset the library tunes for running text.
 * The 64 preset is for a pane with nothing else in it.
 */
export function AgentOrb({ tool = null, label, hero = false }: {
  /** The tool the agent is in, when known, which picks the animation. */
  tool?: string | null;
  label: string;
  /** The large preset, for a pane that is waiting on a first line. */
  hero?: boolean;
}) {
  return (
    <ThinkingOrb
      state={orbStateFor(tool)}
      size={hero ? 64 : 20}
      paused={REDUCED_MOTION}
      aria-label={label}
      className={hero ? "agent-orb agent-orb-hero" : "agent-orb agent-orb-inline"}
    />
  );
}
