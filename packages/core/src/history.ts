/**
 * Who to name on a history line.
 *
 * A stored name is used when it actually identifies someone: non-empty
 * and not just their email repeated. Otherwise the email, which every
 * account has. Callers that have neither fall back to "a person".
 */
export function actorDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const named = name?.trim() ?? "";
  const mailed = email?.trim() ?? "";
  if (named && named !== mailed) return named;
  if (mailed) return mailed;
  return null;
}

/**
 * Who or what moved the card, in words rather than trigger tokens.
 *
 * Manual moves name the person when history carried one; the generic
 * fallback is for rows written before actors were stored, or for a
 * user row that has since gone.
 */
export function historyTriggerLabel(trigger: string, actor: string | null): string {
  switch (trigger) {
    case "manual":
      return actor ? `by ${actor}` : "by a person";
    case "manual_back":
      return actor ? `sent back by ${actor}` : "sent back";
    case "gate_auto":
      return "by a gate";
    case "gate_auto_back":
      return "returned by a gate";
    case "agent_run":
      return "by an agent";
    case "linear_auto":
      return "on arrival from Linear";
    case "system":
      return "automatic";
    default:
      return trigger;
  }
}

/**
 * Shown in card details after a person sends a card back. The
 * destination agent does not start on its own: the next message is
 * how they say what to redo.
 */
export const SEND_BACK_NOTICE = "Card moved back, please tell the agent what to do next";

/**
 * True when the card is sitting on a stage a person just sent it back
 * to, and nobody has started the next conversation there yet.
 *
 * A gate sending a card back starts the previous agent itself, so that
 * is not this prompt. A work run on the destination after the move
 * means they have already said what to do.
 */
export function needsSendBackPrompt(input: {
  status: string;
  currentStageId: string | null;
  history: { kind: string; trigger: string; at: string | Date }[];
  runs: { kind?: string | null; stageId: string; queuedAt: string | Date }[];
}): boolean {
  if (input.status === "done" || input.status === "cancelled") return false;

  let latest: { trigger: string; at: number } | null = null;
  for (const event of input.history) {
    if (event.kind !== "stage_moved") continue;
    const at = Date.parse(typeof event.at === "string" ? event.at : event.at.toISOString());
    if (Number.isNaN(at)) continue;
    if (!latest || at >= latest.at) latest = { trigger: event.trigger, at };
  }
  if (!latest || latest.trigger !== "manual_back") return false;
  const movedAt = latest.at;

  return !input.runs.some((run) => {
    if (run.kind === "judge") return false;
    if (input.currentStageId && run.stageId !== input.currentStageId) return false;
    const queued = Date.parse(typeof run.queuedAt === "string" ? run.queuedAt : run.queuedAt.toISOString());
    return !Number.isNaN(queued) && queued >= movedAt;
  });
}
