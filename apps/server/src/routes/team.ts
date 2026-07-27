import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { invitation, member, organization, organizationPolicies, user } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { getActiveOrganizationMembership } from "../access.js";

/**
 * The organization roster in line form, for the Mac app.
 *
 * Everything here is a READ. Creating organizations, inviting, changing
 * roles, and removing members stay on better-auth's own endpoints under
 * /api/auth/organization/*, which the app calls with the same bearer
 * token: reimplementing them would mean reimplementing their invitation
 * tokens and role rules, and the two copies would drift.
 *
 * Access note: these are better-auth's tables in the identity schema,
 * and the row-level security migration covers the application tables
 * only. There is no second layer catching a missed filter here, so
 * every query below is scoped by hand to the caller's own membership.
 */
export function teamRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * The organization's own policy. Read by any member, changed only
     * by an owner or admin: locking agents down is a security decision
     * for whoever answers for the team, and turning it back off is the
     * same decision in reverse.
     */
    .get("/policy", async (c) => {
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);
      const [row] = await db(c, ctx)
        .select()
        .from(organizationPolicies)
        .where(eq(organizationPolicies.organizationId, membership.organizationId))
        .limit(1);
      return c.json({
        restrictNetwork: row?.restrictNetwork === true,
        canEdit: membership.role === "owner" || membership.role === "admin",
        // Whether the deployment can honour it at all, so the control
        // can say why it would refuse rather than failing at run time.
        supported: ctx.driver.supportsRestrictedNetwork === true,
      });
    })
    .patch("/policy", zValidator("json", z.object({ restrictNetwork: z.boolean() })), async (c) => {
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);
      if (membership.role !== "owner" && membership.role !== "admin") {
        return c.json({ error: "only organization owners and admins can change this" }, 403);
      }
      const { restrictNetwork } = c.req.valid("json");
      if (restrictNetwork && !ctx.driver.supportsRestrictedNetwork) {
        return c.json(
          {
            error:
              "This deployment has no restricted network configured, so agents cannot be locked down yet. Set BENTO_SANDBOX_RESTRICTED_NETWORK on the server first.",
          },
          409,
        );
      }
      await db(c, ctx)
        .insert(organizationPolicies)
        .values({ organizationId: membership.organizationId, restrictNetwork })
        .onConflictDoUpdate({
          target: organizationPolicies.organizationId,
          set: { restrictNetwork, updatedAt: new Date() },
        });
      return c.json({ restrictNetwork });
    })
    .get("/plain", async (c) => {
    // Local mode has one trusted user and no organizations at all.
    if (ctx.env.BENTO_MODE !== "multi") return c.text("mode|local");

    const userId = actor(c);
    const handle = db(c, ctx);

    const memberships = await handle
      .select({ organizationId: member.organizationId, role: member.role, name: organization.name })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId));

    // The session's active organization is only meaningful if the
    // caller is still in it: membership can be revoked while a session
    // lives, and the roster below must not answer for a stale one.
    const requestedOrg = activeOrg(c);
    const active = memberships.find((row) => row.organizationId === requestedOrg) ?? null;

    const lines = ["mode|multi"];
    for (const row of memberships) {
      const isActive = row.organizationId === active?.organizationId ? "1" : "0";
      lines.push(`org|${row.organizationId}|${isActive}|${row.role}|${row.name}`);
    }

    if (!active) return c.text(lines.join("\n"));

    const members = await handle
      .select({ id: member.id, userId: member.userId, role: member.role, email: user.email, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, active.organizationId));
    for (const row of members) {
      lines.push(`member|${row.id}|${row.userId}|${row.role}|${row.email}|${row.name}`);
    }

    const invitations = await handle
      .select({ id: invitation.id, role: invitation.role, status: invitation.status, email: invitation.email })
      .from(invitation)
      .where(and(eq(invitation.organizationId, active.organizationId), eq(invitation.status, "pending")));
    for (const row of invitations) {
      lines.push(`invitation|${row.id}|${row.status}|${row.role ?? "member"}|${row.email}`);
    }

    return c.text(lines.join("\n"));
  });
}
