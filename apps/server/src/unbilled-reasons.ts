/**
 * Reasons a failed run is marked not billable.
 *
 * Matches inspect only the first error line. Later lines are command
 * output and must not decide billing. These reasons are restricted to
 * provider failures before an agent starts. Once an agent or its
 * sandbox has done work, failures remain billable.
 */
export type UnbilledMatch =
  | { kind: "prefix"; text: string }
  | { kind: "includes"; text: string }
  | { kind: "pattern"; text: string };

export type UnbilledReason = {
  id: string;
  summary: string;
  match: UnbilledMatch;
  except?: readonly UnbilledMatch[];
};

/**
 * How a run record opens when the sandbox never ran the agent: the
 * connection that starts the CLI was refused and stayed refused (or
 * the command could not be staged), or the machine was gone. The
 * executor writes the sentence and the rules below read it, so they
 * share the opening words. Two sentences because the advice differs:
 * a refused start is worth another try on the same machine, a missing
 * machine needs a new one.
 */
export const SANDBOX_REFUSED_AGENT_PREFIX = "The sandbox did not accept the command that starts the agent";
export const SANDBOX_GONE_AGENT_PREFIX = "The sandbox for this run no longer exists";
/**
 * How a run record opens when its sandbox stopped answering before the
 * agent was launched, and reapStalledRuns closed it. Written by the
 * reaper and read by the rule below, like the two above.
 */
export const SANDBOX_STALLED_AGENT_PREFIX = "The sandbox stopped responding before the agent started";
/**
 * How a run record opens when an agent from an earlier run of the same
 * task was still running in the task's machine and could not be
 * stopped, so this run's agent was never started beside it.
 */
/**
 * How a run record opens when a restart of this server ended it before
 * its agent was exec'd. Nothing ran in the machine, and the restart was
 * Bento's own, so it is neither billed nor the work's failure: the
 * coordinator starts a swarm's run again the way it does any run whose
 * sandbox failed first.
 */
export const RESTART_BEFORE_AGENT_PREFIX = "Bento restarted before the agent started";
export const PREVIOUS_AGENT_RUNNING_PREFIX =
  "An agent from an earlier run of this task is still running in its sandbox and could not be stopped";

export const UNBILLED_REASONS: readonly UnbilledReason[] = [
  {
    id: "sandbox-unavailable",
    summary: "No sandbox provider could make the machine before the agent started.",
    match: { kind: "prefix", text: "sandbox provisioning failed: Sandbox failed to provision" },
  },
  {
    id: "sprite-driver-error",
    summary: "Fly or the Sprite driver failed while the machine was being created, before the agent started.",
    match: { kind: "pattern", text: "^sandbox provisioning failed: [A-Za-z][A-Za-z0-9]*Error(?:[^A-Za-z0-9_]|$)" },
  },
  {
    id: "sprite-not-acquired",
    summary: "Fly's control plane never handed the Sprite back.",
    match: {
      kind: "pattern",
      text: "^sandbox provisioning failed: (?:could not acquire sprite \\S+|sprite \\S+ was not created)(?:[^A-Za-z0-9_]|$)",
    },
  },
  {
    id: "sprite-exec-handshake",
    summary: "The Sprite exec connection failed before the provision command started.",
    match: {
      kind: "prefix",
      text: "sandbox provisioning failed: the sandbox exec connection failed before the command started",
    },
  },
  {
    id: "sandbox-exec-refused",
    summary: "The sandbox never accepted the command that starts the agent, so no agent ran.",
    match: { kind: "prefix", text: SANDBOX_REFUSED_AGENT_PREFIX },
  },
  {
    id: "sandbox-gone",
    summary: "The sandbox was gone when the agent was to start, so no agent ran.",
    match: { kind: "prefix", text: SANDBOX_GONE_AGENT_PREFIX },
  },
  {
    id: "sandbox-stalled",
    summary: "The sandbox stopped answering before the agent was launched, so no agent ran.",
    match: { kind: "prefix", text: SANDBOX_STALLED_AGENT_PREFIX },
  },
  {
    id: "restart-before-agent",
    summary: "A restart of the server ended the run before its agent was launched, so no agent ran.",
    match: { kind: "prefix", text: RESTART_BEFORE_AGENT_PREFIX },
  },
  {
    id: "previous-agent-running",
    summary: "An earlier run's agent was still in the task's sandbox and could not be stopped, so no second agent ran.",
    match: { kind: "prefix", text: PREVIOUS_AGENT_RUNNING_PREFIX },
  },
];

type CompiledReason = {
  reason: UnbilledReason;
  test: (line: string) => boolean;
  except: ((line: string) => boolean)[];
};

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
