import { and, eq, isNull } from "drizzle-orm";
import { agentAccounts, agentRuns, member, secrets, type Db } from "@bento/db";
import type { PersonalCredentialIds } from "./credentials.js";
import type { AppContext } from "../context.js";
import type { ResolvedGrant } from "../mcp/grants.js";
import { AccountLoginError, refreshLogin, type AccountProvider, type AccountTokens } from "./oauth.js";

export const personalMarker = (id: string) => `personal-account:${id}`;
export const personalKey = (provider: AccountProvider) => provider === "anthropic" ? "BENTO_PERSONAL_ANTHROPIC" : "BENTO_PERSONAL_CODEX";
export const personalSegment = (provider: AccountProvider) => provider === "anthropic" ? "subscription-anthropic" : "subscription-codex";
export function personalProvider(cli: string, model: string): AccountProvider | null {
  if (cli === "claude-code" && !model.includes("/")) return "anthropic";
  if (cli === "codex" && !model.includes("/")) return "openai-codex";
  if (cli === "pi" && model.startsWith("anthropic/")) return "anthropic";
  if (cli === "pi" && (model.startsWith("openai-codex/") || model.startsWith("openai/"))) return "openai-codex";
  return null;
}
/** Shared by queueing and execution, including local process endpoints.
 * Hosted runs never consult the operator's environment. A stored override
 * wins even if it is empty or cannot be decrypted: it is not a subscription.
 */
export async function personalEndpointRedirected(
  db: Pick<Db, "select">,
  organizationId: string | null,
  provider: AccountProvider,
  mode: "local" | "multi",
  ids: PersonalCredentialIds = {},
): Promise<boolean> {
  const name = provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  if (Object.hasOwn(ids, name)) return Boolean(ids[name]);
  const [stored] = await db.select({ id: secrets.id }).from(secrets).where(and(
    organizationId ? eq(secrets.organizationId, organizationId) : isNull(secrets.organizationId),
    eq(secrets.name, name),
  ));
  return Boolean(stored || (mode === "local" && process.env[name]));
}

export async function isCurrentMember(ctx: AppContext, userId: string, organizationId: string | null) {
  if (ctx.env.BENTO_MODE !== "multi") return userId === ctx.userId;
  if (!organizationId) return true;
  const [row] = await ctx.db.select({ id: member.id }).from(member).where(and(eq(member.userId, userId), eq(member.organizationId, organizationId))).limit(1);
  return Boolean(row);
}
export async function accountForRun(ctx: AppContext, userId: string | null, organizationId: string | null, cli: string, model: string) {
  // No project-owner or organization fallback for unattended work.
  if (!userId) return null;
  const provider = personalProvider(cli, model);
  if (!provider || !(await isCurrentMember(ctx, userId, organizationId))) return null;
  const [row] = await ctx.db.select({ id: agentAccounts.id, provider: agentAccounts.provider, reconnectRequired: agentAccounts.reconnectRequired })
    .from(agentAccounts).where(and(eq(agentAccounts.userId, userId), eq(agentAccounts.provider, provider)));
  return row ?? null;
}

/** No credential cache: disconnect and membership removal apply on the next request. */
export async function personalCredentials(ctx: AppContext, grant: ResolvedGrant, provider: AccountProvider): Promise<AccountTokens | null> {
  if (!grant.actingUserId || !(await isCurrentMember(ctx, grant.actingUserId, grant.organizationId))) return null;
  const marker = grant.modelCredentials.find((value) => value.startsWith("personal-account:"));
  const id = marker?.slice("personal-account:".length);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const [run] = await ctx.db.select({ startedBy: agentRuns.startedBy, personalAccountId: agentRuns.personalAccountId }).from(agentRuns).where(eq(agentRuns.id, grant.runId));
  if (run?.startedBy !== grant.actingUserId || run.personalAccountId !== id) return null;
  // The row lock serializes rotating refresh tokens across all server replicas.
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentAccounts).where(and(eq(agentAccounts.id, id),
      eq(agentAccounts.userId, grant.actingUserId!), eq(agentAccounts.provider, provider))).for("update");
    if (!row || row.reconnectRequired) return null;
    const value = JSON.parse(ctx.secretBox.decrypt(row.ciphertext)) as AccountTokens;
    if (row.expiresAt.getTime() > Date.now() + 60_000) return value;
    try {
      const updated = await refreshLogin(provider, value.refresh);
      await tx.update(agentAccounts).set({ ciphertext: ctx.secretBox.encrypt(JSON.stringify(updated)), expiresAt: new Date(updated.expires), updatedAt: new Date() }).where(eq(agentAccounts.id, id));
      return updated;
    } catch (error) {
      if (error instanceof AccountLoginError && error.permanent) {
        await tx.update(agentAccounts).set({ reconnectRequired: true }).where(eq(agentAccounts.id, id));
        return null;
      }
      throw error;
    }
  });
}
