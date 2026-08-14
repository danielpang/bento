import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseRepoUrl, verifyWebhookSignature, webhookTarget } from "@bento/github";
import { parseIssueWebhook, verifyLinearWebhookSignature } from "@bento/linear";
import { features, githubInstallations, projects } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { linearConnectionRow } from "../linear.js";

/**
 * GitHub webhook receiver. Any event that touches a PR we track queues a
 * gate re-evaluation for the matching feature, which is what makes
 * "advance when review comments are resolved" feel immediate.
 * Self-hosters without a public URL rely on the gate.sweep cron instead.
 */
export function webhookRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * Linear webhook receiver. The organization id rides in the path
     * because Linear's payload carries no Bento tenant and each org
     * verifies against its own secret. Verified events are queued and
     * answered immediately; the worker does the actual import/update.
     */
    .post("/linear/:orgId", async (c) => {
      const orgParam = c.req.param("orgId");
      const organizationId = orgParam === "local" ? null : orgParam;
      const connection = await linearConnectionRow(ctx, organizationId);
      if (!connection?.encryptedWebhookSecret) return c.json({ error: "webhooks not configured" }, 503);

      let secret: string;
      try {
        secret = ctx.secretBox.decrypt(connection.encryptedWebhookSecret);
      } catch {
        return c.json({ error: "webhooks not configured" }, 503);
      }
      const raw = await c.req.text();
      if (!verifyLinearWebhookSignature(secret, raw, c.req.header("linear-signature"))) {
        return c.json({ error: "invalid signature" }, 401);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid payload" }, 400);
      }
      const event = parseIssueWebhook(payload);
      if (!event) return c.json({ ok: true, matched: 0 });

      await ctx.boss.send("linear.inbound", {
        organizationId,
        action: event.action,
        issue: event.data,
      });
      return c.json({ ok: true, matched: 1 });
    })
    .post("/github", async (c) => {
    const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhooks not configured" }, 503);

    const raw = await c.req.text();
    if (!verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event") ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }

    if (event === "installation") {
      const installationEvent = payload as { action?: string; installation?: { id?: number } };
      if (
        (installationEvent.action === "deleted" || installationEvent.action === "suspend")
        && installationEvent.installation?.id !== undefined
      ) {
        await ctx.db
          .delete(githubInstallations)
          .where(eq(githubInstallations.installationId, String(installationEvent.installation.id)));
      }
      return c.json({ ok: true, matched: 0 });
    }

    const target = webhookTarget(event, payload);
    if (!target) return c.json({ ok: true, matched: 0 });

    const projectRows = await db(c, ctx).select().from(projects);
    const matching = projectRows.filter((p) => {
      if (!p.repoUrl) return false;
      const parsed = parseRepoUrl(p.repoUrl);
      return parsed?.owner === target.owner && parsed.repo === target.repo;
    });

    let matched = 0;
    for (const project of matching) {
      const featureRows = await db(c, ctx).select().from(features).where(eq(features.projectId, project.id));
      for (const feature of featureRows) {
        if (feature.prNumber !== target.prNumber) continue;
        await ctx.boss.send("gate.evaluate", { featureId: feature.id });
        matched += 1;
      }
    }
    return c.json({ ok: true, matched });
  });
}
