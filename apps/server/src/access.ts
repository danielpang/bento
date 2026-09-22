import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  agentRuns,
  customModelProviders,
  features,
  member,
  pipelines,
  projects,
  runArtifacts,
  stages,
  swarmTasks,
  swarmTemplates,
  swarms,
} from "@bento/db";
import type { Context } from "hono";
import type { AppContext } from "./context.js";
import { actor, activeOrg } from "./middleware/actor.js";
import { isPipelineRun } from "./orchestrator/pipeline-run.js";
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

/** Re-check live membership before acting on a custom provider id. */
export async function getAccessibleCustomProvider(ctx: AppContext, c: Context, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [provider] = await db(c, ctx).select().from(customModelProviders)
    .where(and(eq(customModelProviders.id, id), isNull(customModelProviders.deletedAt)));
  if (!provider) return null;
  if (ctx.env.BENTO_MODE !== "multi") return provider.ownerId === actor(c) ? provider : null;
  const membership = await getActiveOrganizationMembership(ctx, c);
  return membership?.organizationId === provider.organizationId ? provider : null;
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

/**
 * A card's run. A swarm run answers null here: it has no feature, and
 * the card routes resolve everything through one. Reaching a swarm run
 * is the swarm routes' job, through its own helper.
 */
export async function getAccessibleRun(ctx: AppContext, c: Context, runId: string) {
  const [run] = await db(c, ctx).select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run || !isPipelineRun(run)) return null;
  const feature = await getAccessibleFeature(ctx, c, run.featureId);
  return feature ? { run, feature } : null;
}

/**
 * The same, for an artifact: a swarm's artifact is not a card's.
 *
 * Read off the row's own discriminator rather than off which id
 * happens to be set, the way getAccessibleRun reads a run's. Both
 * halves are checked, for the reason isPipelineRun checks both: the
 * shape constraint makes them agree, and the featureId check is what
 * narrows the type so the caller is handed a card's artifact rather
 * than one that might name no card.
 */
export async function getAccessibleArtifact(ctx: AppContext, c: Context, artifactId: string) {
  const [artifact] = await db(c, ctx).select().from(runArtifacts).where(eq(runArtifacts.id, artifactId));
  if (artifact?.type !== "pipeline" || !artifact.featureId) return null;
  const feature = await getAccessibleFeature(ctx, c, artifact.featureId);
  return feature ? artifact : null;
}

/**
 * A swarm's artifact, which is not a card's.
 *
 * The same rule and the same 404, resolved through the swarm rather
 * than through a feature: authority is the row in Postgres, never the
 * store key, and a swarm reached through its project is how every
 * other swarm route decides who may read it.
 *
 * Separate from getAccessibleArtifact rather than folded into it,
 * because a caller that wants a card's artifact must not be handed a
 * swarm's by a helper that quietly widened: the two are reached from
 * different routes, and the card routes resolve everything through a
 * feature that a swarm's artifact does not have.
 */
export async function getAccessibleSwarmArtifact(ctx: AppContext, c: Context, artifactId: string) {
  const [artifact] = await db(c, ctx).select().from(runArtifacts).where(eq(runArtifacts.id, artifactId));
  if (artifact?.type !== "swarm" || !artifact.swarmId) return null;
  const swarm = await getAccessibleSwarm(ctx, c, artifact.swarmId);
  return swarm ? { artifact, swarm } : null;
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

/**
 * A swarm template, which is owner keyed rather than parented by a
 * project: the same rule canAccessProject applies, read off the
 * template's own row.
 */
export async function getAccessibleSwarmTemplate(ctx: AppContext, c: Context, templateId: string) {
  const [template] = await db(c, ctx).select().from(swarmTemplates).where(eq(swarmTemplates.id, templateId));
  if (!template) return null;
  const userId = actor(c);
  if (ctx.env.BENTO_MODE !== "multi") return template.ownerId === userId ? template : null;
  if (!template.organizationId) return template.ownerId === userId ? template : null;

  const [membership] = await db(c, ctx)
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, template.organizationId)));
  return membership ? template : null;
}

/** A swarm, resolved through the project it belongs to. */
export async function getAccessibleSwarm(ctx: AppContext, c: Context, swarmId: string) {
  const [swarm] = await db(c, ctx).select().from(swarms).where(eq(swarms.id, swarmId));
  if (!swarm) return null;
  return (await canAccessProject(ctx, c, swarm.projectId)) ? swarm : null;
}

/** A task, resolved through its swarm, which is resolved through its project. */
export async function getAccessibleSwarmTask(ctx: AppContext, c: Context, taskId: string) {
  const [row] = await db(c, ctx)
    .select({ task: swarmTasks, projectId: swarms.projectId })
    .from(swarmTasks)
    .innerJoin(swarms, eq(swarms.id, swarmTasks.swarmId))
    .where(eq(swarmTasks.id, taskId));
  if (!row) return null;
  return (await canAccessProject(ctx, c, row.projectId)) ? row : null;
}
