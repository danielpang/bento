import { writeFileCommand } from "@bento/agents";
import { collectExec, repositoryPathIn, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";

/** The shared design document promised by the swarm PRD. */
export const SWARM_DESIGN_PATH = "docs/bento/swarm/design.md";

interface CommitDesignInput {
  driver: SandboxDriver;
  handle: SandboxHandle;
  repositoryName: string;
  branch: string;
  content: string;
}

/** Run one trusted command and keep provider errors out of successful tool replies. */
async function checked(
  driver: SandboxDriver,
  handle: SandboxHandle,
  argv: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await collectExec(driver.exec(handle, argv, { cwd, timeoutMs: 60_000 }));
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${argv[0]} exited ${result.exitCode}`);
  }
  return result;
}

/**
 * Writes and commits the planner's design without giving the planner a
 * filesystem tool.
 *
 * The content is passed through the existing literal file writer, and
 * every git argument below is server-owned. `commit --only` matters: a
 * planner shares this checkout with the swarm, so an unrelated staged
 * file must never hitch a ride on the design commit.
 */
export async function commitSwarmDesignDocument(input: CommitDesignInput): Promise<void> {
  const cwd = repositoryPathIn(input.handle.workdir, input.repositoryName);
  const current = await checked(input.driver, input.handle, ["git", "symbolic-ref", "--short", "HEAD"], cwd);
  if (current.stdout.trim() !== input.branch) {
    throw new Error(`the swarm checkout is on ${current.stdout.trim() || "no branch"}, not ${input.branch}`);
  }

  const absolutePath = `${cwd}/${SWARM_DESIGN_PATH}`;
  await checked(
    input.driver,
    input.handle,
    writeFileCommand({ path: absolutePath, content: input.content }),
    cwd,
  );
  await checked(input.driver, input.handle, ["git", "add", "--", SWARM_DESIGN_PATH], cwd);

  const changed = await collectExec(
    input.driver.exec(input.handle, ["git", "diff", "--cached", "--quiet", "--", SWARM_DESIGN_PATH], {
      cwd,
      timeoutMs: 60_000,
    }),
  );
  if (changed.exitCode === 0) return;
  if (changed.exitCode !== 1) {
    throw new Error(changed.stderr.trim() || changed.stdout.trim() || `git diff exited ${changed.exitCode}`);
  }

  await checked(
    input.driver,
    input.handle,
    [
      "git",
      "-c",
      "user.name=Bento",
      "-c",
      "user.email=no-reply@usebento.ai",
      "commit",
      "--only",
      "-m",
      "Update swarm design",
      "--",
      SWARM_DESIGN_PATH,
    ],
    cwd,
  );
}
