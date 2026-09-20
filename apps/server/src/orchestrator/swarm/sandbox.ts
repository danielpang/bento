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
