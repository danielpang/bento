import { and, asc, desc, eq } from "drizzle-orm";
import { featurePullRequests, projects, repositories, type Db } from "@bento/db";
import { parseRepoUrl } from "@bento/github";
import { cardBranch } from "./orchestrator/branch-rotation.js";

export interface FeaturePullRequestTarget {
  repoUrl: string;
  number: number;
  url: string;
  /** Null when the repository left the project, or for a hand-linked number. */
  name: string | null;
  defaultBranch: string | null;
}

/**
 * The pull requests a card answers for right now.
 *
 * Rows come from publishing, one per repository the agent committed in
 * per branch it opened them from. A card keeps the pull requests of
 * every branch it has had, and only the branch it is on now is the one
 * it answers for: a gate that read a merged pull request from a branch
 * the card has left would pass a stage nothing had reviewed.
 *
 * The project's own repoUrl with the card's mirrored number is the
 * fallback for a pull request someone linked by hand, from before there
 * were rows, or without a GitHub App to open one. The gate evaluator
 * and the merge-status and resolve-conflicts routes all consult this
 * same list; until they shared it, a hand-linked pull request gated the
 * card but was invisible to the conflict check.
 */
export async function featurePullRequestTargets(
  db: Db,
  feature: { id: string; projectId: string; prNumber: number | null; branchName: string | null },
): Promise<FeaturePullRequestTarget[]> {
  const rows = await db
    .select({
      repoUrl: featurePullRequests.repoUrl,
      number: featurePullRequests.number,
      url: featurePullRequests.url,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
    })
    .from(featurePullRequests)
    .leftJoin(repositories, eq(repositories.id, featurePullRequests.repositoryId))
    // The derived name, not just the stored one: a card can publish
    // before anything names its branch, and reading those rows back
    // has to use the same name the run wrote them under.
    .where(and(eq(featurePullRequests.featureId, feature.id), eq(featurePullRequests.branch, cardBranch(feature))))
    .orderBy(asc(featurePullRequests.createdAt));
  if (rows.length > 0) return rows;
  if (!feature.prNumber) return [];

  const [project] = await db.select().from(projects).where(eq(projects.id, feature.projectId));
  if (!project?.repoUrl) return [];
  const parsed = parseRepoUrl(project.repoUrl);
  if (!parsed) return [];
  // The project mirrors its first repository, so that row carries the
  // base branch the hand-linked pull request targets.
  const [first] = await db
    .select({ name: repositories.name, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.projectId, feature.projectId))
    .orderBy(asc(repositories.position))
    .limit(1);
  return [
    {
      repoUrl: project.repoUrl,
      number: feature.prNumber,
      url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${feature.prNumber}`,
      name: first?.name ?? null,
      defaultBranch: first?.defaultBranch ?? null,
    },
  ];
}

export interface FeaturePullRequestRecord extends FeaturePullRequestTarget {
  /** The branch it was opened from. */
  branch: string;
  /** True for the pull requests of the branch the card is on now. */
  current: boolean;
}

/**
 * Every pull request the card has ever opened, newest first.
 *
 * A card that merges a branch and is then asked for more starts a new
 * branch and opens a new pull request, so what it has shipped is a
 * list, not a number. The list is the card's own record of that, read
 * without touching GitHub; how each one ended is a separate question
 * with a separate round trip.
 *
 * The hand-linked fallback has no place here: it is a number somebody
 * typed on the card, not a pull request this card opened, and it
 * already shows as the card's current one.
 */
export async function featurePullRequestHistory(
  db: Db,
  feature: { id: string; branchName: string | null },
): Promise<FeaturePullRequestRecord[]> {
  const rows = await db
    .select({
      repoUrl: featurePullRequests.repoUrl,
      number: featurePullRequests.number,
      url: featurePullRequests.url,
      branch: featurePullRequests.branch,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
    })
    .from(featurePullRequests)
    .leftJoin(repositories, eq(repositories.id, featurePullRequests.repositoryId))
    .where(eq(featurePullRequests.featureId, feature.id))
    .orderBy(desc(featurePullRequests.createdAt))
    /**
     * Bounded because the drawer asks GitHub how each of these ended,
     * one read per row, on every settled run. Fifty is far past any
     * real card and keeps a pathological one from spending a rate
     * limit; the newest are the ones anybody is looking for.
     */
    .limit(50);
  const live = cardBranch(feature);
  return rows.map((row) => ({ ...row, current: row.branch === live }));
}

/**
 * How a pull request ended, from what GitHub says about it.
 *
 * "merged" only on the merged flag: a pull request someone closed
 * without merging is also state "closed", and calling that shipped
 * would tell a card it had landed work that never landed.
 */
export function pullRequestStateOf(pr: { state: string; merged: boolean }): "merged" | "open" | "closed" {
  if (pr.merged) return "merged";
  return pr.state === "open" ? "open" : "closed";
}
