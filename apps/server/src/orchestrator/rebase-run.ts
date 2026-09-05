import { desc, eq } from "drizzle-orm";
import { agentRuns, repositories, type Db } from "@bento/db";
import type { GitHubPublisher } from "@bento/github";
import type { AppContext } from "../context.js";
import { CARD_BUSY, startRunIfIdle } from "./start-run.js";
import { enqueueRun } from "./queue.js";
import { latestConversationRun, resolveFollowUpRun } from "./stage-agent.js";
import { refreshBaseBranches } from "./repo-remote.js";
import { isAncestryPublishFailure, publishFeatureBranches, type PublishedPullRequest, type PublishableRepository } from "./publish.js";
import { buildRebaseForPublishPrompt } from "./prompt.js";

export interface RebaseTarget {
  name: string;
  defaultBranch: string;
}

type AgentRun = typeof agentRuns.$inferSelect;

export type StartRebaseResult =
  | { ok: true; run: AgentRun }
  | { ok: false; status: 400 | 404 | 409 | 402; error: string; code?: string };

/**
 * Starts a follow-up run on the card's work agent: rebase, CI fixes,
 * or anything else that continues the same conversation. The server
 * publishes when the run finishes; the agent never receives push
 * credentials.
 */
export async function startFeatureFollowUpRun(
  ctx: AppContext,
  db: Db,
  feature: {
    id: string;
    projectId: string;
    branchName: string | null;
    status: string;
    currentStageId: string | null;
  },
  prompt: string,
  startedBy: string,
  kind: "rebase" | "task",
  defer?: (task: () => void) => void,
): Promise<StartRebaseResult> {
  if (feature.status === "done" || feature.status === "cancelled") {
    return { ok: false, status: 409, error: `feature is ${feature.status}; reopen it first` };
  }
  if (!feature.branchName) {
    return { ok: false, status: 409, error: "this card has no branch yet; run an agent on it first" };
  }

  const conversation = await latestConversationRun(db, feature.id);
  const [latest] = conversation
    ? [conversation]
    : await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.featureId, feature.id))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
  if (!latest) {
    return { ok: false, status: 400, error: "no agent has run on this card yet; start one first" };
  }

  const resumeFrom = await resolveFollowUpRun(db, feature, conversation ?? latest);
  if (resumeFrom.executor !== "server") {
    return {
      ok: false,
      status: 409,
      error:
        "this project's agents run on a runner, and the server cannot push a branch it never sees. Rebase and push from the runner's checkout, or switch the project to server execution.",
    };
  }

  if (ctx.driver.provider !== "sprite") {
    const repos = await db
      .select({ localPath: repositories.localPath, defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(eq(repositories.projectId, feature.projectId));
    await refreshBaseBranches(repos);
  }

  const run = await startRunIfIdle(
    db,
    {
      featureId: feature.id,
      stageId: resumeFrom.stageId,
      agentProfileId: resumeFrom.agentProfileId,
      prompt,
      cliSessionId: resumeFrom.cliSessionId,
      executor: resumeFrom.executor,
      kind,
      startedBy,
    },
    ctx.entitlements,
    ctx.analytics,
    defer,
  );
  if (run === "busy") return { ok: false, status: 409, error: CARD_BUSY, code: "CARD_BUSY" };
  if (run === "gone") return { ok: false, status: 404, error: "not found" };
  if ("outOfCompute" in run) return { ok: false, status: 402, error: run.outOfCompute, code: "PLAN_LIMIT" };

  await enqueueRun(ctx, run.id);
  return { ok: true, run };
}

/** Starts a rebase run on the card's work agent. */
export async function startFeatureRebaseRun(
  ctx: AppContext,
  db: Db,
  feature: {
    id: string;
    projectId: string;
    branchName: string | null;
    status: string;
    currentStageId: string | null;
  },
  prompt: string,
  startedBy: string,
  defer?: (task: () => void) => void,
): Promise<StartRebaseResult> {
  return startFeatureFollowUpRun(ctx, db, feature, prompt, startedBy, "rebase", defer);
}

/**
 * When publish failed only because the feature branch is not based on
 * the current default branch, start a rebase run instead of leaving
 * the card stuck. Returns the run when one was queued.
 */
export async function tryRebaseAfterAncestryPublishFailures(
  ctx: AppContext,
  db: Db,
  feature: {
    id: string;
    projectId: string;
    branchName: string | null;
    status: string;
    currentStageId: string | null;
  },
  failures: { name: string; reason: string }[],
  targets: RebaseTarget[],
  startedBy: string,
  defer?: (task: () => void) => void,
): Promise<AgentRun | undefined> {
  if (failures.length === 0 || !failures.every((f) => isAncestryPublishFailure(f.reason))) return undefined;
  const result = await startFeatureRebaseRun(
    ctx,
    db,
    feature,
    buildRebaseForPublishPrompt(feature.branchName!, targets),
    startedBy,
    defer,
  );
  return result.ok ? result.run : undefined;
}

export interface RecoverAncestryPublishResult {
  rebaseRun?: AgentRun;
  draftPublished: PublishedPullRequest[];
  draftFailures: { name: string; reason: string }[];
}

/**
 * When publish failed because the branch is not based on the current
 * default branch, try a rebase run first. If one cannot be queued,
 * push the branch anyway and open a draft pull request so the work is
 * visible on GitHub even with merge conflicts.
 */
export async function recoverAncestryPublishFailures(
  ctx: AppContext,
  db: Db,
  feature: {
    id: string;
    projectId: string;
    branchName: string | null;
    status: string;
    currentStageId: string | null;
    title: string;
  },
  failures: { name: string; reason: string }[],
  targets: RebaseTarget[],
  publish: {
    publisher: GitHubPublisher;
    branch: string;
    repositories: PublishableRepository[];
    includeStageNotes?: boolean;
  },
  startedBy: string,
  defer?: (task: () => void) => void,
): Promise<RecoverAncestryPublishResult> {
  const ancestryFailures = failures.filter((f) => isAncestryPublishFailure(f.reason));
  if (ancestryFailures.length === 0) {
    return { draftPublished: [], draftFailures: [] };
  }

  const rebaseRun = await tryRebaseAfterAncestryPublishFailures(
    ctx,
    db,
    feature,
    failures,
    targets,
    startedBy,
    defer,
  );
  if (rebaseRun) return { rebaseRun, draftPublished: [], draftFailures: [] };

  const { published, failures: draftFailures } = await publishFeatureBranches(
    db,
    publish.publisher,
    {
      featureId: feature.id,
      featureTitle: feature.title,
      branch: publish.branch,
      repositories: publish.repositories,
    },
    {
      ...(publish.includeStageNotes !== undefined ? { includeStageNotes: publish.includeStageNotes } : {}),
      draft: true,
      onlyRepositories: ancestryFailures.map((f) => f.name),
    },
  );
  return { draftPublished: published, draftFailures };
}
