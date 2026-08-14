import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { contactMessage, createMailer } from "../mail.js";
import { actor } from "../middleware/actor.js";

const contactBody = z.object({
  kind: z.enum(["issue", "feature"]),
  message: z.string().trim().min(1).max(5000),
});

/**
 * The contact form: an issue report or a feature request, mailed to
 * the address in BENTO_CONTACT_EMAIL.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check. The sender is looked up rather
 * than taken from the body, so the report cannot claim to be from
 * someone else.
 */
export function contactRoutes(ctx: AppContext) {
  const mailer = createMailer(ctx.env);

  return new Hono().post("/", zValidator("json", contactBody), async (c) => {
    const to = ctx.env.BENTO_CONTACT_EMAIL;
    if (!to) {
      return c.json({ error: "contact is not configured on this server" }, 503);
    }

    const [sender] = await ctx.db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, actor(c)))
      .limit(1);
    if (!sender) return c.json({ error: "not found" }, 404);

    const body = c.req.valid("json");
    await mailer.send(
      contactMessage({
        to,
        kind: body.kind,
        message: body.message,
        senderName: sender.name,
        senderEmail: sender.email,
        appUrl: ctx.env.BETTER_AUTH_URL.replace(/\/$/, ""),
      }),
    );
    return c.json({ ok: true });
  });
}
