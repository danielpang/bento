import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { createMailer, swarmWaitlistMessage } from "../mail.js";
import { actor } from "../middleware/actor.js";
import { githubLogin } from "../swarm-access.js";

export const SWARM_WAITLIST_EMAIL = "waitlist@usebento.ai";

/**
 * Asks to be let in to swarms on hosted Bento, by mail to the waitlist
 * inbox with the person's email and GitHub username.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check. The sender is looked up rather
 * than taken from a body, so a request cannot sign someone else up.
 * Refused without SMTP, because the console says the person was added
 * only when the mail really went. Asked again, it answers yes without a
 * second mail.
 */
export function swarmWaitlistRoutes(ctx: AppContext) {
  const mailer = createMailer(ctx.env);

  return new Hono().post("/", async (c) => {
    if (!ctx.env.SMTP_HOST) return c.json({ error: "mail is not configured on this server" }, 503);

    const userId = actor(c);
    // Claimed before the mail goes, so a double click sends one.
    const [sender] = await ctx.db
      .update(user)
      .set({ swarmWaitlistRequestedAt: new Date() })
      .where(and(eq(user.id, userId), isNull(user.swarmWaitlistRequestedAt)))
      .returning({ name: user.name, email: user.email });
    if (!sender) return c.json({ ok: true as const });

    try {
      await mailer.send(
        swarmWaitlistMessage({
          to: SWARM_WAITLIST_EMAIL,
          senderName: sender.name,
          senderEmail: sender.email,
          githubUsername: await githubLogin(ctx, userId),
          appUrl: ctx.env.BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
      );
    } catch (err) {
      await ctx.db.update(user).set({ swarmWaitlistRequestedAt: null }).where(eq(user.id, userId));
      ctx.analytics?.captureException(err, userId, null, { source: "swarm_waitlist" });
      return c.json({ error: "could not send" }, 502);
    }
    ctx.analytics?.capture({ event: "swarm waitlist joined", userId });
    return c.json({ ok: true as const });
  });
}
