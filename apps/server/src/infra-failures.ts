/**
 * Failures of the machinery rather than the work, recognised from the
 * sentence a run record opens with: a machine that never ran the agent,
 * one that stopped under it, or a restart of this server before it ran.
 * The swarm coordinator reads this to decide whether a run deserves
 * another try without the planner hearing about it, and node messages
 * read it to decide whether a run ever heard what it was handed.
 *
 * Billing does not read this list. Whether a run is billed is decided
 * where its failure is caught, from what threw (run-fault.ts), so a new
 * row here changes what is restarted, never what is charged.
 *
 * Matches inspect only the first error line. Later lines are command
 * output and must not decide anything.
 */
export type InfraFailureMatch =
  | { kind: "prefix"; text: string }
  | { kind: "includes"; text: string }
  | { kind: "pattern"; text: string };

export type InfraFailureReason = {
  id: string;
  summary: string;
  match: InfraFailureMatch;
  except?: readonly InfraFailureMatch[];
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
/**
 * How a run record opens when the machine stopped while the agent was
 * working (a Docker VM that restarted, a sprite or box that went away).
 * The provider failed, not the agent, so it is not billed, and a swarm
 * starts the run again the way it does after any sandbox failure.
 */
export const SANDBOX_STOPPED_AGENT_PREFIX = "The sandbox stopped while the agent was running";
export const PREVIOUS_AGENT_RUNNING_PREFIX =
  "An agent from an earlier run of this task is still running in its sandbox and could not be stopped";

/**
 * How a run record reads when the swarm's machine was lost with tasks
 * already landed on its branch, and GitHub has no copy to make it
 * again from. The run is refused before any machine is made, because a
 * fresh clone would be a branch without that work, and nothing after
 * it could tell.
 */
export const SWARM_BRANCH_LOST_MESSAGE =
  "The swarm's branch was lost with its sandbox and is not on GitHub, so its landed tasks cannot be restored. Start the swarm again.";

export const INFRA_FAILURE_REASONS: readonly InfraFailureReason[] = [
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
    id: "sandbox-stopped",
    summary: "The sandbox stopped while the agent was running, so the run ended with the machine.",
    match: { kind: "prefix", text: SANDBOX_STOPPED_AGENT_PREFIX },
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
  {
    id: "swarm-branch-lost",
    summary: "The swarm's branch was lost with its sandbox and could not be restored, so no agent ran.",
    match: { kind: "prefix", text: SWARM_BRANCH_LOST_MESSAGE },
  },
];

type CompiledReason = {
  reason: InfraFailureReason;
  test: (line: string) => boolean;
  except: ((line: string) => boolean)[];
};

export function infraFailureOpeningLine(error: string): string {
  const breakAt = error.indexOf("\n");
  return breakAt === -1 ? error : error.slice(0, breakAt);
}

function compileMatch(match: InfraFailureMatch, id: string): (line: string) => boolean {
  if (match.text === "") throw new Error(`infra failure ${id} has an empty ${match.kind}`);
  if (match.kind === "prefix") return (line) => line.startsWith(match.text);
  if (match.kind === "includes") return (line) => line.includes(match.text);
  let re: RegExp;
  try {
    re = new RegExp(match.text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`infra failure ${id} has an invalid pattern (${detail})`);
  }
  return (line) => {
    re.lastIndex = 0;
    return re.test(line);
  };
}

function compileReason(reason: InfraFailureReason): CompiledReason {
  return {
    reason,
    test: compileMatch(reason.match, reason.id),
    except: (reason.except ?? []).map((skip) => compileMatch(skip, reason.id)),
  };
}

const COMPILED_REASONS: readonly CompiledReason[] = INFRA_FAILURE_REASONS.map(compileReason);

export function infraFailureReason(
  error: string | null | undefined,
  reasons: readonly InfraFailureReason[] = INFRA_FAILURE_REASONS,
): InfraFailureReason | null {
  if (!error) return null;
  const line = infraFailureOpeningLine(error);
  const compiled = reasons === INFRA_FAILURE_REASONS ? COMPILED_REASONS : reasons.map(compileReason);
  for (const row of compiled) {
    if (!row.test(line)) continue;
    if (row.except.some((skip) => skip(line))) continue;
    return row.reason;
  }
  return null;
}
