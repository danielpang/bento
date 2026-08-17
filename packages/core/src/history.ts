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
    case "system":
      return "automatic";
    default:
      return trigger;
  }
}
