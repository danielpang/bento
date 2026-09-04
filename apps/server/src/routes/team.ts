import { and, asc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { agentRuns, features, invitation, member, organization, organizationPolicies, user } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { getActiveOrganizationMembership } from "../access.js";
import { hoursByFeature } from "../hours-by-feature.js";

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
    /**
     * Agent hours this team spent, by card, in the billing month.
     *
     * Billing's meter is a team total; this is the ranking that says
     * which cards made it. Hours are summed per feature from the
     * period start the plan already uses (the org's billing
     * anniversary, not the first of the calendar month). A run that
     * straddles the boundary only counts the overlap.
     *
     * Scoped to the active organization, so a foreign tenant asking
     * for another team's period sees 404, not an empty list of
     * somebody else's cards. `from` and `to` are required: defaulting
     * them to all time would rank cards nobody billed this month.
     */
    .get("/hours", async (c) => {
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);

      const fromRaw = c.req.query("from");
      const toRaw = c.req.query("to");
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return c.json({ error: "from and to must be the billing period" }, 400);
      }

      const now = new Date();
      const runs = await db(c, ctx)
        .select({
          featureId: features.id,
          title: features.title,
          startedAt: agentRuns.startedAt,
          endedAt: agentRuns.endedAt,
        })
        .from(agentRuns)
        .innerJoin(features, eq(features.id, agentRuns.featureId))
        .where(
          and(
            eq(features.organizationId, membership.organizationId),
            isNotNull(agentRuns.startedAt),
            lt(agentRuns.startedAt, to),
            or(isNull(agentRuns.endedAt), gt(agentRuns.endedAt, from)),
          ),
        );

      return c.json({ features: hoursByFeature(runs, from, to, now) });
    })
    /**
     * The caller's own pending invitations, by the address on their
     * account. This is what offers a fresh sign-up their invitation
     * instead of a blank "name your team" form.
     *
     * Exists because better-auth's list-user-invitations refuses any
     * session whose email is unverified, and a no-SMTP install never
     * verifies anyone, so the console could not see invitations on the
     * deployments that most need the fallback. On a deployment that
     * does verify, every session is verified by construction (sign in
     * is refused until the address is confirmed), so answering here
     * discloses nothing extra.
     *
     * Only invitations the accept endpoint would actually take: pending
     * and unexpired, oldest first. Offering one that accept would then
     * refuse walled people off from creating a team at all.
     */
    .get("/invitations", async (c) => {
      if (ctx.env.BENTO_MODE !== "multi") return c.json([]);
      const userId = actor(c);
      const handle = db(c, ctx);
      const [me] = await handle.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
      if (!me) return c.json([]);
      // Scoped by hand to the caller's own address, like everything in
      // this file. Plain equality: better-auth lowercases both sides
      // on write, and re-folding case would abandon the email index.
      const rows = await handle
        .select({ id: invitation.id, organizationName: organization.name })
        .from(invitation)
        .innerJoin(organization, eq(organization.id, invitation.organizationId))
        .where(
          and(
            eq(invitation.email, me.email),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(invitation.createdAt));
      return c.json(rows);
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
