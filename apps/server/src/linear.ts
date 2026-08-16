import { and, eq, isNull } from "drizzle-orm";
import { features, linearConnections, linearIssueLinks, pipelines } from "@bento/db";
import { LinearClient, type LinearIssue, type LinearWorkflowState } from "@bento/linear";
import type { AppContext } from "./context.js";

export type LinearConnectionRow = typeof linearConnections.$inferSelect;

export function linearOrgFilter(organizationId: string | null) {
  return organizationId
    ? eq(linearConnections.organizationId, organizationId)
    : isNull(linearConnections.organizationId);
}

/** The stored connection row for one tenant, or null. */
export async function linearConnectionRow(
  ctx: AppContext,
  organizationId: string | null,
): Promise<LinearConnectionRow | null> {
  const [row] = await ctx.db
    .select()
    .from(linearConnections)
    .where(linearOrgFilter(organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * The Linear client for one tenant, from its stored API key. Mirrors
 * githubConnectionFor: the key is a server credential, decrypted here
 * and never part of an agent's environment.
 */
export async function linearConnectionFor(
  ctx: AppContext,
  organizationId: string | null,
): Promise<{ client: LinearClient; connection: LinearConnectionRow } | null> {
  const connection = await linearConnectionRow(ctx, organizationId);
  if (!connection) return null;
  try {
    return { client: new LinearClient(ctx.secretBox.decrypt(connection.encryptedApiKey)), connection };
  } catch {
    // Encrypted under a rotated key: treat as not connected and let the
    // UI ask for the key again.
    return null;
  }
}

/**
 * Where a card created in Bento files its issue, or null for "file
 * nothing".
 *
 * The team mapped to the card's project wins, so both directions agree
 * about which team a project belongs to, and the configured default
 * covers every project without a mapping. Without either there is no
 * team, and Linear cannot create an issue without one, so the card
 * simply stays Bento only.
 *
 * The Linear project rides along only with the default team, because a
 * project belongs to the team it was created under: attaching it to an
 * issue filed in a mapped team would either be refused or file the work
 * somewhere that project does not cover.
 */
export function resolveIssueTarget(
  connection: Pick<LinearConnectionRow, "createIssues" | "defaultTeamId" | "defaultLinearProjectId">,
  mappedTeamId: string | null,
): { teamId: string; projectId: string | null } | null {
  if (!connection.createIssues) return null;
  const teamId = mappedTeamId ?? connection.defaultTeamId;
  if (!teamId) return null;
  const sameTeam = teamId === connection.defaultTeamId;
  return { teamId, projectId: sameTeam ? (connection.defaultLinearProjectId ?? null) : null };
}

/** Bento lifecycle to Linear workflow state type. */
export function stateTypeForStatus(status: string): string | null {
  switch (status) {
    case "backlog":
      return "backlog";
    case "active":
    case "gated":
      return "started";
    case "done":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return null;
  }
}

/**
 * Fallback order when a team's workflow lacks a state of the wanted
 * type. Reaching the end means skip the state update and comment only.
 */
const STATE_TYPE_FALLBACKS: Record<string, string[]> = {
  backlog: ["backlog", "unstarted"],
  started: ["started", "unstarted"],
  completed: ["completed"],
  canceled: ["canceled"],
};

/** Picks the team's first workflow state of the wanted type, if any. */
export async function resolveTeamState(
  client: LinearClient,
  teamId: string,
  type: string,
): Promise<LinearWorkflowState | null> {
  const states = await client.teamStates(teamId);
  for (const candidate of STATE_TYPE_FALLBACKS[type] ?? [type]) {
    const match = states
      .filter((s) => s.type === candidate)
      .sort((a, b) => a.position - b.position)[0];
    if (match) return match;
  }
  return null;
}

/**
 * Imports one Linear issue as a backlog feature plus its link row.
 * Shared by the manual import route, the backlog sweep, and the webhook
 * worker, so all three dedupe the same way: the unique issue index makes
 * a repeat import a no-op. Returns the feature id, or null when the
 * issue was already imported or the project has no pipeline.
 */
export async function importLinearIssue(
  ctx: AppContext,
  options: {
    organizationId: string | null;
    projectId: string;
    issue: Pick<LinearIssue, "id" | "identifier" | "title" | "url"> & {
      description?: string | null;
      team?: { id: string } | null;
      teamId?: string;
    };
  },
): Promise<string | null> {
  const { issue } = options;
  const [existing] = await ctx.db
    .select({ id: linearIssueLinks.id })
    .from(linearIssueLinks)
    .where(
      and(
        options.organizationId
          ? eq(linearIssueLinks.organizationId, options.organizationId)
          : isNull(linearIssueLinks.organizationId),
        eq(linearIssueLinks.linearIssueId, issue.id),
      ),
    )
    .limit(1);
  if (existing) return null;

  const [pipeline] = await ctx.db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.projectId, options.projectId))
    .limit(1);
  if (!pipeline) return null;

  const description = [issue.description?.trim(), issue.url].filter(Boolean).join("\n\n");
  const [feature] = await ctx.db
    .insert(features)
    .values({
      projectId: options.projectId,
      pipelineId: pipeline.id,
      title: issue.title,
      description,
    })
    .returning({ id: features.id });
  if (!feature) return null;

  try {
    await ctx.db
      .insert(linearIssueLinks)
      .values({
        featureId: feature.id,
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        linearIssueUrl: issue.url,
        linearTeamId: issue.team?.id ?? issue.teamId ?? "",
      })
      .onConflictDoNothing();
  } catch {
    // A concurrent import won the race; remove the duplicate feature.
    await ctx.db.delete(features).where(eq(features.id, feature.id));
    return null;
  }
  const [link] = await ctx.db
    .select({ featureId: linearIssueLinks.featureId })
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.linearIssueId, issue.id))
    .limit(1);
  if (link && link.featureId !== feature.id) {
    // onConflictDoNothing swallowed a concurrent duplicate: this
    // feature has no link, so it must not stay on the board.
    await ctx.db.delete(features).where(eq(features.id, feature.id));
    return null;
  }
  return feature.id;
}
