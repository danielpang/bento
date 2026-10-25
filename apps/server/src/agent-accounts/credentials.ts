import { and, eq, inArray, isNull } from "drizzle-orm";
import { credentialNamesFor, getAdapter } from "@bento/agents";
import { MODEL_PROVIDERS } from "@bento/core";
import { customModelProviders, member, secrets, userSecrets, type Db } from "@bento/db";
import type { AppContext } from "../context.js";

export type PersonalCredentialIds = Record<string, string | null>;
export const PERSONAL_KEYS_MARKER = "personal-api-keys";
export const customKeyName = (id: string) => `custom-provider:${id}`;
export const hasPersonalKeys = (ids: PersonalCredentialIds) => Object.keys(ids).length > 0;

/** A key and its endpoint always come from the same scope. */
function credentialGroups(): string[][] {
  const groups = MODEL_PROVIDERS.filter((p) => !p.key.startsWith("BENTO_PERSONAL_")).map((p) => [p.key, ...(p.baseUrlKey ? [p.baseUrlKey] : [])]);
  const anthropic = groups.find((group) => group.includes("ANTHROPIC_API_KEY"));
  anthropic?.push("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN");
  return groups;
}

/** Pin identities at queue time. Null entries prevent mixing personal keys with shared endpoints. */
export async function pinPersonalCredentials(db: Pick<Db, "select">, userId: string, organizationId: string | null, cli: Parameters<typeof getAdapter>[0], model: string): Promise<PersonalCredentialIds> {
  const adapter = getAdapter(cli);
  const names = credentialNamesFor(adapter, model);
  const wanted = new Set([...names.required, ...names.optional, ...names.alternatives]);
  const groups = credentialGroups();
  for (const group of groups) if (group.some((name) => wanted.has(name))) for (const name of group) wanted.add(name);
  const [custom] = await db.select({ id: customModelProviders.id, baseUrl: customModelProviders.baseUrl }).from(customModelProviders).where(and(
    organizationId ? eq(customModelProviders.organizationId, organizationId) : isNull(customModelProviders.organizationId),
    eq(customModelProviders.slug, model.split("/")[0]!), isNull(customModelProviders.deletedAt),
  ));
  if (custom) { wanted.clear(); wanted.add(customKeyName(custom.id)); }
  if (!wanted.size) return {};
  const rows = await db.select({ id: userSecrets.id, name: userSecrets.name }).from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), inArray(userSecrets.name, [...wanted])));
  const result: PersonalCredentialIds = Object.fromEntries(rows.map((row) => [row.name, row.id]));
  for (const group of groups) {
    if (group.some((name) => result[name])) for (const name of group) result[name] ??= null;
  }
  if (custom && result[customKeyName(custom.id)]) result[`custom-endpoint:${custom.id}`] = custom.baseUrl;
  return result;
}

export async function assertPersonalKeyOwner(ctx: AppContext, userId: string | null, organizationId: string | null) {
  if (!userId) throw new Error("Personal API keys require the user who started this run.");
  if (ctx.env.BENTO_MODE === "local") {
    if (userId !== ctx.userId) throw new Error("Personal API key owner is unavailable.");
  } else if (organizationId) {
    const [membership] = await ctx.db.select({ id: member.id }).from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)));
    if (!membership) throw new Error("Personal API key owner is no longer a member of this organization.");
  }
}

/** Shared reader for execution and proxy requests. Deleted personal keys never fall back to shared keys. */
export async function credentialRows(ctx: AppContext, organizationId: string | null, names: readonly string[], userId: string | null = null, ids: PersonalCredentialIds = {}) {
  const shared = await ctx.db.select().from(secrets).where(and(
    organizationId ? eq(secrets.organizationId, organizationId) : isNull(secrets.organizationId),
    inArray(secrets.name, [...names]),
  ));
  const selected = names.filter((name) => Object.hasOwn(ids, name));
  if (!selected.length) return shared;
  await assertPersonalKeyOwner(ctx, userId, organizationId);
  const personal = await ctx.db.select().from(userSecrets).where(and(eq(userSecrets.userId, userId!), inArray(userSecrets.name, selected)));
  const result: { name: string; ciphertext: string }[] = shared.filter((row) => !selected.includes(row.name));
  for (const name of selected) {
    if (ids[name] === null) continue;
    const row = personal.find((row) => row.name === name && row.id === ids[name]);
    if (!row) throw new Error("Your personal API key changed or was removed. Start a new run after checking Agents.");
    result.push(row);
  }
  return result;
}
