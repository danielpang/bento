import { and, eq, sql } from "drizzle-orm";
import { ensureSwarmAgents, swarmTemplates } from "@bento/db";
import type { AppContext } from "../../context.js";
import { actor } from "../../middleware/actor.js";
import { tenantDb as db } from "../../middleware/tenant.js";

/**
 * The template a swarm uses when nobody has chosen one, made the first
 * time anybody looks for it.
 *
 * Seeded rather than left absent, and seeded on the way in rather than
 * only when a swarm is created, because the console cannot draw the
 * New swarm dialog without one: the dialog reads its ceilings off a
 * template, and with no template it disabled its own Create button and
 * said nothing about why. A fresh install could then never make a
 * swarm, because the only thing that used to create this row was
 * creating a swarm.
 *
 * Named rather than flagged, and matched by that name, so calling it
 * twice makes one row. A person who does not want it can rename it,
 * edit it, or delete it once they have one of their own, the same as
 * any other template.
 */
export async function ensureDefaultSwarmTemplate(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  organizationId: string | null,
) {
  const owner = { ownerId: actor(c), organizationId: ctx.env.BENTO_MODE === "multi" ? organizationId : null };
  const [existing] = await db(c, ctx)
    .select()
    .from(swarmTemplates)
    .where(
      and(
        eq(swarmTemplates.ownerId, owner.ownerId),
        organizationId && ctx.env.BENTO_MODE === "multi"
          ? eq(swarmTemplates.organizationId, organizationId)
          : sql`${swarmTemplates.organizationId} is null`,
        eq(swarmTemplates.name, "Default"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const agents = await ensureSwarmAgents(db(c, ctx), owner);
  const [created] = await db(c, ctx)
    .insert(swarmTemplates)
    .values({
      ownerId: owner.ownerId,
      organizationId: owner.organizationId,
      name: "Default",
      description: "The planner and worker a swarm uses when nobody has chosen others.",
      plannerProfileId: agents.planner,
      workerProfileId: agents.worker,
      /**
       * Two at once on a local install, four on a hosted one.
       *
       * A hosted worker is its own machine, so four of them cost four
       * machines and nothing of the person's laptop. A local worker is
       * a worktree and a container on the machine somebody is also
       * using: four agents each running the repository's test command
       * is four builds competing for the same cores, and the install
       * that is meant to be watched becomes the one nobody can type on.
       *
       * Written onto the template rather than read from the mode at
       * spawn time, so an install that later joins a team keeps the
       * shape its swarms already had, and so a person who wants four
       * can simply set four. A number nobody can see and nobody can
       * change is not a default, it is a rule.
       */
      maxWorkers: ctx.env.BENTO_MODE === "multi" ? 4 : 2,
      /**
       * And where those workers work, written down for the same
       * reason the number is.
       *
       * A local install's agents share the repository it already has
       * on disk, each in a worktree of its own; a hosted one gives
       * each agent a machine holding its own clone. Recorded rather
       * than read off the driver every time, so an install that later
       * joins a team is told its swarms cannot keep their shape
       * instead of quietly being given another one.
       */
      workerIsolation: ctx.env.BENTO_MODE === "multi" ? "sandbox" : "worktree",
    })
    .returning();
  return created ?? null;
}
