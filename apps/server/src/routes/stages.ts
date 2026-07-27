import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { gateCriteria, gateType } from "@bento/core";
import { agentProfiles, features, pipelines, stages } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { canAccessProject, getAccessibleStage } from "../access.js";

const createStage = z.object({
  pipelineId: z.string().uuid(),
  name: z.string().min(1).max(80),
});

/** stages_pipeline_slug_idx wants uniqueness; the name drives the slug. */
function stageSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40) || "stage"
  );
}

/**
 * Stage configuration is where the user answers the two core questions:
 * which agent runs this step, and what must be true before the card
 * moves on.
 */
const updateStage = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  /** The agent profile that runs automatically when a card enters this stage. */
  defaultAgentProfileId: z.string().uuid().nullable().optional(),
  gateType: gateType.optional(),
  gateCriteria: gateCriteria.optional(),
  /** Push the branch and open the pull request when a run here succeeds. */
  createPr: z.boolean().optional(),
});

export function stageRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * Appends a stage to a pipeline. New stages start manual with no
     * agent: nothing should run or advance on its own before the user
     * has said what the stage is for.
     */
    .post("/", zValidator("json", createStage), async (c) => {
      const body = c.req.valid("json");
      const [pipeline] = await db(c, ctx).select().from(pipelines).where(eq(pipelines.id, body.pipelineId)).limit(1);
      if (!pipeline || !(await canAccessProject(ctx, c, pipeline.projectId))) {
        return c.json({ error: "not found" }, 404);
      }
      const [last] = await db(c, ctx)
        .select({ max: sql<number>`coalesce(max(position), -1)` })
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id));
      const slugBase = stageSlug(body.name);
      const existing = await db(c, ctx)
        .select({ slug: stages.slug })
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id));
      const taken = new Set(existing.map((row) => row.slug));
      let slug = slugBase;
      for (let n = 2; taken.has(slug); n++) slug = `${slugBase}-${n}`;
      const [created] = await db(c, ctx)
        .insert(stages)
        .values({
          pipelineId: pipeline.id,
          position: (last?.max ?? -1) + 1,
          name: body.name,
          slug,
          description: "",
          gateType: "manual",
          gateCriteria: [],
        })
        .returning();
      if (!created) return c.json({ error: "something went wrong saving the stage; try again" }, 500);
      return c.json(created, 201);
    })
    /**
     * Reorders a pipeline's stages.
     *
     * The whole order arrives at once rather than one stage's new
     * position: positions have to stay unique and contiguous, and a
     * client sending "this one is now third" leaves the server guessing
     * what happened to the one that was third. Sending the sequence
     * makes the request the answer.
     *
     * Cards keep the stage they are in. What changes is what comes next
     * for them, which is the point of reordering and not something to
     * protect anyone from.
     */
    .post(
      "/reorder",
      zValidator("json", z.object({ pipelineId: z.string().uuid(), stageIds: z.array(z.string().uuid()).min(1) })),
      async (c) => {
        const { pipelineId, stageIds } = c.req.valid("json");
        const [pipeline] = await db(c, ctx).select().from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
        if (!pipeline || !(await canAccessProject(ctx, c, pipeline.projectId))) {
          return c.json({ error: "not found" }, 404);
        }
        const current = await db(c, ctx)
          .select({ id: stages.id })
          .from(stages)
          .where(eq(stages.pipelineId, pipelineId));
        // Every stage, exactly once. A partial list would leave the
        // stages it omitted holding positions this one is handing out.
        const known = new Set(current.map((row) => row.id));
        const wanted = new Set(stageIds);
        if (wanted.size !== stageIds.length || wanted.size !== known.size || stageIds.some((id) => !known.has(id))) {
          return c.json({ error: "send every stage of this pipeline exactly once" }, 400);
        }
        for (const [position, id] of stageIds.entries()) {
          await db(c, ctx)
            .update(stages)
            .set({ position, updatedAt: new Date() })
            .where(and(eq(stages.id, id), eq(stages.pipelineId, pipelineId)));
        }
        return c.json({ stageIds });
      },
    )
    /**
     * Removes a stage. Refused while any card is in it: silently
     * relocating live work is how boards lose things. History that
     * references the stage keeps its id; renderers already show
     * "a removed stage" for those.
     */
    .delete("/:id", async (c) => {
      const found = await getAccessibleStage(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const [occupied] = await db(c, ctx)
        .select({ n: sql<number>`count(*)` })
        .from(features)
        .where(and(eq(features.currentStageId, found.stage.id)));
      if (Number(occupied?.n ?? 0) > 0) {
        return c.json({ error: "cards are in this stage; move them first, then remove it" }, 409);
      }
      await db(c, ctx).delete(stages).where(eq(stages.id, found.stage.id));
      return c.json({ ok: true });
    })
    .get("/:id", async (c) => {
      const found = await getAccessibleStage(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      return c.json(found.stage);
    })
    /**
     * gateCriteria can carry a command the server executes in this
     * project's sandbox, so editing a stage requires project access
     * exactly like running an agent does.
     */
    .patch("/:id", zValidator("json", updateStage), async (c) => {
      const found = await getAccessibleStage(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const body = c.req.valid("json");
      if (body.defaultAgentProfileId) {
        const [profile] = await db(c, ctx)
          .select({ organizationId: agentProfiles.organizationId })
          .from(agentProfiles)
          .where(eq(agentProfiles.id, body.defaultAgentProfileId))
          .limit(1);
        if (!profile || profile.organizationId !== found.stage.organizationId) {
          return c.json({ error: "agent profile not found" }, 404);
        }
      }
      // A judge inside the criteria is an agent reference like the
      // default profile is, and crossing a tenant with one would let a
      // foreign profile run in this organization's sandbox.
      for (const criterion of body.gateCriteria ?? []) {
        if (criterion.type !== "agent_judge") continue;
        const [judge] = await db(c, ctx)
          .select({ organizationId: agentProfiles.organizationId })
          .from(agentProfiles)
          .where(eq(agentProfiles.id, criterion.agentProfileId))
          .limit(1);
        if (!judge || judge.organizationId !== found.stage.organizationId) {
          return c.json({ error: "agent profile not found" }, 404);
        }
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.defaultAgentProfileId !== undefined) patch.defaultAgentProfileId = body.defaultAgentProfileId;
      if (body.gateType !== undefined) patch.gateType = body.gateType;
      if (body.gateCriteria !== undefined) patch.gateCriteria = body.gateCriteria;
      if (body.createPr !== undefined) patch.createPr = body.createPr;

      const [updated] = await db(c, ctx).update(stages).set(patch).where(eq(stages.id, c.req.param("id"))).returning();
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json(updated);
    });
}
