/**
 * Reasons a failed run does not count as agent hours.
 *
 * Add a row to extend the list. Nothing else has to change: the hours
 * sum and the billing hook both ask `unbilledReason`. The first row
 * whose `match` hits is the one that fires. `except` puts a lookalike
 * back on the clock (the caller misconfigured the project, the sprite
 * never failed). Order matters only when two rows could match the same
 * error: put the narrower one first.
 *
 * `prefix` matches the start of the stored error. `includes` matches
 * anywhere in it. `pattern` is a regular expression in the stored
 * error's own text.
 *
 * A new row applies to the hours breakdown immediately, including runs
 * that already finished, and to runs that finish after it ships. It
 * does not need a migration.
 */
export type UnbilledMatch =
  | { kind: "prefix"; text: string }
  | { kind: "includes"; text: string }
  | { kind: "pattern"; text: string };

export type UnbilledReason = {
  /** Stable name. Tests and logs use it, so renaming is a break. */
  id: string;
  /** When to reach for this row, for the person adding the next one. */
  summary: string;
  match: UnbilledMatch;
  except?: readonly UnbilledMatch[];
};

export const UNBILLED_REASONS: readonly UnbilledReason[] = [
  {
    id: "sprite-provision",
    summary: "Fly or Bento failed while creating the sprite. The agent never started.",
    match: { kind: "prefix", text: "sandbox provisioning failed:" },
    except: [
      { kind: "includes", text: "use the same checkout" },
      { kind: "includes", text: "requires agents to run without network access" },
    ],
  },
  {
    id: "exec-failed",
    summary: "The exec loop threw before the agent reported a result.",
    match: { kind: "prefix", text: "exec failed:" },
  },
  {
    id: "cli-not-installed",
    summary: "The sandbox never installed this agent's CLI, so the agent never started.",
    match: { kind: "includes", text: "is not installed in this sandbox, so the agent never started" },
  },
];

function matches(error: string, match: UnbilledMatch): boolean {
  if (match.kind === "prefix") return error.startsWith(match.text);
  if (match.kind === "includes") return error.includes(match.text);
  return new RegExp(match.text).test(error);
}

/**
 * The reason this failure is off the quota, or null when the run still
 * counts. Null for a missing error: a run that failed without saying
 * why is still time the sandbox spent.
 *
 * `reasons` defaults to the shipped list. Tests pass another list to
 * show that a new row is enough.
 */
export function unbilledReason(
  error: string | null | undefined,
  reasons: readonly UnbilledReason[] = UNBILLED_REASONS,
): UnbilledReason | null {
  if (!error) return null;
  for (const reason of reasons) {
    if (!matches(error, reason.match)) continue;
    if (reason.except?.some((skip) => matches(error, skip))) continue;
    return reason;
  }
  return null;
}
