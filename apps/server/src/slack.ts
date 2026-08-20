import { eq, isNull } from "drizzle-orm";
import { slackConnections } from "@bento/db";
import { SlackClient } from "@bento/slack";
import type { AppContext } from "./context.js";

export type SlackConnectionRow = typeof slackConnections.$inferSelect;

export function slackOrgFilter(organizationId: string | null) {
  return organizationId
    ? eq(slackConnections.organizationId, organizationId)
    : isNull(slackConnections.organizationId);
}

export function slackConfigured(ctx: AppContext): boolean {
  return Boolean(ctx.env.SLACK_CLIENT_ID && ctx.env.SLACK_CLIENT_SECRET && ctx.env.SLACK_SIGNING_SECRET);
}

export async function slackConnectionRow(
  ctx: AppContext,
  organizationId: string | null,
): Promise<SlackConnectionRow | null> {
  const [row] = await ctx.db
    .select()
    .from(slackConnections)
    .where(slackOrgFilter(organizationId))
    .limit(1);
  return row ?? null;
}

export async function slackConnectionByTeam(
  ctx: AppContext,
  slackTeamId: string,
): Promise<SlackConnectionRow | null> {
  const [row] = await ctx.db
    .select()
    .from(slackConnections)
    .where(eq(slackConnections.slackTeamId, slackTeamId))
    .limit(1);
  return row ?? null;
}

export async function slackClientFor(
  ctx: AppContext,
  connection: SlackConnectionRow,
): Promise<SlackClient | null> {
  try {
    return new SlackClient(ctx.secretBox.decrypt(connection.encryptedBotToken));
  } catch {
    return null;
  }
}

export function cardUrl(ctx: AppContext, featureId: string): string {
  const base = ctx.env.BETTER_AUTH_URL.replace(/\/$/, "");
  return `${base}/?feature=${featureId}`;
}
