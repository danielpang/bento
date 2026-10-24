import { and, eq, isNotNull, notLike } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  customModelProviders,
  linearConnections,
  mcpCredentials,
  mcpOAuthCodes,
  mcpServers,
  secrets,
  slackConnections,
  type Db,
} from "@bento/db";
import type { AppContext } from "./context.js";
import type { SecretSlot } from "./secrets.js";
import { mcpCredentialSlot } from "./mcp/refresh.js";

/** One encrypted column, and how to name the slot each of its rows holds. */
interface EncryptedColumn {
  label: string;
  table: PgTable;
  id: PgColumn;
  column: PgColumn;
  /** The column's property name on the table, which is what an update sets. */
  key: string;
  /** Legacy rows of this column, each with the slot its value belongs to. */
  legacy(db: Db): Promise<{ id: string; stored: string; slot: SecretSlot }[]>;
}

const LEGACY = (column: PgColumn) => and(isNotNull(column), notLike(column, "v2:%"));

/**
 * Every column that holds a SecretBox value. A new encrypted column
 * belongs here, or its rows written before slots existed are never
 * upgraded and are refused on every read.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  {
    label: "secrets.ciphertext",
    table: secrets,
    id: secrets.id,
    column: secrets.ciphertext,
    key: "ciphertext",
    legacy: async (db) =>
      (await db
        .select({ id: secrets.id, stored: secrets.ciphertext, organizationId: secrets.organizationId, name: secrets.name })
        .from(secrets)
        .where(LEGACY(secrets.ciphertext))).map((row) => ({
        id: row.id,
        stored: row.stored,
        slot: { kind: "org_secret", organizationId: row.organizationId, name: row.name },
      })),
  },
  {
    label: "custom_model_providers.encrypted_api_key",
    table: customModelProviders,
    id: customModelProviders.id,
    column: customModelProviders.encryptedApiKey,
    key: "encryptedApiKey",
    legacy: async (db) =>
      (await db
        .select({
          id: customModelProviders.id,
          stored: customModelProviders.encryptedApiKey,
          organizationId: customModelProviders.organizationId,
        })
        .from(customModelProviders)
        .where(LEGACY(customModelProviders.encryptedApiKey))).map((row) => ({
        id: row.id,
        stored: row.stored!,
        slot: { kind: "custom_provider_key", organizationId: row.organizationId, providerId: row.id },
      })),
  },
  {
    label: "linear_connections.encrypted_api_key",
    table: linearConnections,
    id: linearConnections.id,
    column: linearConnections.encryptedApiKey,
    key: "encryptedApiKey",
    legacy: async (db) =>
      (await db
        .select({ id: linearConnections.id, stored: linearConnections.encryptedApiKey, organizationId: linearConnections.organizationId })
        .from(linearConnections)
        .where(LEGACY(linearConnections.encryptedApiKey))).map((row) => ({
        id: row.id,
        stored: row.stored,
        slot: { kind: "linear_api_key", organizationId: row.organizationId },
      })),
  },
  {
    label: "linear_connections.encrypted_webhook_secret",
    table: linearConnections,
    id: linearConnections.id,
    column: linearConnections.encryptedWebhookSecret,
    key: "encryptedWebhookSecret",
    legacy: async (db) =>
      (await db
        .select({
          id: linearConnections.id,
          stored: linearConnections.encryptedWebhookSecret,
          organizationId: linearConnections.organizationId,
        })
        .from(linearConnections)
        .where(LEGACY(linearConnections.encryptedWebhookSecret))).map((row) => ({
        id: row.id,
        stored: row.stored!,
        slot: { kind: "linear_webhook_secret", organizationId: row.organizationId },
      })),
  },
  {
    label: "slack_connections.encrypted_bot_token",
    table: slackConnections,
    id: slackConnections.id,
    column: slackConnections.encryptedBotToken,
    key: "encryptedBotToken",
    legacy: async (db) =>
      (await db
        .select({ id: slackConnections.id, stored: slackConnections.encryptedBotToken, organizationId: slackConnections.organizationId })
        .from(slackConnections)
        .where(LEGACY(slackConnections.encryptedBotToken))).map((row) => ({
        id: row.id,
        stored: row.stored,
        slot: { kind: "slack_bot_token", organizationId: row.organizationId },
      })),
  },
  {
    label: "mcp_servers.encrypted_client_secret",
    table: mcpServers,
    id: mcpServers.id,
    column: mcpServers.encryptedClientSecret,
    key: "encryptedClientSecret",
    legacy: async (db) =>
      (await db
        .select({ id: mcpServers.id, stored: mcpServers.encryptedClientSecret, organizationId: mcpServers.organizationId })
        .from(mcpServers)
        .where(LEGACY(mcpServers.encryptedClientSecret))).map((row) => ({
        id: row.id,
        stored: row.stored!,
        slot: { kind: "mcp_client_secret", organizationId: row.organizationId, serverId: row.id },
      })),
  },
  ...(["access", "refresh"] as const).map((part): EncryptedColumn => {
    const column = part === "access" ? mcpCredentials.encryptedSecret : mcpCredentials.encryptedRefreshToken;
    return {
      label: `mcp_credentials.${part === "access" ? "encrypted_secret" : "encrypted_refresh_token"}`,
      table: mcpCredentials,
      id: mcpCredentials.id,
      column,
      key: part === "access" ? "encryptedSecret" : "encryptedRefreshToken",
      legacy: async (db) =>
        (await db
          .select({
            id: mcpCredentials.id,
            stored: column,
            userId: mcpCredentials.userId,
            serverId: mcpServers.id,
            organizationId: mcpServers.organizationId,
          })
          .from(mcpCredentials)
          .innerJoin(mcpServers, eq(mcpServers.id, mcpCredentials.serverId))
          .where(LEGACY(column))).map((row) => ({
          id: row.id,
          stored: row.stored!,
          slot: mcpCredentialSlot({ id: row.serverId, organizationId: row.organizationId }, row.userId, part),
        })),
    };
  }),
  {
    label: "mcp_oauth_codes.token_bundle",
    table: mcpOAuthCodes,
    id: mcpOAuthCodes.id,
    column: mcpOAuthCodes.tokenBundle,
    key: "tokenBundle",
    legacy: async (db) =>
      (await db
        .select({
          id: mcpOAuthCodes.id,
          stored: mcpOAuthCodes.tokenBundle,
          organizationId: mcpOAuthCodes.organizationId,
          connectionId: mcpOAuthCodes.connectionId,
        })
        .from(mcpOAuthCodes)
        .where(LEGACY(mcpOAuthCodes.tokenBundle))).map((row) => ({
        id: row.id,
        stored: row.stored,
        slot: { kind: "mcp_oauth_code", organizationId: row.organizationId, connectionId: row.connectionId },
      })),
  },
];

export interface SecretUpgradeResult {
  /** Values re-encrypted and sealed to the row they were found in, by column. */
  upgraded: Record<string, number>;
  /** Legacy values this key cannot read (another key, or damaged). Left as they are. */
  unreadable: Record<string, number>;
}

