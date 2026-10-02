/**
 * What a worker's branch is called, and how its commits are recognized
 * afterwards.
 *
 * A swarm has one branch and several agents. The branch names here are
 * what keeps them apart before the merge queue puts them together, and
 * the commit trailer is what keeps them apart afterwards: once a
 * worker's commits are on the swarm's branch, nothing about the commit
 * says which leaf made it, because the branch it came from is gone.
 * The trailer is that answer, written by the worker and preserved by
 * both landing policies, and it is what lets the console draw the
 * commits of one node without keeping a list of shas in a column that
 * a rebase would invalidate.
 */

import type { swarmTasks } from "@bento/db";

type Task = typeof swarmTasks.$inferSelect;

/**
 * How much of a task id names its branch.
 *
 * Eight hex characters, the way a card's branch takes eight of its
 * feature id. Collisions inside one swarm would need two ids sharing a
 * prefix, and a swarm is tens of tasks rather than millions; the full
 * id is on the trailer, which is what anything actually matches on.
 */
const BRANCH_ID_CHARS = 8;

/**
 * The branch one leaf's worker commits on.
 *
 * Beside the swarm's branch, joined by a hyphen, and not underneath it.
 * `swarm/<slug>/<task>` is the name that reads best and it cannot
 * exist: a loose ref is a file on disk, so once `refs/heads/swarm/demo`
 * is a file, git refuses to create `refs/heads/swarm/demo/a1b2c3d4`
 * because it would need that same path to be a directory. The error is
 * "cannot lock ref: refs/heads/swarm/demo exists", and it arrives when
 * the first worker of the first swarm tries to start, in every
 * repository, so nothing that does not create a real branch can find
 * it.
 *
 * A hyphen still groups them: `git branch --list 'swarm/demo*'` is the
 * swarm and all its workers, and deleting them afterwards is one glob.
 */
export function workerBranchName(swarmBranch: string, taskId: string): string {
  return `${swarmBranch}-${taskId.slice(0, BRANCH_ID_CHARS)}`;
}

/** The trailer key. RFC 822 shaped, which is what git's own trailers are. */
export const TASK_TRAILER = "Bento-Task";

/** The line a worker is told to end every commit message with. */
export function taskTrailer(taskId: string): string {
  return `${TASK_TRAILER}: ${taskId}`;
}

/**
 * The task id a commit message claims, or null.
 *
 * Matched anywhere in the message rather than only in the last
 * paragraph, because a rebase, a squash, or a person amending the
 * commit can move it, and a trailer that stops being found after a
 * rebase would be a trailer that does not survive landing, which is
 * the one thing it exists to do.
 *
 * The value is checked against the uuid shape rather than taken as
 * written: the message is agent output, and a commit is a place an
 * agent could put a line that looks like a trailer and says something
 * else. Anything that is not a uuid is not a task id.
 */
const TRAILER_LINE = new RegExp(`^[ \\t]*${TASK_TRAILER}[ \\t]*:[ \\t]*(\\S+)[ \\t]*$`, "im");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTaskTrailer(message: string): string | null {
  const match = TRAILER_LINE.exec(message);
  if (!match?.[1]) return null;
  const value = match[1];
  return UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * How a worker's branch is put onto the swarm's branch.
 *
 * Two policies, and the difference is what a reviewer reads afterwards.
 *
 * "rebase" replays the worker's own commits onto the swarm's branch, so
 * the branch stays linear and each commit keeps its trailer and its
 * message. This is the default, and it is what makes the swarm's
 * eventual pull request read as a series of changes rather than as a
 * pile of merges of branches that no longer exist.
 *
 * "merge" makes one commit joining the worker's branch in, and that
 * commit carries the trailer itself. It is for the case a rebase would
 * lie about: work whose history is worth keeping as it happened, and
 * work a resolver has already reconciled against the swarm's branch,
 * where replaying the commits again would ask git to resolve the same
 * conflict a second time.
 */
export type LandingPolicy = "rebase" | "merge";

/**
 * The policy for landing one task.
 *
 * Rebase unless the row says otherwise. A resolver run sets
 * `landPolicy: "merge"` in the leaf's flags when it has reconciled the
 * branch by hand, because at that point the worker's branch already
 * contains the swarm's branch and rebasing it would replay commits
 * that are in both.
 */
export function landingPolicyFor(task: Pick<Task, "flags">): LandingPolicy {
  return task.flags?.landPolicy === "merge" ? "merge" : "rebase";
}

/** The message a merge landing's own commit gets. */
export function landingMergeMessage(task: Pick<Task, "id" | "title">): string {
  return [`Land: ${task.title}`, "", taskTrailer(task.id)].join("\n");
}

/**
 * What the worker is told about committing.
 *
 * Shared with the worker prompt rather than written into it, because
 * the merge queue reads the result: a commit with no trailer is a
 * commit the console cannot attribute to a node, and a worker that
 * pushed would have landed its own work past the queue.
 */
export function commitPolicyLines(branch: string, taskId: string): string[] {
  return [
    `Commit your work on ${branch}, which is already checked out. Do not create other branches, do not switch branches, and never commit to the swarm's branch or to the repository's default branch.`,
    `End every commit message with this line, exactly as written, on a line of its own:`,
    taskTrailer(taskId),
    "It is how Bento knows which commits belong to your task once they are on the swarm's branch.",
    "Do not push, do not merge, and do not open a pull request. Bento's merge queue lands your branch onto the swarm's branch, one branch at a time, and it is the only thing that pushes anywhere.",
  ];
}
