import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";

/**
 * The swarm's own machine, and the branch everything lands on.
 *
 * A swarm has one branch and the server owns it. The planner runs on
 * the swarm's machine, and so does the merge queue, which is the reason
 * the two are one thing: landing a worker's branch onto the swarm's
 * branch is a git operation in a checkout, and the coordinator has to
 * be the one holding it. Workers get their own machine and their own
 * branch off the swarm's, because several agents committing to one
 * branch is the condition the queue exists to remove.
 *
 * Provisioning itself is provisionWorkspace, which both boards go
 * through; what lives here is only what a swarm's workspace is called.
 * Both names are written onto the rows the first time a run gets them
 * (see recordSwarmWorkspace), so stopping a swarm, landing onto it, or
 * reaping its machines never has to rebuild a name from a slug the team
 * may have renamed since.
 *
 * Nothing is provisioned when a swarm is created. A swarm somebody made
 * and did not start should cost nothing, so the machine appears on the
 * first planner run and every later run finds it again: the drivers
 * name it from the workspace key and reuse it, and the sandboxes row is
 * an upsert on that name.
 */

/**
 * The name this swarm's workspace and machine are known by.
 *
 * Prefixed rather than bare, because a card's workspace key is its
 * feature id and both boards name machines out of the same namespace.
 * Two uuids could not collide in practice; a prefix means nobody has to
 * know that to read a container list.
 */
export function swarmWorkspaceKey(swarmId: string): string {
  return `swarm-${swarmId}`;
}

/**
 * The name one leaf's workspace and machine are known by.
 *
 * Built from the swarm's key and the task, so the swarm's machines are
 * one prefix in a container list and a leaf's machine can be found
 * again without reading a row. Eight characters of the task id, the
 * way its branch takes eight: the swarm's own id is already in the
 * name, so two leaves would have to share a prefix within one swarm.
 *
 * Derived here rather than written inline wherever it is needed,
 * because the reaper has to name exactly the workspace the executor
 * made, and two spellings of one rule is how a machine gets left
 * behind billing.
 */
export function swarmTaskWorkspaceKey(swarmId: string, taskId: string): string {
  return `${swarmWorkspaceKey(swarmId)}-${taskId.slice(0, 8)}`;
}

/**
 * The branch a swarm lands on, from its slug.
 *
 * The slug is unique per project and stable, so the branch name is
 * legible in a repository ("swarm/checkout-rewrite") rather than a
 * uuid, and a person looking at the remote can tell which swarm made
 * it.
 */
export function swarmBranchName(slug: string): string {
  return `swarm/${slug}`;
}

/**
 * Where a swarm's agents work, as its template records it.
 *
 * "worktree" is a git worktree of the project's checkout on this
 * server: cheap, and what a local install wants, because a container
 * per worker is a container on the machine somebody is also using.
 * "sandbox" is a machine per agent holding its own clone.
 */
export type WorkerIsolation = "sandbox" | "worktree";

/**
 * Why this deployment cannot run a swarm shaped the way its template
 * says, or null when it can.
 *
 * Only one direction can fail, and the asymmetry is the point.
 * "worktree" is a promise about where the code is, and a driver whose
 * sandboxes clone the repository inside themselves cannot keep it: the
 * worktrees this template's swarms are built around would not exist,
 * and the merge queue, which moves branches in checkouts on this
 * server, would have nothing to move. "sandbox" promises nothing, so
 * every driver satisfies it, including the ones that give an agent a
 * worktree because that is all they have.
 *
 * Refused rather than quietly provisioned the other way, for the
 * reason a restricted network is refused rather than quietly given
 * open egress: a shape that changes under a swarm is a setting that
 * was a decoration.
 */
export function isolationRefusal(isolation: WorkerIsolation, provider: string): string | null {
  if (isolation !== "worktree") return null;
  if (provider !== "sprite") return null;
  return (
    "This swarm's template runs its agents in worktrees of the repository on the server, and this deployment runs agents on machines that hold their own clones. " +
    "Set the template's isolation to a sandbox per agent, or run this swarm on a deployment that keeps the checkouts."
  );
}

/**
 * The swarm's branch, taken out of the machine that holds it, so a
 * worker's machine can start from it.
 *
 * Only for a driver whose sandboxes keep their own clones. Everywhere
 * else the swarm's branch is a ref in the repository on this server
 * and the worker's worktree is cut from it directly, which is what
 * `startFromBranch` already does.
 *
 * On such a driver the swarm's branch exists in exactly one place: the
 * planner's machine, where the merge queue has been landing onto it.
 * Nothing has pushed it anywhere, because a swarm pushes once, at the
 * end. So a worker provisioned from the remote alone would be cut from
 * the repository's default branch and would have none of what the
 * leaves before it landed: its agent writes against code the swarm has
 * moved past, and its branch conflicts with every landed leaf at the
 * queue.
 *
 * One bundle per repository, incremental against the base branch, so
 * what travels is the swarm's own commits rather than the repository.
 * A repository the swarm has not committed in answers null and gets
 * nothing, which is correct: its default branch and the swarm's branch
 * are the same commit.
 *
 * A failure here is not swallowed. Starting the worker anyway would
 * start it from the default branch, which is precisely the bug this
 * exists to close, and silently: nothing downstream can tell a worker
 * that began at the swarm's head from one that did not.
 */
export async function exportSwarmBranch(
  driver: Pick<SandboxDriver, "exportRepository">,
  handle: SandboxHandle,
  repos: { name: string; defaultBranch: string }[],
  branch: string,
): Promise<Map<string, { branch: string; data: Buffer }>> {
  const bundles = new Map<string, { branch: string; data: Buffer }>();
  if (!driver.exportRepository) return bundles;
  for (const repo of repos) {
    let exported;
    try {
      exported = await driver.exportRepository(handle, repo.name, repo.defaultBranch);
    } catch (err) {
      throw new Error(
        `could not read ${branch} out of this swarm's sandbox for ${repo.name}, so a worker would have started from ${repo.defaultBranch} instead of from the swarm's branch`,
        { cause: err },
      );
    }
    // Nothing beyond the base branch: the two are the same commit, and
    // the ordinary seed already puts the worker there.
    if (!exported) continue;
    bundles.set(repo.name, { branch, data: exported.data });
  }
  return bundles;
}
