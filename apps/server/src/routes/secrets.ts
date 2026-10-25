import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { AGENT_CREDENTIAL_NAMES } from "@bento/core";
import { secrets, userSecrets } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { maskSecret } from "../secrets.js";
import { getActiveOrganizationMembership } from "../access.js";

const createSecret = z.object({
  name: z.enum(AGENT_CREDENTIAL_NAMES as [string, ...string[]]),
  value: z.string().min(1).max(8192),
  scope: z.enum(["user", "org"]).default("user"),
});

/** Provider keys default to the authenticated person. GitHub remains a team integration. */
export function secretRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const local = ctx.env.BENTO_MODE !== "multi";
      const membership = await getActiveOrganizationMembership(ctx, c);
      const shared = local || membership ? await db(c, ctx).select().from(secrets).where(
        membership ? eq(secrets.organizationId, membership.organizationId) : isNull(secrets.organizationId),
      ) : [];
      const personal = await db(c, ctx).select().from(userSecrets).where(eq(userSecrets.userId, actor(c)));
      const canManageOrg = local || membership?.role === "owner" || membership?.role === "admin";
      const visible = (row: { id: string; name: string; hint: string; createdAt: Date }, scope: "user" | "org") => ({
        id: row.id, name: row.name, hint: row.hint, createdAt: row.createdAt, scope,
      });
      return c.json({
        secrets: [...personal.filter((row) => !row.name.startsWith("custom-provider:")).map((row) => visible(row, "user")), ...shared.map((row) => visible(row, "org"))],
        canManage: canManageOrg, canManagePersonal: true, canManageOrg,
        canShareWithOrg: !local && canManageOrg,
      });
    })
    .post("/", zValidator("json", createSecret), async (c) => {
      const body = c.req.valid("json");
      const scope = body.name === "GITHUB_TOKEN" ? "org" : body.scope;
      if (ctx.env.BENTO_MODE === "multi" && body.name === "CLAUDE_CODE_OAUTH_TOKEN") {
        return c.json({ error: "Subscriptions belong to individuals. Connect your personal account under Agents." }, 400);
      }
      const encrypted = { ciphertext: ctx.secretBox.encrypt(body.value), hint: maskSecret(body.value) };
      if (scope === "user") {
        const [row] = await db(c, ctx).insert(userSecrets).values({ userId: actor(c), name: body.name, ...encrypted })
          .onConflictDoUpdate({ target: [userSecrets.userId, userSecrets.name], set: { ...encrypted, updatedAt: new Date() } }).returning();
        return c.json({ id: row!.id, name: row!.name, hint: row!.hint, scope }, 201);
      }
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi") {
        if (!membership) return c.json({ error: "organization not found" }, 404);
        if (membership.role !== "owner" && membership.role !== "admin") return c.json({ error: "only organization owners and admins can manage shared credentials" }, 403);
      }
      const organizationId = membership?.organizationId ?? null;
      const values = { ownerId: actor(c), organizationId, name: body.name, ...encrypted };
      const update = { ...encrypted, updatedAt: new Date() };
      const [row] = organizationId
        ? await db(c, ctx).insert(secrets).values(values).onConflictDoUpdate({ target: [secrets.organizationId, secrets.name], set: update }).returning()
        : await db(c, ctx).insert(secrets).values(values).onConflictDoUpdate({ target: secrets.name, targetWhere: isNull(secrets.organizationId), set: update }).returning();
      return c.json({ id: row!.id, name: row!.name, hint: row!.hint, scope }, 201);
    })
    .delete("/:id", async (c) => {
      const [own] = await db(c, ctx).delete(userSecrets).where(and(eq(userSecrets.id, c.req.param("id")), eq(userSecrets.userId, actor(c)))).returning({ id: userSecrets.id });
      if (own) return c.json({ ok: true });
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi") {
        if (!membership) return c.json({ error: "not found" }, 404);
        if (membership.role !== "owner" && membership.role !== "admin") return c.json({ error: "only organization owners and admins can manage shared credentials" }, 403);
      }
      await db(c, ctx).delete(secrets).where(and(eq(secrets.id, c.req.param("id")),
        membership ? eq(secrets.organizationId, membership.organizationId) : isNull(secrets.organizationId)));
      return c.json({ ok: true });
    });
}
