import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { pullRequestUpdates } from "@bento/db";
import type { Db } from "@bento/db";
import { parseRepoUrl, pullRequestMarker, type GitHubPublisher } from "@bento/github";

/**
 * A pull request an update can be applied to. Both the publish step
 * (a PublishedPullRequest) and the card tools (a FeaturePullRequestTarget
 * with a number) fit this shape.
 */
export interface PullRequestUpdateTarget {
  /** The repository's name in the project; null for a hand-linked pull request. */
  name: string | null;
  repoUrl: string;
  prNumber: number;
  url: string;
}

export interface ApplyPullRequestUpdatesResult {
  /** Pull requests whose title or description changed. */
  updated: number;
  /** Comments posted. */
  commented: number;
  /** One line per pull request that could not be written to. */
  failures: string[];
}

/**
 * Writes what the card's agents asked for onto its pull requests.
 *
 * Pending rows are read oldest first, so of two descriptions the later
 * one wins, and a title from one row survives a body-only row after
 * it. Each pull request gets at most one update call. Comments are
 * posted once each, checked by their marker first, so a crash between
 * posting and marking cannot post the same comment twice.
 *
 * A row is marked applied once it has reached every pull request it
 * names: the one repository it was written for, or all of them. A row
 * for a repository that did not publish this time stays pending for
 * the next publish, and so does everything on a pull request GitHub
 * refused, which is reported rather than thrown: the branch is
 * pushed and the pull request is open, and a description that did not
 * land is not a reason to fail the run that did the work.
 */
export async function applyPendingPullRequestUpdates(
  db: Db,
  publisher: GitHubPublisher,
  input: {
    featureId: string;
    targets: PullRequestUpdateTarget[];
    say?: (text: string) => Promise<void>;
  },
): Promise<ApplyPullRequestUpdatesResult> {
  const result: ApplyPullRequestUpdatesResult = { updated: 0, commented: 0, failures: [] };
  if (input.targets.length === 0) return result;

  const pending = await db
    .select()
    .from(pullRequestUpdates)
    .where(and(eq(pullRequestUpdates.featureId, input.featureId), isNull(pullRequestUpdates.appliedAt)))
    .orderBy(asc(pullRequestUpdates.createdAt));
  if (pending.length === 0) return result;

  /** How many pull requests each row still has to reach, and how many it did. */
  const needed = new Map<string, number>();
  const reached = new Map<string, number>();
  for (const row of pending) {
    const count = input.targets.filter((t) => rowTargets(row, t)).length;
    needed.set(row.id, count);
    reached.set(row.id, 0);
  }

  for (const target of input.targets) {
    const parsed = parseRepoUrl(target.repoUrl);
    if (!parsed) continue;
    const ref = { owner: parsed.owner, repo: parsed.repo, prNumber: target.prNumber };
    const rows = pending.filter((row) => rowTargets(row, target));
    if (rows.length === 0) continue;
    const label = target.name ?? `${parsed.owner}/${parsed.repo}`;

    try {
      const descriptions = rows.filter((row) => row.kind === "description");
      if (descriptions.length > 0) {
        const title = descriptions.map((row) => row.title).filter((t): t is string => !!t).at(-1);
        const body = descriptions.map((row) => row.body).filter((b) => b.length > 0).at(-1);
        if (title !== undefined || body !== undefined) {
          await publisher.updatePullRequest({
            ...ref,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
          });
          result.updated += 1;
        }
        for (const row of descriptions) reached.set(row.id, (reached.get(row.id) ?? 0) + 1);
      }

      for (const row of rows) {
        if (row.kind !== "comment") continue;
        const marker = pullRequestMarker(row.id);
        if (!(await publisher.pullRequestHasComment(ref, marker))) {
          await publisher.createPullRequestComment(ref, `${row.body.trim()}\n\n${marker}`);
          result.commented += 1;
        }
        reached.set(row.id, (reached.get(row.id) ?? 0) + 1);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failures.push(`${label}: ${reason}`);
      await input.say?.(`Could not update the pull request for ${label}: ${reason}`);
    }
  }

  const done = pending
    .filter((row) => (needed.get(row.id) ?? 0) > 0 && reached.get(row.id) === needed.get(row.id))
    .map((row) => row.id);
  if (done.length > 0) {
    await db
      .update(pullRequestUpdates)
      .set({ appliedAt: new Date(), updatedAt: new Date() })
      .where(inArray(pullRequestUpdates.id, done));
  }

  if (result.updated > 0) {
    await input.say?.(
      result.updated === 1
        ? "Applied the agent's title and description to the pull request."
        : `Applied the agent's title and description to ${result.updated} pull requests.`,
    );
  }
  if (result.commented > 0) {
    await input.say?.(
      result.commented === 1
        ? "Posted the agent's comment on the pull request."
        : `Posted ${result.commented} comments from the agent on the pull requests.`,
    );
  }
  return result;
}

/** Whether a row was written for this pull request: its repository, or every one. */
function rowTargets(row: { repository: string | null }, target: PullRequestUpdateTarget): boolean {
  return row.repository === null || row.repository === target.name;
}
