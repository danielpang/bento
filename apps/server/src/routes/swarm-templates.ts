import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agentProfiles, ensureSwarmAgents, member, swarmTemplates } from "@bento/db";
import { getAccessibleSwarmTemplate, getActiveOrganizationMembership } from "../access.js";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { requireSwarms } from "../orchestrator/swarm/gate.js";

/**
 * Swarm templates: one team's way of running a swarm, saved.
 *
 * Owner keyed rather than parented by a project, like agent profiles
 * and MCP servers, so a team does not re-enter who plans and who works
 * for every project. That also means there is no parent row to inherit
 * an organization from, so these routes set organization_id explicitly
 * and row-level security then checks what they set.
 */

const ceilings = {
  maxWorkers: z.number().int().min(1).max(32),
  budgetUsd: z.number().min(0).max(100_000),
  timeLimitMin: z.number().int().min(1).max(60 * 24 * 7),
};

const createTemplate = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  plannerProfileId: z.string().uuid().nullish(),
  workerProfileId: z.string().uuid().nullish(),
  plannerInstructions: z.string().max(20_000).nullish(),
  workerInstructions: z.string().max(20_000).nullish(),
  maxWorkers: ceilings.maxWorkers.default(4),
  budgetUsd: ceilings.budgetUsd.nullish(),
  timeLimitMin: ceilings.timeLimitMin.nullish(),
});

/**
 * Every field optional, so renaming a template does not require
 * restating its ceilings. Nullable where a value can be cleared: a
 * budget removed is not the same as a budget of zero.
 */
const updateTemplate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(4000).optional(),
    plannerProfileId: z.string().uuid().nullable().optional(),
    workerProfileId: z.string().uuid().nullable().optional(),
    plannerInstructions: z.string().max(20_000).nullable().optional(),
    workerInstructions: z.string().max(20_000).nullable().optional(),
    maxWorkers: ceilings.maxWorkers.optional(),
    budgetUsd: ceilings.budgetUsd.nullable().optional(),
    timeLimitMin: ceilings.timeLimitMin.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "nothing to change" });

/** Templates read alphabetically, for the same reason agents do. */
const byName = [sql`lower(${swarmTemplates.name})`, asc(swarmTemplates.id)];

/** Which templates the caller may see, as a WHERE clause. */
async function visibleTemplateFilter(ctx: AppContext, c: Parameters<typeof actor>[0]): Promise<SQL | undefined> {
  const userId = actor(c);
  if (ctx.env.BENTO_MODE !== "multi") return eq(swarmTemplates.ownerId, userId);
  const memberships = await db(c, ctx)
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const orgIds = memberships.map((m) => m.organizationId);
  const ownOnly = and(eq(swarmTemplates.ownerId, userId), isNull(swarmTemplates.organizationId));
  if (orgIds.length === 0) return ownOnly;
  return or(ownOnly, inArray(swarmTemplates.organizationId, orgIds));
}

export function swarmTemplateRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const rows = await db(c, ctx)
        .select()
        .from(swarmTemplates)
        .where(await visibleTemplateFilter(ctx, c))
        .orderBy(...byName);
      return c.json(rows);
    })
    /**
     * Creates a template, seeding the planner and worker agents when
     * the caller did not name any.
     *
     * Seeded rather than left empty for the reason the default pipeline
     * seeds its stage agents: a template with no planner cannot start
     * anything, and the first thing everybody would otherwise do is
     * invent two agents before they could watch a swarm run at all.
     */
    .post("/", zValidator("json", createTemplate), async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const body = c.req.valid("json");
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi" && activeOrg(c) && !membership) {
        return c.json({ error: "not found" }, 404);
      }
      const organizationId = ctx.env.BENTO_MODE === "multi" ? (membership?.organizationId ?? null) : null;

      // An agent named here has to be one the caller may actually use;
      // otherwise a template would be a way to run somebody else's.
      for (const profileId of [body.plannerProfileId, body.workerProfileId]) {
        if (!profileId) continue;
        if (!(await ownsProfile(ctx, c, profileId))) return c.json({ error: "agent not found" }, 404);
      }

      const seeded =
        body.plannerProfileId && body.workerProfileId
          ? { planner: body.plannerProfileId, worker: body.workerProfileId }
          : await ensureSwarmAgents(db(c, ctx), { ownerId: actor(c), organizationId });

      const [template] = await db(c, ctx)
        .insert(swarmTemplates)
        .values({
          ownerId: actor(c),
          organizationId,
          name: body.name,
          description: body.description,
          plannerProfileId: body.plannerProfileId ?? seeded.planner,
          workerProfileId: body.workerProfileId ?? seeded.worker,
          plannerInstructions: body.plannerInstructions ?? null,
          workerInstructions: body.workerInstructions ?? null,
          maxWorkers: body.maxWorkers,
          budgetUsd: body.budgetUsd === null || body.budgetUsd === undefined ? null : String(body.budgetUsd),
          timeLimitMin: body.timeLimitMin ?? null,
        })
        .returning();
      if (!template) return c.json({ error: "something went wrong saving the template; try again" }, 500);
      return c.json(template, 201);
    })
    .get("/:id", async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const template = await getAccessibleSwarmTemplate(ctx, c, c.req.param("id"));
      if (!template) return c.json({ error: "not found" }, 404);
      return c.json(template);
    })
    .patch("/:id", zValidator("json", updateTemplate), async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const template = await getAccessibleSwarmTemplate(ctx, c, c.req.param("id"));
      if (!template) return c.json({ error: "not found" }, 404);
      const body = c.req.valid("json");
      for (const profileId of [body.plannerProfileId, body.workerProfileId]) {
        if (!profileId) continue;
        if (!(await ownsProfile(ctx, c, profileId))) return c.json({ error: "agent not found" }, 404);
      }
      const { budgetUsd, ...rest } = body;
      const [updated] = await db(c, ctx)
        .update(swarmTemplates)
        .set({
          ...rest,
          // numeric columns take strings; undefined leaves the value
          // alone and null clears it, which are different answers.
          ...(budgetUsd === undefined ? {} : { budgetUsd: budgetUsd === null ? null : String(budgetUsd) }),
          updatedAt: new Date(),
        })
        .where(eq(swarmTemplates.id, template.id))
        .returning();
      return c.json(updated);
    })
    /**
     * Deletes a template. Swarms started from it keep running: the
     * reference is nulled rather than cascaded, because a template is
     * attribution once a swarm exists, not a dependency.
     */
    .delete("/:id", async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const template = await getAccessibleSwarmTemplate(ctx, c, c.req.param("id"));
      if (!template) return c.json({ error: "not found" }, 404);
      await db(c, ctx).delete(swarmTemplates).where(eq(swarmTemplates.id, template.id));
      return c.json({ ok: true });
    });
}

/** Whether this agent profile is one the caller may run. */
async function ownsProfile(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  profileId: string,
): Promise<boolean> {
  const [profile] = await db(c, ctx)
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.id, profileId))
    .limit(1);
  if (!profile) return false;
  if (ctx.env.BENTO_MODE !== "multi") return profile.ownerId === actor(c);
  if (!profile.organizationId) return profile.ownerId === actor(c);
  const [membership] = await db(c, ctx)
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, actor(c)), eq(member.organizationId, profile.organizationId)))
    .limit(1);
  return Boolean(membership);
}
