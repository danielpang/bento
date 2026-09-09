import { and, eq } from "drizzle-orm";
import { featurePullRequests, features, type Db } from "@bento/db";
import { parseRepoUrl, type GitHubPublisher } from "@bento/github";

/**
 * A card whose pull request was merged starts its next run on a new
 * branch.
 *
 * One card, one branch held for the life of the card, which is right
 * until the branch lands. After a merge the old branch is finished:
 * GitHub usually deletes it, the commits on it are in the base branch
 * already, and a follow-up message that kept working there would build
 * on a branch point the base branch has moved past, then open a second
 * pull request out of a branch its first one already merged.
 *
 * So the merge is what ends a branch, and the next message is what
 * starts the next one, from the base branch as it now stands.
 *
 * Read from GitHub rather than from a webhook, because the deployments
 * that need this most (local mode, a self-hoster behind a laptop) have
 * no public URL for GitHub to call. It costs one API read per recorded
 * pull request, on a path that is about to provision a sandbox.
 */

/**
 * The branch a card works on, named or derived.
 *
 * A card gets its branch name from the gate evaluator when it enters a
 * pipeline, and a run started before that derives one from the id. The
 * derivation lived in four places and now lives here, because a reader
 * that guessed differently from the run that published looked straight
 * past the card's own pull requests.
 */
export function cardBranch(feature: { id: string; branchName: string | null }): string {
  return feature.branchName ?? `feature/${feature.id.slice(0, 8)}`;
}

/** How long the merge reads get before the run goes on regardless. */
const MERGED_READ_TIMEOUT_MS = 8000;

export interface RunBranch {
  /** The branch this run works on. */
  branch: string;
  /**
   * The merged pull requests the branch replaced, empty when nothing
   * was replaced. The run says this in its transcript: a card that
   * quietly changed branch under someone is a card whose next pull
   * request arrives unexplained.
   */
  replaced: { number: number; url: string; repoUrl: string }[];
}

/**
 * The branch a card's next run works on, rotating it when every pull
 * request the card has open was merged.
 *
 * Conservative on purpose. Nothing rotates unless GitHub positively
 * says merged: no connection, no recorded pull request, an unreadable
 * answer, a slow answer, or one repository of three still open all
 * leave the card exactly where it is. Being wrong in that direction
 * costs a stale branch somebody can see and fix; being wrong the other
 * way abandons a branch mid-review.
 */
export async function branchForRun(
  db: Db,
  publisher: GitHubPublisher | undefined,
  args: { featureId: string; branch: string },
  options: { timeoutMs?: number } = {},
): Promise<RunBranch> {
  const unchanged: RunBranch = { branch: args.branch, replaced: [] };
  if (!publisher) return unchanged;

  const rows = await db
    .select({
      number: featurePullRequests.number,
      url: featurePullRequests.url,
      repoUrl: featurePullRequests.repoUrl,
    })
    .from(featurePullRequests)
    .where(
      and(
        eq(featurePullRequests.featureId, args.featureId),
        // This branch's pull requests, not the card's. The rows of the
        // branches it has already merged stay, and asking about them
        // again would rotate the card on every run for ever.
        eq(featurePullRequests.branch, args.branch),
      ),
    );
  // Nothing published from this branch, so nothing of it has landed: a
  // card on its first run, or one already rotated and not yet
  // republished.
  if (rows.length === 0) return unchanged;

  const merged = await withTimeout(
    allMerged(publisher, rows),
    options.timeoutMs ?? MERGED_READ_TIMEOUT_MS,
  );
  if (!merged) return unchanged;

  /**
   * The card moves; its pull requests stay where they are.
   *
   * The rows are the card's record of what it has landed, one per
   * branch it published from, so a card that has merged three branches
   * can still say which pull requests those were. What makes them
   * harmless once merged is that everything asking for the live pull
   * request asks by the branch the card is on, and the mirrored
   * pr_number is cleared here: until the next publish this card has no
   * current pull request, which is the truth.
   */
  const branch = nextBranchName(args.branch);
  await db.update(features).set({ branchName: branch, prNumber: null }).where(eq(features.id, args.featureId));

  return { branch, replaced: rows };
}

/**
 * The next branch for a card, counting up from the one it has:
 * feature/checkout-flow-a1b2c3d4 becomes feature/checkout-flow-a1b2c3d4-2,
 * and that one becomes -3.
 *
 * The suffix is bounded to three digits so it cannot mistake the id
 * that ends most Bento branch names for a counter, and the whole name
 * is a name a person reads on GitHub, so it stays the card's name with
 * a number rather than becoming a new random string.
 */
export function nextBranchName(branch: string): string {
  const counted = /-(\d{1,3})$/.exec(branch);
  if (!counted) return `${branch}-2`;
  return `${branch.slice(0, counted.index)}-${Number(counted[1]) + 1}`;
}

/**
 * True only when every recorded pull request reads back as merged.
 *
 * Together rather than one after another. The reads are what the
 * caller waits on, and on the runner's claim path that wait happens
 * inside the request's tenant transaction, holding a pooled
 * connection: a card spanning three repositories should cost one round
 * trip of waiting, not three.
 */
async function allMerged(
  publisher: GitHubPublisher,
  rows: { number: number; repoUrl: string }[],
): Promise<boolean> {
  const answers = await Promise.all(
    rows.map(async (row) => {
      const parsed = parseRepoUrl(row.repoUrl);
      if (!parsed) return false;
      try {
        const pr = await publisher.getPullRequest({
          owner: parsed.owner,
          repo: parsed.repo,
          prNumber: row.number,
        });
        return pr.merged;
      } catch {
        // Deleted, moved, or GitHub refusing to say. Unreadable is not
        // merged: the card keeps its branch and asks again next run.
        return false;
      }
    }),
  );
  return answers.every(Boolean);
}

/**
 * False on timeout, never a throw. GitHub being slow must not hold up
 * provisioning a sandbox; the card keeps its branch and the question
 * is asked again on the next run.
 */
async function withTimeout(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
