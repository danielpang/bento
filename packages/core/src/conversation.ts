/**
 * How a follow-up prompt is built, and when a live session should stay
 * open after a turn. Shared by the server orchestrator and the local
 * runner so the two cannot drift.
 */

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AgentRunPromptInput {
  cli: string;
  /**
   * The user-typed (or queued) message for this run. Empty on a fresh
   * stage run, in which case the agent receives the stage prompt alone.
   */
  followUp: string | null;
  stagePrompt: string;
  /**
   * True when this run resumes a CLI session that still holds the
   * conversation. The follow-up is then the whole prompt: the tool
   * already has everything that came before.
   */
  resume: boolean;
  /** Prior turns, already compacted, for a run that cannot resume. */
  compacted?: string;
  /** Judge runs keep their own prompt and never take a compacted history. */
  kind?: string;
}

/**
 * Tools that cannot continue a previous CLI session. A follow-up on
 * these starts cold, so it needs the stage prompt and any compacted
 * history rather than the user's latest line alone.
 */
export function forgetsBetweenRuns(cli: string): boolean {
  return cli === "pool" || cli === "dsh";
}

/**
 * Tools that print one final message after the process exits, and
 * nothing before it. A live pane that shows "Waiting for output..."
 * for these looks stalled for the length of the run.
 */
export function hasNoLiveTranscript(cli: string): boolean {
  return cli === "dsh";
}

/**
 * Whether a live stdin session should stay open after a finished turn,
 * waiting for the user to keep talking.
 *
 * Only a successful turn on a manual stage: automatic stages must
 * finish so their gate can run, a failed turn has nothing left to wait
 * for, and a judge is not a conversation. idleSec 0 disables the hold.
 */
export function shouldHoldLiveSession(input: {
  ok: boolean;
  kind: string;
  gateType: string;
  idleSec: number;
}): boolean {
  return input.ok && input.kind !== "judge" && input.gateType === "manual" && input.idleSec > 0;
}

/**
 * The prompt an agent process actually receives.
 *
 * A fresh stage run (no follow-up) is the stage prompt. A resumed
 * session is the follow-up alone. Everything else (a tool that forgets
 * between runs, a lost session, a first message with no session id)
 * gets the stage prompt, then a compacted history when one exists,
 * then the user's latest message.
 */
export function agentRunPrompt(input: AgentRunPromptInput): string {
  const followUp = input.followUp?.trim() ? input.followUp : null;
  if (!followUp) return input.stagePrompt;
  if (input.kind === "judge") return followUp;
  if (input.resume && !forgetsBetweenRuns(input.cli)) return followUp;

  const parts = [input.stagePrompt];
  const compacted = input.compacted?.trim();
  if (compacted) {
    parts.push("", "Previous conversation on this card, compacted:", compacted);
  }
  parts.push("", "User follow-up:", followUp);
  return parts.join("\n");
}

/** Soft cap so a long card cannot blow the next run's context window. */
export const COMPACT_TRANSCRIPT_BUDGET = 12_000;

/**
 * Packs prior turns into a short transcript for a cold follow-up.
 *
 * Newest turns are kept first. When the budget is exceeded, the oldest
 * are dropped, and a single oversize turn is trimmed from the front so
 * the latest words (the ones the next agent needs) survive. Empty when
 * there is nothing to carry.
 */
export function compactTranscript(
  turns: ConversationTurn[],
  budget: number = COMPACT_TRANSCRIPT_BUDGET,
): string {
  const lines: string[] = [];
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;
    const label = turn.role === "user" ? "you" : "agent";
    lines.push(`${label}: ${collapseSpace(text)}`);
  }
  if (lines.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost <= budget) {
      kept.unshift(line);
      used += cost;
      continue;
    }
    const remaining = budget - used - (kept.length > 0 ? 1 : 0);
    if (remaining > 24) {
      // Trim the oldest surviving line from the front: the tail is the
      // latest words, which is what the next prompt needs.
      kept.unshift(`${line.slice(0, Math.max(0, remaining - 3))}...`);
    }
    break;
  }
  return kept.join("\n");
}

function collapseSpace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}
