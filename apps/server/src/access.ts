import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { agentRuns, features, member, pipelines, projects, runArtifacts, stages } from "@bento/db";
import type { Context } from "hono";
import type { AppContext } from "./context.js";
import { actor, activeOrg } from "./middleware/actor.js";
import { tenantDb as db } from "./middleware/tenant.js";

/**
 * Which projects the caller may see.
 *
 * Local mode has no organizations, so ownership is the only rule. In
 * multi mode a project is visible to every member of its organization,
 * which is what makes a shared board work; projects created before the
 * caller joined an org (organizationId null) stay visible to their
 * creator so nothing is orphaned by upgrading to teams.
 */
export async function visibleProjectFilter(ctx: AppContext, c: Context): Promise<SQL | undefined> {
  const userId = actor(c);
  if (ctx.env.BENTO_MODE !== "multi") return eq(projects.ownerId, userId);

  const memberships = await db(c, ctx)
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const orgIds = memberships.map((m) => m.organizationId);

  const ownOnly = and(eq(projects.ownerId, userId), isNull(projects.organizationId));
  if (orgIds.length === 0) return ownOnly;
  return or(ownOnly, inArray(projects.organizationId, orgIds));
}

/**
 * Re-resolves the session's active organization against current
 * membership. Sessions can outlive a removal from an organization, so
 * activeOrg alone is not an authorization check.
 */
export async function getActiveOrganizationMembership(ctx: AppContext, c: Context) {
  if (ctx.env.BENTO_MODE !== "multi") return null;
  const organizationId = activeOrg(c);
  if (!organizationId) return null;

  const [membership] = await db(c, ctx)
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(and(eq(member.userId, actor(c)), eq(member.organizationId, organizationId)));
  return membership ?? null;
}

/** Throws-free check that the caller may act on one project. */
export async function canAccessProject(ctx: AppContext, c: Context, projectId: string): Promise<boolean> {
  const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, projectId));
  if (!project) return false;
  const userId = actor(c);
  if (ctx.env.BENTO_MODE !== "multi") return project.ownerId === userId;
  if (!project.organizationId) return project.ownerId === userId;

  const [membership] = await db(c, ctx)
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, project.organizationId)));
  return Boolean(membership);
}

/** The org a new project should belong to, or null in local mode. */
export function newProjectOrg(ctx: AppContext, c: Context): string | null {
  return ctx.env.BENTO_MODE === "multi" ? activeOrg(c) : null;
}

/**
 * Entity-level access: each returns the row only when the caller may act
 * on its project, and null otherwise. Routes treat null as 404 so a
 * probe cannot distinguish "does not exist" from "not yours".
 *
 * These exist because every mutating route on a feature, run, or stage
 * is as powerful as the orchestrator itself: approving advances the
 * card, and a stage's gateCriteria can carry a command the server will
 * execute inside the project's sandbox.
 */
export async function getAccessibleFeature(ctx: AppContext, c: Context, featureId: string) {
  const [feature] = await db(c, ctx).select().from(features).where(eq(features.id, featureId));
  if (!feature) return null;
  return (await canAccessProject(ctx, c, feature.projectId)) ? feature : null;
}

export async function getAccessibleRun(ctx: AppContext, c: Context, runId: string) {
  const [run] = await db(c, ctx).select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return null;
  const feature = await getAccessibleFeature(ctx, c, run.featureId);
  return feature ? { run, feature } : null;
}

export async function getAccessibleArtifact(ctx: AppContext, c: Context, artifactId: string) {
  const [artifact] = await db(c, ctx).select().from(runArtifacts).where(eq(runArtifacts.id, artifactId));
  if (!artifact) return null;
  const feature = await getAccessibleFeature(ctx, c, artifact.featureId);
  return feature ? artifact : null;
}

export async function getAccessibleStage(ctx: AppContext, c: Context, stageId: string) {
  const [row] = await db(c, ctx)
    .select({ stage: stages, projectId: pipelines.projectId })
    .from(stages)
    .innerJoin(pipelines, eq(pipelines.id, stages.pipelineId))
    .where(eq(stages.id, stageId));
  if (!row) return null;
  return (await canAccessProject(ctx, c, row.projectId)) ? row : null;
}
