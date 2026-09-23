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

export const UNBILLED_REASONS: readonly UnbilledReason[] = [
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
