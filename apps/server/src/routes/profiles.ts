import { zValidator } from "@hono/zod-validator";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { MODEL_GUIDANCE, agentCli, checkAgentPairing, providerForProfile } from "@bento/core";
import { agentProfiles, agentRuns, stages } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";

/**
 * The probe is a container start, so its answer is held briefly rather
 * than repeated per keystroke. Short enough that installing a tool and
 * reopening the form tells the truth.
 */
const TOOL_CACHE_MS = 60_000;
let toolCache: { at: number; value: Record<string, boolean> | null } | null = null;

async function toolAvailability(
  ctx: AppContext,
  binaries: string[],
): Promise<Record<string, boolean> | null> {
  if (toolCache && Date.now() - toolCache.at < TOOL_CACHE_MS) return toolCache.value;
  // A driver with no opinion (a runner's machine is not this one) leaves
  // the question open rather than guessing.
  const value = ctx.driver.checkTools
    ? await ctx.driver.checkTools(binaries, ctx.env.BENTO_SANDBOX_IMAGE).catch(() => null)
    : null;
  toolCache = { at: Date.now(), value };
  return value;
}

const createProfile = z.object({
  name: z.string().min(1),
  cli: agentCli,
  model: z.string().min(1),
  extraArgs: z.array(z.string()).default([]),
  /** Operating instructions fed into every stage prompt this agent runs. */
  skill: z.string().max(20000).optional(),
});

/**
 * Every field is optional, so renaming an agent does not require
 * restating which model it runs. No default on extraArgs either: the
 * create schema defaults it to empty, which here would silently clear
 * the flags of anyone who only meant to rename.
 */
