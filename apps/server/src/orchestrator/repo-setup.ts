import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolveRepositoryCommands } from "@bento/core";
import { sandboxes } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";

/**
 * A repository's own toolchain, installed inside the sandbox.
 *
 * Sandboxes carry git and the agent CLIs and nothing else. Which
 * language, which version, which package manager: those belong to the
 * repository. Users can provide an explicit dependency setup command;
 * otherwise the agent inspects the repository and manages its environment.
 *
 * Once per sandbox, not once per run. A sandbox outlives the run that
 * created it, so a card pays for its install on the first stage and
 * every stage after that starts warm. The fingerprint is what makes
 * that safe: edit the command and the next run installs again.
 */

export interface SetupRepository {
  name: string;
  setupCommand: string | null;
  /** Where to run it: the repository's own directory in the sandbox. */
  cwd: string;
}

/** Generous: a cold install of a language toolchain is minutes, not seconds. */
const SETUP_TIMEOUT_MS = 20 * 60_000;

/** How much of a failing command's output reaches the transcript. */
const OUTPUT_TAIL = 2000;

/**
 * Identifies the set of commands, so an unchanged set is skipped and a
 * changed one is not. Names are part of it: moving a command from one
 * repository to another is a different set, even with the same text.
 */
export function setupFingerprint(repositories: SetupRepository[]): string | null {
  const commands = repositories
    .filter((repo) => repo.setupCommand?.trim())
    .map((repo) => [repo.name, repo.setupCommand!.trim()]);
  if (commands.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex").slice(0, 32);
}

/** Run optional dependency setup. Return diagnostics for the agent to repair on failure. */
export async function runRepositorySetup(
  ctx: AppContext,
  args: {
    handle: SandboxHandle;
    repositories: SetupRepository[];
    signal?: AbortSignal | undefined;
    say: (text: string) => Promise<void>;
  },
): Promise<string | null> {
  const repositories = args.repositories.map((repo) => {
    const commands = resolveRepositoryCommands(repo);
    return { ...repo, setupCommand: commands.setupCommand };
  });
  for (const repo of args.repositories) {
    if (resolveRepositoryCommands(repo).deferredSetup)
      await args.say(
        `The build or test command for ${repo.name} will run as an agent check after edits, not before the agent starts: ${repo.setupCommand}`,
      );
  }
  const fingerprint = setupFingerprint(repositories);
  if (!fingerprint) return null;

  /**
   * Keyed on the sandbox's own id rather than a row id: a feature can
   * accumulate several sandbox rows naming the same machine, and what
   * matters is what that machine has installed, not which row recorded
   * it.
   */
  const known = await ctx.db
    .select({ setupFingerprint: sandboxes.setupFingerprint })
    .from(sandboxes)
    .where(and(eq(sandboxes.externalId, args.handle.externalId), eq(sandboxes.setupFingerprint, fingerprint)))
    .limit(1);
  if (known.length > 0) return null;

  const failures: string[] = [];
  for (const repo of repositories) {
    const command = repo.setupCommand?.trim();
    if (!command) continue;
    await args.say(`Setting up ${repo.name}: ${command}`);
    const started = Date.now();

    let result;
    try {
      result = await collectExec(
        ctx.driver.exec(args.handle, ["sh", "-lc", command], {
          cwd: repo.cwd,
          timeoutMs: SETUP_TIMEOUT_MS,
          ...(args.signal ? { signal: args.signal } : {}),
        }),
      );
    } catch (err) {
      if (args.signal?.aborted) throw err;
      failures.push(
        `The setup command for ${repo.name} (${command}) could not run: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (result.exitCode !== 0) {
      const output = tail(`${result.stdout}\n${result.stderr}`);
      await args.say(`Setup for ${repo.name} failed:\n${output}`);
      failures.push(`The setup command for ${repo.name} (${command}) exited ${result.exitCode}.\n${output}`);
      continue;
    }
    await args.say(`Setup for ${repo.name} finished in ${Math.round((Date.now() - started) / 1000)}s.`);
  }

  if (failures.length) return failures.join("\n\n");

  // Recorded only after every command succeeded: a half-installed
  // sandbox must try again rather than be treated as ready.
  await ctx.db
    .update(sandboxes)
    .set({ setupFingerprint: fingerprint })
    .where(eq(sandboxes.externalId, args.handle.externalId));
  return null;
}

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > OUTPUT_TAIL ? `...${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}
