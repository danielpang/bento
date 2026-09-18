import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { CUSTOM_PROVIDER_PROTOCOLS, MODEL_CATALOG } from "@bento/core";
import { customModelProviders } from "@bento/db";
import { getAccessibleCustomProvider, getActiveOrganizationMembership } from "../access.js";
import type { AppContext } from "../context.js";
import { getBetaTester } from "../feature-flags.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { maskSecret } from "../secrets.js";

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "Use 2 to 40 lowercase letters, numbers, or hyphens");
const model = z.object({ id: z.string().min(1).max(160).regex(/^\S+$/, "Model ID cannot contain spaces"), name: z.string().min(1).max(160) });
const providerInput = z.object({
  slug,
  name: z.string().min(1).max(100),
  protocol: z.enum(CUSTOM_PROVIDER_PROTOCOLS),
  baseUrl: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTP or HTTPS base URL without credentials or query parameters"),
  models: z.array(model).min(1).max(100).refine((models) => new Set(models.map((m) => m.id)).size === models.length, "Model IDs must be unique"),
});
const keyInput = z.object({ apiKey: z.string().min(1).max(8192) });
const reservedSlug = (value: string) => MODEL_CATALOG.some((provider) =>
  provider.id === value || provider.models.some((entry) => entry.id.startsWith(`${value}/`)));

function publicProvider(row: typeof customModelProviders.$inferSelect) {
  const { encryptedApiKey: _key, deletedAt: _deletedAt, ...safe } = row;
  return { ...safe, hasApiKey: Boolean(row.encryptedApiKey) };
}

export function customProviderRoutes(ctx: AppContext) {
  const scope = async (c: Context) => {
    if (!(await getBetaTester(ctx, c))) return null;
    if (ctx.env.BENTO_MODE !== "multi") return { orgId: null, where: isNull(customModelProviders.organizationId), canManage: true };
    if (!activeOrg(c)) return null;
    const membership = await getActiveOrganizationMembership(ctx, c);
    if (!membership) return null;
    return {
      orgId: membership.organizationId,
      where: eq(customModelProviders.organizationId, membership.organizationId),
      canManage: membership.role === "owner" || membership.role === "admin",
    };
  };
  const accessible = async (c: Context) => {
    const permission = await scope(c);
    if (!permission) return null;
    const provider = await getAccessibleCustomProvider(ctx, c, c.req.param("id") ?? "");
    return provider ? { permission, provider } : null;
  };

  return new Hono()
    .get("/", async (c) => {
      const permission = await scope(c);
      if (!permission) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx).select().from(customModelProviders).where(and(permission.where, isNull(customModelProviders.deletedAt)));
      return c.json({ providers: rows.map(publicProvider), canManage: permission.canManage });
    })
    .post("/", zValidator("json", providerInput), async (c) => {
      const permission = await scope(c);
      if (!permission) return c.json({ error: "not found" }, 404);
      if (!permission.canManage) return c.json({ error: "only owners and admins can manage providers" }, 403);
      const body = c.req.valid("json");
      if (reservedSlug(body.slug)) return c.json({ error: "provider ID is reserved" }, 409);
      const [duplicate] = await db(c, ctx).select({ id: customModelProviders.id, deletedAt: customModelProviders.deletedAt }).from(customModelProviders)
        .where(and(permission.where, eq(customModelProviders.slug, body.slug)));
      if (duplicate) return c.json({ error: duplicate.deletedAt
        ? "provider ID was removed and cannot be reused"
        : "provider ID is already in use" }, 409);
      const [created] = await db(c, ctx).insert(customModelProviders).values({
        ...body, ownerId: actor(c), organizationId: permission.orgId,
      }).onConflictDoNothing().returning();
      if (!created) return c.json({ error: "provider ID is already in use" }, 409);
      return c.json(publicProvider(created!), 201);
    })
    .get("/:id", async (c) => {
      const found = await accessible(c);
      return found ? c.json(publicProvider(found.provider)) : c.json({ error: "not found" }, 404);
    })
    .put("/:id", zValidator("json", providerInput), async (c) => {
      const found = await accessible(c);
      if (!found) return c.json({ error: "not found" }, 404);
      if (!found.permission.canManage) return c.json({ error: "only owners and admins can manage providers" }, 403);
      const body = c.req.valid("json");
      if (body.slug !== found.provider.slug) return c.json({ error: "provider ID cannot be changed" }, 400);
      if (reservedSlug(body.slug)) return c.json({ error: "provider ID is reserved" }, 409);
      const [duplicate] = await db(c, ctx).select({ id: customModelProviders.id }).from(customModelProviders)
        .where(and(found.permission.where, eq(customModelProviders.slug, body.slug)));
      if (duplicate && duplicate.id !== found.provider.id) return c.json({ error: "provider ID is already in use" }, 409);
      const [updated] = await db(c, ctx).update(customModelProviders)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(customModelProviders.id, found.provider.id), found.permission.where)).returning();
      return c.json(publicProvider(updated!));
    })
    .put("/:id/key", zValidator("json", keyInput), async (c) => {
      const found = await accessible(c);
      if (!found) return c.json({ error: "not found" }, 404);
      if (!found.permission.canManage) return c.json({ error: "only owners and admins can manage providers" }, 403);
      const apiKey = c.req.valid("json").apiKey;
      const [updated] = await db(c, ctx).update(customModelProviders)
        .set({ encryptedApiKey: ctx.secretBox.encrypt(apiKey), keyHint: maskSecret(apiKey), updatedAt: new Date() })
        .where(and(eq(customModelProviders.id, found.provider.id), found.permission.where)).returning();
      return c.json(publicProvider(updated!));
    })
    .delete("/:id/key", async (c) => {
      const found = await accessible(c);
      if (!found) return c.json({ error: "not found" }, 404);
      if (!found.permission.canManage) return c.json({ error: "only owners and admins can manage providers" }, 403);
      await db(c, ctx).update(customModelProviders).set({ encryptedApiKey: null, keyHint: null, updatedAt: new Date() })
        .where(and(eq(customModelProviders.id, found.provider.id), found.permission.where));
      return c.json({ ok: true });
    })
    .delete("/:id", async (c) => {
      const found = await accessible(c);
      if (!found) return c.json({ error: "not found" }, 404);
      if (!found.permission.canManage) return c.json({ error: "only owners and admins can manage providers" }, 403);
      await db(c, ctx).update(customModelProviders)
        .set({ deletedAt: new Date(), encryptedApiKey: null, keyHint: null, updatedAt: new Date() })
        .where(and(eq(customModelProviders.id, found.provider.id), found.permission.where));
      return c.json({ ok: true });
    });
}
