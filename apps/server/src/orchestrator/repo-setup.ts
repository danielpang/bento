import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sandboxes } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";

/**
 * A repository's own toolchain, installed inside the sandbox.
 *
 * Sandboxes carry git and the agent CLIs and nothing else. Which
 * language, which version, which package manager: those belong to the
 * repository, and the people who work in it are the only ones who know
 * them, so they write a setup command and it runs here.
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

/**
 * Runs each repository's setup command. Returns null when everything
 * needed has run, or the message the run should fail with.
 *
 * Failing the run is deliberate. An agent whose project cannot build is
 * not "mostly fine": it will spend the stage confused by errors that
 * have nothing to do with the task, and its work cannot be checked. The
 * transcript carries the command's own output, because that is what
 * says why.
 */
export async function runRepositorySetup(
  ctx: AppContext,
  args: {
    handle: SandboxHandle;
    repositories: SetupRepository[];
    signal?: AbortSignal | undefined;
    say: (text: string) => Promise<void>;
  },
): Promise<string | null> {
  const fingerprint = setupFingerprint(args.repositories);
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

  for (const repo of args.repositories) {
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
      return `The setup command for ${repo.name} could not run: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (result.exitCode !== 0) {
      const output = tail(`${result.stdout}\n${result.stderr}`);
      await args.say(`Setup for ${repo.name} failed:\n${output}`);
      return `The setup command for ${repo.name} exited ${result.exitCode}, so the agent has no toolchain to work with. Fix the command under Repositories, then run again.`;
    }
    await args.say(`Setup for ${repo.name} finished in ${Math.round((Date.now() - started) / 1000)}s.`);
  }

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
