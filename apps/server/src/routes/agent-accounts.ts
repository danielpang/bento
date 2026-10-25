import { zValidator } from "@hono/zod-validator";
import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agentAccounts, agentAccountLogins } from "@bento/db";
import type { AppContext } from "../context.js";
import { TokenBuckets } from "../mcp/rate-limit.js";
import { actor } from "../middleware/actor.js";
import { tenantDb } from "../middleware/tenant.js";
import { accountProvider, AccountLoginError, beginLogin, completeLogin, type LoginState } from "../agent-accounts/oauth.js";

const starts = new TokenBuckets({ capacity: 3, refillPerMs: 1 / 20_000 });

export function agentAccountRoutes(ctx: AppContext) {
  return new Hono()
    .use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); })
    .onError((error, c) => {
      // No exception text from token parsing or HTTP libraries is safe to expose.
      return c.json({ error: error instanceof AccountLoginError ? error.message : "Could not update your account connection. Please try again." }, 400);
    })
    .get("/", async (c) => {
      const rows = await tenantDb(c, ctx).select({ id: agentAccounts.id, provider: agentAccounts.provider,
        reconnectRequired: agentAccounts.reconnectRequired, updatedAt: agentAccounts.updatedAt })
        .from(agentAccounts).where(eq(agentAccounts.userId, actor(c)));
      return c.json({ accounts: rows });
    })
    .post("/:provider/login", zValidator("param", z.object({ provider: accountProvider })), async (c) => {
      const provider = c.req.valid("param").provider;
      if (!starts.take(`${actor(c)}:${provider}`)) return c.json({ error: "Please wait a moment before starting another login." }, 429);
      const login = await beginLogin(provider);
      const db = tenantDb(c, ctx);
      await db.delete(agentAccountLogins).where(and(eq(agentAccountLogins.userId, actor(c)), lt(agentAccountLogins.expiresAt, new Date())));
      const [row] = await db.insert(agentAccountLogins).values({ userId: actor(c), provider,
        ciphertext: ctx.secretBox.encrypt(JSON.stringify(login.state)), expiresAt: new Date(Date.now() + 15 * 60_000), nextPollAt: new Date(Date.now() + login.interval * 1000) })
        .onConflictDoUpdate({ target: [agentAccountLogins.userId, agentAccountLogins.provider], set: {
          id: crypto.randomUUID(), ciphertext: ctx.secretBox.encrypt(JSON.stringify(login.state)),
          expiresAt: new Date(Date.now() + 15 * 60_000), nextPollAt: new Date(Date.now() + login.interval * 1000),
        } }).returning({ id: agentAccountLogins.id, expiresAt: agentAccountLogins.expiresAt });
      return c.json({ id: row!.id, url: login.url, userCode: login.userCode, interval: login.interval, expiresAt: row!.expiresAt });
    })
    .post("/:provider/complete", zValidator("param", z.object({ provider: accountProvider })),
      zValidator("json", z.object({ id: z.string().uuid(), code: z.string().max(4096).optional() })), async (c) => {
        const { provider } = c.req.valid("param");
        const body = c.req.valid("json");
        return tenantDb(c, ctx).transaction(async (tx) => {
          const [row] = await tx.select().from(agentAccountLogins).where(and(eq(agentAccountLogins.id, body.id),
            eq(agentAccountLogins.userId, actor(c)), eq(agentAccountLogins.provider, provider))).for("update");
          if (!row || row.expiresAt.getTime() <= Date.now()) return c.json({ error: "Login expired or cancelled. Start again." }, 404);
          if (row.nextPollAt.getTime() > Date.now()) return c.json({ status: "pending" as const });
          const state = JSON.parse(ctx.secretBox.decrypt(row.ciphertext)) as LoginState;
          const credential = await completeLogin(provider, state, body.code);
          if (!credential) {
            await tx.update(agentAccountLogins).set({ nextPollAt: new Date(Date.now() + state.interval * 1000), ciphertext: ctx.secretBox.encrypt(JSON.stringify(state)) }).where(eq(agentAccountLogins.id, row.id));
            return c.json({ status: "pending" as const });
          }
          // Reconnect gets a new id: an old run cannot spend a new connection.
          await tx.delete(agentAccounts).where(and(eq(agentAccounts.userId, actor(c)), eq(agentAccounts.provider, provider)));
          await tx.insert(agentAccounts).values({ id: row.id, userId: actor(c), provider, ciphertext: ctx.secretBox.encrypt(JSON.stringify(credential)), expiresAt: new Date(credential.expires) });
          await tx.delete(agentAccountLogins).where(eq(agentAccountLogins.id, row.id));
          return c.json({ status: "connected" as const });
        });
      })
    .delete("/:provider/login/:id", zValidator("param", z.object({ provider: accountProvider, id: z.string().uuid() })), async (c) => {
      const { provider, id } = c.req.valid("param");
      await tenantDb(c, ctx).transaction(async (tx) => {
        await tx.delete(agentAccountLogins).where(and(eq(agentAccountLogins.userId, actor(c)), eq(agentAccountLogins.provider, provider), eq(agentAccountLogins.id, id)));
        // Completion may have won the row lock just before cancellation.
        // Only this attempt's account is removed; an older connection stays.
        await tx.delete(agentAccounts).where(and(eq(agentAccounts.userId, actor(c)), eq(agentAccounts.provider, provider), eq(agentAccounts.id, id)));
      });
      return c.json({ ok: true });
    })
    .delete("/:provider", zValidator("param", z.object({ provider: accountProvider })), async (c) => {
      const { provider } = c.req.valid("param");
      // Cancel pending login too, so its next poll cannot reconnect after disconnect.
      await tenantDb(c, ctx).transaction(async (tx) => {
        await tx.delete(agentAccountLogins).where(and(eq(agentAccountLogins.userId, actor(c)), eq(agentAccountLogins.provider, provider)));
        await tx.delete(agentAccounts).where(and(eq(agentAccounts.userId, actor(c)), eq(agentAccounts.provider, provider)));
      });
      return c.json({ ok: true });
    });
}
