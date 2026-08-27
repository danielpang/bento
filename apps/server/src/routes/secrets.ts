import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AGENT_CREDENTIAL_NAMES } from "@bento/core";
import { secrets } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { maskSecret } from "../secrets.js";
import { getActiveOrganizationMembership } from "../access.js";

const createSecret = z.object({
  /** Environment variable name the agent expects, e.g. ANTHROPIC_API_KEY. */
  // Restricted to the catalog: an arbitrary name would be stored but
  // never forwarded, which looks like it worked and silently does not.
  name: z.enum(AGENT_CREDENTIAL_NAMES as [string, ...string[]]),
  value: z.string().min(1).max(8192),
});

/**
 * Agent credentials, owned by an organization.
 *
 * Values are write-only: no route returns plaintext, and the list shows
 * a masked hint instead. This is what lets a hosted deployment run
 * agents without putting the operator's own API key inside every
 * tenant's sandbox.
 */
export function secretRoutes(ctx: AppContext) {
  /**
   * Resolves the scope from live membership, not only the session. A
   * removed member can retain a stale active organization in a session.
   */
  const scope = async (c: Context) => {
    if (ctx.env.BENTO_MODE !== "multi") {
      return { organizationId: null, where: isNull(secrets.organizationId), role: "owner" };
    }
    const membership = await getActiveOrganizationMembership(ctx, c);
    if (!membership) return null;
    return {
      organizationId: membership.organizationId,
      where: eq(secrets.organizationId, membership.organizationId),
      role: membership.role,
    };
  };

  return new Hono()
    .get("/", async (c) => {
      const resolved = await scope(c);
      if (!resolved) return c.json({ secrets: [], canManage: false });
      const rows = await db(c, ctx).select().from(secrets).where(resolved.where);
      return c.json({
        secrets: rows.map((row) => ({
          id: row.id,
          name: row.name,
          hint: row.hint,
          createdAt: row.createdAt,
        })),
        canManage: resolved.role === "owner" || resolved.role === "admin",
      });
    })
    /**
     * Line format: secret|<id>|<name>|<hint>
     * The hint is the same mask the console shows. No route anywhere
     * returns plaintext, and this one is no exception.
     */
    .get("/plain", async (c) => {
      const resolved = await scope(c);
      if (!resolved) return c.text("");
      const rows = await db(c, ctx).select().from(secrets).where(resolved.where);
      return c.text(rows.map((row) => `secret|${row.id}|${row.name}|${row.hint}`).join("\n"));
    })
    .post("/", zValidator("json", createSecret), async (c) => {
      if (ctx.env.BENTO_MODE === "multi" && !activeOrg(c)) {
        return c.json({ error: "choose an organization before adding secrets" }, 400);
      }
      const resolved = await scope(c);
      if (!resolved) return c.json({ error: "organization not found" }, 404);
      if (resolved.role !== "owner" && resolved.role !== "admin") {
        return c.json({ error: "only organization owners and admins can manage credentials" }, 403);
      }
      const body = c.req.valid("json");
      const values = {
        ownerId: actor(c),
        organizationId: resolved.organizationId,
        name: body.name,
        ciphertext: ctx.secretBox.encrypt(body.value),
        hint: maskSecret(body.value),
      };
      const update = {
        ciphertext: ctx.secretBox.encrypt(body.value),
        hint: maskSecret(body.value),
        updatedAt: new Date(),
      };
      // PostgreSQL treats nulls as distinct in a normal composite unique
      // index. Local mode therefore targets its partial name-only index,
      // while organization credentials target the composite index.
      const rows = resolved.organizationId
        ? await db(c, ctx).insert(secrets).values(values).onConflictDoUpdate({
          target: [secrets.organizationId, secrets.name],
          set: update,
        }).returning()
        : await db(c, ctx).insert(secrets).values(values).onConflictDoUpdate({
          target: secrets.name,
          targetWhere: isNull(secrets.organizationId),
          set: update,
        }).returning();
      const [row] = rows;
      if (!row) return c.json({ error: "something went wrong saving the key; try again" }, 500);
      return c.json({ id: row.id, name: row.name, hint: row.hint }, 201);
    })
    .delete("/:id", async (c) => {
      const resolved = await scope(c);
      if (!resolved) return c.json({ error: "not found" }, 404);
      if (resolved.role !== "owner" && resolved.role !== "admin") {
        return c.json({ error: "only organization owners and admins can manage credentials" }, 403);
      }
      await db(c, ctx).delete(secrets).where(and(eq(secrets.id, c.req.param("id")), resolved.where));
      return c.json({ ok: true });
    });
}
