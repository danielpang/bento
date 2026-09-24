/**
 * Turns the sandbox image build into messages a person can follow. The
 * first build downloads a base system and every agent CLI, which is
 * several minutes of one unchanging line unless the launcher says which
 * part it is on and that time is passing.
 */

/** What a Dockerfile step does, in the launcher's words. */
export function describeStep(instruction: string): string {
  if (/^FROM\b/i.test(instruction)) return "Downloading the base system";
  if (/apt-get/.test(instruction)) return "Installing git and search tools";
  if (/fetch_run|install\.sh/.test(instruction)) return "Installing the agent tools (Claude Code, Codex, and others)";
  if (/nodejs\.org|npm install/.test(instruction)) return "Installing the Node based agent tools";
  return "Configuring the sandbox";
}

/**
 * Reads one event from Docker's build stream. The classic builder reports
 * each step as "Step 3/9 : RUN ..."; anything else is output from inside
 * the step and returns null.
 */
export function parseBuildStep(event: { stream?: string }): { step: number; total: number; label: string } | null {
  const match = /^Step (\d+)\/(\d+) : (.*)/.exec(event.stream ?? "");
  if (!match) return null;
  return { step: Number(match[1]), total: Number(match[2]), label: describeStep(match[3]!) };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function sandboxProgressMessage(current: { step: number; total: number; label: string } | null, elapsedMs: number): string {
  const doing = current ? `${current.label} (step ${current.step} of ${current.total})` : "Preparing the agent sandbox";
  return `${doing}. First launch only, this can take several minutes. ${formatElapsed(elapsedMs)} so far.`;
}
