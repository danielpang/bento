import { asc, eq } from "drizzle-orm";
import { featurePullRequests, projects, repositories, type Db } from "@bento/db";
import { parseRepoUrl } from "@bento/github";

export interface FeaturePullRequestTarget {
  repoUrl: string;
  number: number;
  url: string;
  /** Null when the repository left the project, or for a hand-linked number. */
  name: string | null;
  defaultBranch: string | null;
}

/**
 * The pull requests a card answers for.
 *
 * Rows come from publishing, one per repository the agent committed in.
 * The project's own repoUrl with the card's mirrored number is the
 * fallback for a pull request someone linked by hand, from before there
 * were rows, or without a GitHub App to open one. The gate evaluator
 * and the merge-status and resolve-conflicts routes all consult this
 * same list; until they shared it, a hand-linked pull request gated the
 * card but was invisible to the conflict check.
 */
export async function featurePullRequestTargets(
  db: Db,
  feature: { id: string; projectId: string; prNumber: number | null },
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
    .where(eq(featurePullRequests.featureId, feature.id))
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
