import { and, desc, eq } from "drizzle-orm";
import { stageArtifactPath } from "@bento/core";
import { runArtifacts } from "@bento/db";
import type { Db } from "@bento/db";
import {
  isBentoDefaultPullRequestBody,
  parseRepoUrl,
  parseStageWriteUpForPullRequest,
  pullRequestRunMarker,
  type GitHubPublisher,
} from "@bento/github";
import type { PublishedPullRequest } from "./publish.js";

/** Stage write-ups from these slugs replace the pull request description after publish. */
export const PR_DESCRIPTION_STAGE_SLUGS = new Set(["implementation"]);

/** Stage write-ups from these slugs are posted as pull request comments after publish. */
export const PR_COMMENT_STAGE_SLUGS = new Set(["code-review"]);

export interface SyncPullRequestsFromRunInput {
  runId: string;
  stageSlug: string;
  stageName: string;
  published: PublishedPullRequest[];
  say?: (text: string) => Promise<void>;
}

/**
 * After a successful publish, copy the stage write-up onto GitHub.
 *
 * Implementation stages may replace Bento's boilerplate description (and
 * an optional leading H1 title). Code review stages post one comment per
 * pull request, keyed by run id so a republish does not duplicate it.
 *
 * Failures are reported in the transcript and never fail the run.
 */
export async function syncPullRequestsFromRun(
  db: Db,
  publisher: GitHubPublisher,
  input: SyncPullRequestsFromRunInput,
): Promise<void> {
  const syncDescription = PR_DESCRIPTION_STAGE_SLUGS.has(input.stageSlug);
  const syncComment = PR_COMMENT_STAGE_SLUGS.has(input.stageSlug);
  if (!syncDescription && !syncComment) return;
  if (input.published.length === 0) return;

  const writeUp = await readStageWriteUp(db, input.runId, input.stageSlug);
  if (!writeUp?.trim()) {
    await input.say?.(
      syncComment
        ? "No stage write-up was captured, so nothing was posted to the pull request."
        : "No stage write-up was captured, so the pull request description was not updated.",
    );
    return;
  }

  const parsed = parseStageWriteUpForPullRequest(writeUp);
  let updated = 0;
  let commented = 0;

  for (const pr of input.published) {
    const repo = parseRepoUrl(pr.repoUrl);
    if (!repo) continue;
    const ref = { owner: repo.owner, repo: repo.repo, prNumber: pr.prNumber };

    try {
      if (syncDescription && parsed.body) {
        const current = await publisher.getPullRequest(ref);
        if (isBentoDefaultPullRequestBody(current.body)) {
          await publisher.updatePullRequest({
            ...ref,
            ...(parsed.title ? { title: parsed.title } : {}),
            body: parsed.body,
          });
          updated += 1;
        }
      }

      if (syncComment) {
        const already = await publisher.pullRequestHasRunComment(ref, input.runId);
        if (!already) {
          const body = [
            writeUp.trim(),
            "",
            `_${input.stageName} (via Bento)_`,
            pullRequestRunMarker(input.runId),
          ].join("\n");
          await publisher.createPullRequestComment(ref, body);
          commented += 1;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await input.say?.(`Could not sync the pull request for ${pr.name}: ${reason}`);
    }
  }

  if (syncDescription && updated > 0) {
    await input.say?.(
      updated === 1
        ? "Updated the pull request description from this stage's write-up."
        : `Updated ${updated} pull request descriptions from this stage's write-up.`,
    );
  }
  if (syncComment && commented > 0) {
    await input.say?.(
      commented === 1
        ? "Posted this stage's write-up as a pull request comment."
        : `Posted this stage's write-up as pull request comments on ${commented} repositories.`,
    );
  }
}

async function readStageWriteUp(db: Db, runId: string, stageSlug: string): Promise<string | null> {
  const expected = stageArtifactPath(stageSlug);
  const [artifact] = await db
    .select()
    .from(runArtifacts)
    .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.kind, "markdown")))
    .orderBy(desc(runArtifacts.createdAt))
    .limit(1);
  if (!artifact?.content) return null;
  if (artifact.path === expected || artifact.path.endsWith(`/${expected}`)) {
    return artifact.content;
  }
  const [writeUp] = await db
    .select()
    .from(runArtifacts)
    .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.kind, "markdown"), eq(runArtifacts.path, expected)))
    .limit(1);
  return writeUp?.content ?? artifact.content;
}
