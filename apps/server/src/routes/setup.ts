import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { checkAgentPairing, defaultPipelineSeed, pipelineSeed, type PipelineSeed } from "@bento/core";
import { agentProfiles, ensureSeedAgents, organizationPolicies, projects } from "@bento/db";
import type { AppContext } from "../context.js";
import { getActiveOrganizationMembership } from "../access.js";
import { actor } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { readSettings, writeSettings } from "../settings.js";

const body = z.union([
  z.object({ mode: z.literal("skip") }),
  z.object({ mode: z.literal("defaults") }),
  z.intersection(z.object({ mode: z.literal("custom") }), pipelineSeed),
]);

/**
 * Whether a role may run organization setup.
 *
 * Same rule as the policy patch: owner or admin. Roles can arrive as a
 * comma separated string, so this parses the way Team settings does.
 */
function canManage(role: string): boolean {
  const roles = role.split(",").map((part) => part.trim());
  return roles.includes("owner") || roles.includes("admin");
}

function seedFrom(input: z.infer<typeof body>): PipelineSeed | null {
  if (input.mode === "skip") return null;
  if (input.mode === "defaults") return defaultPipelineSeed();
  const { mode: _mode, ...seed } = input;
  return seed;
}

/**
 * First-run setup for a team: the pipeline and the agents that run it.
 *
 * A new organization has nowhere to work until both exist. This is the
 * write that used to hide inside the first project create. Putting it
 * here means a person can take Bento's defaults or change them before
 * any board exists, and every later project inherits the choice.
 */
export function setupRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      if (ctx.env.BENTO_MODE !== "multi") {
        const settings = await readSettings(ctx);
        const empty = await workspaceIsEmpty(ctx, c, null);
        return c.json({
          needed: !settings.setupCompleted && empty,
          canEdit: true,
        });
      }
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);
      const editable = canManage(membership.role);
      const [row] = await db(c, ctx)
        .select({ setupCompletedAt: organizationPolicies.setupCompletedAt })
        .from(organizationPolicies)
        .where(eq(organizationPolicies.organizationId, membership.organizationId))
        .limit(1);
      const empty = await workspaceIsEmpty(ctx, c, membership.organizationId);
      return c.json({
        needed: editable && !row?.setupCompletedAt && empty,
        canEdit: editable,
      });
    })
    .post("/", zValidator("json", body), async (c) => {
      const input = c.req.valid("json");
      const seed = seedFrom(input);
      if (seed) {
        const refused = pairingError(seed.agents);
        if (refused) return c.json({ error: refused }, 400);
      }

      if (ctx.env.BENTO_MODE !== "multi") {
        if (seed) {
          await ensureSeedAgents(db(c, ctx), { ownerId: actor(c), organizationId: null }, seed.agents);
        }
        const settings = await readSettings(ctx);
        await writeSettings(ctx, { ...settings, setupCompleted: true, pipelineSeed: seed });
        return c.json({ ok: true });
      }

      const membership = await getActiveOrganizationMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);
      if (!canManage(membership.role)) {
        return c.json({ error: "only organization owners and admins can change this" }, 403);
      }
      if (seed) {
        await ensureSeedAgents(
          db(c, ctx),
          { ownerId: actor(c), organizationId: membership.organizationId },
          seed.agents,
        );
      }
      await db(c, ctx)
        .insert(organizationPolicies)
        .values({
          organizationId: membership.organizationId,
          pipelineSeed: seed,
          setupCompletedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: organizationPolicies.organizationId,
          set: { pipelineSeed: seed, setupCompletedAt: new Date(), updatedAt: new Date() },
        });
      return c.json({ ok: true });
    });
}

function pairingError(agents: PipelineSeed["agents"]): string | null {
  for (const agent of agents) {
    const pairing = checkAgentPairing(agent.cli, agent.model);
    if (pairing.status === "impossible") return `${agent.name}: ${pairing.detail}`;
  }
  return null;
}

async function workspaceIsEmpty(ctx: AppContext, c: Context, organizationId: string | null): Promise<boolean> {
  const handle = db(c, ctx);
  const [projectRow] = await handle.select({ n: count() }).from(projects);
  const [agentRow] = organizationId
    ? await handle.select({ n: count() }).from(agentProfiles).where(eq(agentProfiles.organizationId, organizationId))
    : await handle.select({ n: count() }).from(agentProfiles).where(eq(agentProfiles.ownerId, actor(c)));
  return Number(projectRow?.n ?? 0) === 0 && Number(agentRow?.n ?? 0) === 0;
}
