/**
 * Reasons a failed run is marked not billable.
 *
 * Add a row to extend the list. `finishRun` asks `unbilledReason` when
 * it closes the run and stores the answer on `agent_runs.billable`.
 * The hours sum and the billing hook read that column. They do not
 * read the error text again. The first row whose `match` hits is the
 * one that fires. `except` puts a lookalike back on the clock. Order
 * matters only when two rows could match the same line: put the
 * narrower one first.
 *
 * Every match sees only the first line of the stored error. The lines
 * after it are command output, and a phrase in that output must not
 * decide the bill.
 *
 * `prefix` matches the start of that line. `includes` matches anywhere
 * in it. `pattern` is a regular expression. An empty match or an
 * invalid pattern is rejected when the list is compiled, so a bad row
 * fails the process at startup instead of throwing while a run is
 * being closed.
 *
 * A new row applies to runs that finish after it ships. A run that
 * already closed keeps the flag it was given. Changing one of those
 * takes a migration.
 *
 * These rows are only for failures from before the agent starts. A
 * throw once the agent is running (`exec failed:`), a missing binary
 * reported when the process ends, a timeout, and a restart all stay
 * on the clock: the sandbox was awake for that time.
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
    id: "sprite-driver-error",
    summary:
      "Fly or the sprite driver threw its own error class while the machine was being created. The agent never started. A plain sentence (a git failure, two repositories on one checkout, a lockdown this deployment cannot honor) does not match.",
    match: { kind: "pattern", text: "^sandbox provisioning failed: [A-Za-z][A-Za-z0-9]*Error(?:[^A-Za-z0-9_]|$)" },
  },
  {
    id: "sprite-not-acquired",
    summary: "Fly's control plane never handed the sprite back.",
    match: {
      kind: "pattern",
      text: "^sandbox provisioning failed: (?:could not acquire sprite \\S+|sprite \\S+ was not created)(?:[^A-Za-z0-9_]|$)",
    },
  },
  {
    id: "sprite-exec-handshake",
    summary: "The sprite exec connection failed before the provision command started.",
    match: {
      kind: "prefix",
      text: "sandbox provisioning failed: the sandbox exec connection failed before the command started",
    },
  },
];

type CompiledReason = {
  reason: UnbilledReason;
  test: (line: string) => boolean;
  except: ((line: string) => boolean)[];
};

/** The first line. Later lines are command output and are not the reason. */
export function unbilledOpeningLine(error: string): string {
  const breakAt = error.indexOf("\n");
  return breakAt === -1 ? error : error.slice(0, breakAt);
}

function compileMatch(match: UnbilledMatch, id: string): (line: string) => boolean {
  if (match.text === "") throw new Error(`unbilled reason ${id} has an empty ${match.kind}`);
  if (match.kind === "prefix") return (line) => line.startsWith(match.text);
  if (match.kind === "includes") return (line) => line.includes(match.text);
  let re: RegExp;
  try {
    re = new RegExp(match.text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`unbilled reason ${id} has an invalid pattern (${detail})`);
  }
  return (line) => {
    re.lastIndex = 0;
    return re.test(line);
  };
}

function compileReason(reason: UnbilledReason): CompiledReason {
  return {
    reason,
    test: compileMatch(reason.match, reason.id),
    except: (reason.except ?? []).map((skip) => compileMatch(skip, reason.id)),
  };
}

const COMPILED_REASONS: readonly CompiledReason[] = UNBILLED_REASONS.map(compileReason);

/**
 * The reason this failure is off the quota, or null when the run still
 * counts. Null for a missing error: a run that failed without saying
 * why is still time the sandbox spent.
 *
 * `reasons` defaults to the shipped list. Tests pass another list to
 * show that a new row is enough. A bad row throws here, before any
 * error text is classified.
 */
export function unbilledReason(
  error: string | null | undefined,
  reasons: readonly UnbilledReason[] = UNBILLED_REASONS,
): UnbilledReason | null {
  if (!error) return null;
  const line = unbilledOpeningLine(error);
  const compiled = reasons === UNBILLED_REASONS ? COMPILED_REASONS : reasons.map(compileReason);
  for (const row of compiled) {
    if (!row.test(line)) continue;
    if (row.except.some((skip) => skip(line))) continue;
    return row.reason;
  }
  return null;
}
