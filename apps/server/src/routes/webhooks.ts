import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseRepoUrl, verifyWebhookSignature, webhookTarget } from "@bento/github";
import { features, githubInstallations, projects } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";

/**
 * GitHub webhook receiver. Any event that touches a PR we track queues a
 * gate re-evaluation for the matching feature, which is what makes
 * "advance when review comments are resolved" feel immediate.
 * Self-hosters without a public URL rely on the gate.sweep cron instead.
 */
export function webhookRoutes(ctx: AppContext) {
  return new Hono().post("/github", async (c) => {
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