/**
 * Seals every value written before slots existed to the row it is in.
 *
 * Runs at boot, before the server takes a request, and once more a few
 * minutes later to catch a value an old process wrote while a deploy
 * overlapped. Each write is a compare and set on the old value, so two
 * processes booting at once do not fight, and a value a route replaced
 * meanwhile is left alone. After this, `SecretBox.decrypt` never reads
 * the legacy format; this is the only path that still does, and it seals
 * what it reads to where it found it.
 */
export async function upgradeLegacySecrets(ctx: Pick<AppContext, "db" | "secretBox">): Promise<SecretUpgradeResult> {
  const result: SecretUpgradeResult = { upgraded: {}, unreadable: {} };
  for (const spec of ENCRYPTED_COLUMNS) {
    for (const row of await spec.legacy(ctx.db)) {
      let next: string;
      try {
        next = ctx.secretBox.upgradeLegacy(row.stored, row.slot);
      } catch {
        result.unreadable[spec.label] = (result.unreadable[spec.label] ?? 0) + 1;
        continue;
      }
      const written = await ctx.db
        .update(spec.table)
        .set({ [spec.key]: next } as never)
        .where(and(eq(spec.id, row.id), eq(spec.column, row.stored)))
        .returning({ id: spec.id });
      if (written.length > 0) result.upgraded[spec.label] = (result.upgraded[spec.label] ?? 0) + 1;
    }
  }
  return result;
}