const updateProfile = z
  .object({
    name: z.string().min(1).optional(),
    cli: agentCli.optional(),
    model: z.string().min(1).optional(),
    extraArgs: z.array(z.string()).optional(),
    // Nullable so a skill can be cleared, not only replaced.
    skill: z.string().max(20000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });

export function profileRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const rows = await db(c, ctx).select().from(agentProfiles).where(eq(agentProfiles.ownerId, actor(c)));
      return c.json(rows);
    })
    /**
     * Which coding agents this deployment can actually start, so the
     * form that picks one can say "not installed here" before a run
     * says it half an hour later.
     *
     * The probe asks the sandbox, not the server: agents run inside the
     * image or the sprite, so what the server's own machine happens to
     * have is beside the point. `installed: null` means the question
     * could not be answered (no image built, daemon unreachable), which
     * is not the same as "no" and is never shown as one.
     *
     * Cached for a minute. It costs a throwaway container per call, and
     * a form that re-renders should not start one each time.
     */
    .get("/tools", async (c) => {
      const tools = MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake");
      const available = await toolAvailability(ctx, tools.map((tool) => tool.binary));
      return c.json(
        tools.map((tool) => ({
          cli: tool.cli,
          label: tool.label,
          binary: tool.binary,
          installed: available ? (available[tool.binary] ?? false) : null,
          installUrl: tool.installUrl,
          installCommand: tool.installCommand,
        })),
      );
    })
    /**
     * Line format:
     *   profile|<id>|<cli>|<model>|<providerId or ->|<pairing>|<name>
     *
     * The provider and the pairing verdict are resolved here rather than
     * by the client: both are catalog knowledge, and the desktop app
     * cannot import the catalog. A dash means no provider applies, which
     * is the fake agent.
     *
     * The verdict is carried for agents that already exist. New ones
     * cannot be impossible, because this route refuses them, but rows
     * stored before that check, or reached through another client, still
     * can be, and a routed pairing is worth flagging either way.
     */
    .get("/plain", async (c) => {
      const rows = await db(c, ctx).select().from(agentProfiles).where(eq(agentProfiles.ownerId, actor(c)));
      return c.text(
        rows
          .map((p) => {
            const provider = providerForProfile(p.cli, p.model);
            const pairing = checkAgentPairing(p.cli, p.model);
            return `profile|${p.id}|${p.cli}|${p.model}|${provider?.id ?? "-"}|${pairing.status}|${p.name}`;
          })
          .join("\n"),
      );
    })
    /**
     * Refuses a pairing the tool cannot run.
     *
     * Choosing the tool first narrows the models on offer, which is what
     * normally prevents this. The check is here because two paths skip
     * that: a model typed by hand, and the API. Without it an impossible
     * pairing is stored, assigned to a stage, and only fails once a
     * sandbox has started and a run is already underway.
     *
     * Only the provably impossible is refused. A model the catalog does
     * not carry is allowed through: the snapshot trails the tools, and
     * refusing a model released last week would be worse than the run
     * failing.
     */
    .post("/", zValidator("json", createProfile), async (c) => {
      const body = c.req.valid("json");
      const pairing = checkAgentPairing(body.cli, body.model);
      if (pairing.status === "impossible") {
        return c.json({ error: pairing.detail, cli: body.cli, model: body.model }, 400);
      }
      const [profile] = await db(c, ctx)
        .insert(agentProfiles)
        .values({ ownerId: actor(c), ...body })
        .returning();
      if (!profile) return c.json({ error: "something went wrong saving the agent; try again" }, 500);
      return c.json(profile, 201);
    })
    /**
     * Changes an existing agent, one field or all of them.
     *
     * The pairing is checked against the merged row rather than the
     * body: changing only the model would otherwise skip the check
     * entirely, and it is exactly the field most likely to break the
     * pairing. Stages keep pointing at this agent through its id, so
     * editing one re-points every stage using it, which is the reason
     * to edit rather than replace.
     */
    .patch("/:id", zValidator("json", updateProfile), async (c) => {
      const body = c.req.valid("json");
      const [existing] = await db(c, ctx)
        .select()
        .from(agentProfiles)
        .where(and(eq(agentProfiles.id, c.req.param("id")), eq(agentProfiles.ownerId, actor(c))));
      // 404 rather than 403, so a probe cannot learn whether an id exists.
      if (!existing) return c.json({ error: "not found" }, 404);

      const cli = body.cli ?? existing.cli;
      const model = body.model ?? existing.model;
      const pairing = checkAgentPairing(cli, model);
      if (pairing.status === "impossible") {
        return c.json({ error: pairing.detail, cli, model }, 400);
      }

      const [updated] = await db(c, ctx)
        .update(agentProfiles)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(agentProfiles.id, c.req.param("id")), eq(agentProfiles.ownerId, actor(c))))
        .returning();
      return c.json(updated);
    })
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      /**
       * Whose it is, before anything else is asked about it. Counting
       * the runs first answered 409 to a stranger, which tells them the
       * id exists and that it has history: the same leak 404-not-403 is
       * there to prevent.
       */
      const [owned] = await db(c, ctx)
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(and(eq(agentProfiles.id, id), eq(agentProfiles.ownerId, actor(c))))
        .limit(1);
      if (!owned) return c.json({ error: "not found" }, 404);

      // The stages pointing at it are released, which is what the
      // confirmation has always promised: "stages assigned to it are
      // left with no agent". Without this the delete hit that foreign
      // key and answered 500, so the promise was never kept.
      await db(c, ctx)
        .update(stages)
        .set({ defaultAgentProfileId: null, updatedAt: new Date() })
        .where(eq(stages.defaultAgentProfileId, id));

      /**
       * Counted before the delete, purely to say what was taken. The
       * runs go with the agent (the foreign key cascades, and their
       * transcripts cascade from there), so the number is only
       * recoverable now.
       */
      const [used] = await db(c, ctx)
        .select({ runs: count(agentRuns.id) })
        .from(agentRuns)
        .where(eq(agentRuns.agentProfileId, id));

      const deleted = await db(c, ctx)
        .delete(agentProfiles)
        .where(and(eq(agentProfiles.id, id), eq(agentProfiles.ownerId, actor(c))))
        .returning();
      // Reporting success for a row that was never touched said the same
      // thing to "deleted it" and to "that is not yours".
      if (deleted.length === 0) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true, deletedRuns: Number(used?.runs ?? 0) });
    });
}
