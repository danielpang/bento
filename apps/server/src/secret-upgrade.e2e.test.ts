import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  createDb,
  createPool,
  customModelProviders,
  linearConnections,
  mcpConnections,
  mcpCredentials,
  mcpOAuthCodes,
  mcpServers,
  organization,
  runMigrations,
  secrets,
  slackConnections,
  user,
  type Db,
} from "@bento/db";
import { SecretBox, SecretUnreadable, isLegacySecret } from "./secrets.js";
import { ENCRYPTED_COLUMNS, upgradeLegacySecrets } from "./secret-upgrade.js";
import { mcpCredentialSlot } from "./mcp/refresh.js";

/**
 * The boot upgrade, against rows a database written before values were
 * sealed to their slot would hold: every encrypted column gets a legacy
 * value, the upgrade seals each to the row it is in, and a sealed value
 * moved to another organization's row is refused.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "secret_upgrade_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
const KEY = "test-encryption-key-at-least-32-chars";

let pool: ReturnType<typeof createPool>;
let db: Db;
const box = new SecretBox(KEY);

function legacy(plaintext: string, secret = KEY): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);
  pool = createPool(testUrl);
  db = createDb(pool);
});

after(async () => {
  await pool?.end();
});

test("every encrypted column names the property an update sets", () => {
  for (const spec of ENCRYPTED_COLUMNS) {
    assert.equal((spec.table as unknown as Record<string, unknown>)[spec.key], spec.column, spec.label);
  }
});

test("the boot upgrade seals every legacy value to its row, once, and a moved value is refused", async () => {
  await db.insert(user).values({ id: "u-a", name: "A", email: "a@bento.test", emailVerified: true });
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "org-a" },
    { id: "org-b", name: "B", slug: "org-b" },
  ]);

  const [secretA] = await db.insert(secrets).values({
    ownerId: "u-a", organizationId: "org-a", name: "ANTHROPIC_API_KEY", ciphertext: legacy("sk-ant-a"),
  }).returning();
  await db.insert(secrets).values({
    ownerId: "u-a", organizationId: "org-a", name: "OPENAI_API_KEY", ciphertext: legacy("other key", "b".repeat(40)),
  });
  const [secretB] = await db.insert(secrets).values({
    ownerId: "u-a", organizationId: "org-b", name: "ANTHROPIC_API_KEY", ciphertext: box.encrypt("sk-ant-b", {
      kind: "org_secret", organizationId: "org-b", name: "ANTHROPIC_API_KEY",
    }),
  }).returning();
  const [provider] = await db.insert(customModelProviders).values({
    ownerId: "u-a", organizationId: "org-a", slug: "mine", name: "Mine", protocol: "openai",
    baseUrl: "https://models.example.test/v1", models: [], encryptedApiKey: legacy("provider-key"),
  }).returning();
  await db.insert(linearConnections).values({
    ownerId: "u-a", organizationId: "org-a", encryptedApiKey: legacy("lin_api"), encryptedWebhookSecret: legacy("hook"),
  });
  await db.insert(slackConnections).values({
    ownerId: "u-a", organizationId: "org-a", slackTeamId: "T1", slackTeamName: "T", botUserId: "B",
    encryptedBotToken: legacy("xoxb"), installedBy: "u-a",
  });
  const [server] = await db.insert(mcpServers).values({
    ownerId: "u-a", organizationId: "org-a", name: "S", slug: "s", url: "https://mcp.example.test/mcp",
    authType: "oauth", encryptedClientSecret: legacy("client-secret"),
  }).returning();
  const [credential] = await db.insert(mcpCredentials).values({
    serverId: server!.id, userId: "u-a", kind: "oauth",
    encryptedSecret: legacy("access"), encryptedRefreshToken: legacy("refresh"),
  }).returning();
  const [connection] = await db.insert(mcpConnections).values({
    ownerId: "u-a", organizationId: "org-a", name: "C", scope: "organization", tokenHash: "h",
  }).returning();
  const [code] = await db.insert(mcpOAuthCodes).values({
    codeHash: "c", clientId: "cl", redirectUri: "https://x.test/cb", codeChallenge: "cc", resource: "r",
    connectionId: connection!.id, tokenBundle: legacy("{}"), expiresAt: new Date(Date.now() + 60_000),
  }).returning();

  const first = await upgradeLegacySecrets({ db, secretBox: box });
  assert.deepEqual(first.unreadable, { "secrets.ciphertext": 1 }, "a value under another key is left alone");
  assert.equal(Object.values(first.upgraded).reduce((a, b) => a + b, 0), 9, JSON.stringify(first.upgraded));

  const read = async <T>(query: Promise<T[]>) => (await query)[0]!;
  const a = await read(db.select().from(secrets).where(eq(secrets.id, secretA!.id)));
  assert.match(a.ciphertext, /^v2:k0:/);
  assert.equal(box.decrypt(a.ciphertext, { kind: "org_secret", organizationId: "org-a", name: "ANTHROPIC_API_KEY" }), "sk-ant-a");
  const p = await read(db.select().from(customModelProviders).where(eq(customModelProviders.id, provider!.id)));
  assert.equal(box.decrypt(p.encryptedApiKey!, { kind: "custom_provider_key", organizationId: "org-a", providerId: p.id }), "provider-key");
  const l = await read(db.select().from(linearConnections));
  assert.equal(box.decrypt(l.encryptedApiKey, { kind: "linear_api_key", organizationId: "org-a" }), "lin_api");
  assert.equal(box.decrypt(l.encryptedWebhookSecret!, { kind: "linear_webhook_secret", organizationId: "org-a" }), "hook");
  const s = await read(db.select().from(slackConnections));
  assert.equal(box.decrypt(s.encryptedBotToken, { kind: "slack_bot_token", organizationId: "org-a" }), "xoxb");
  const srv = await read(db.select().from(mcpServers).where(eq(mcpServers.id, server!.id)));
  assert.equal(box.decrypt(srv.encryptedClientSecret!, { kind: "mcp_client_secret", organizationId: "org-a", serverId: srv.id }), "client-secret");
  const cred = await read(db.select().from(mcpCredentials).where(eq(mcpCredentials.id, credential!.id)));
  assert.equal(box.decrypt(cred.encryptedSecret, mcpCredentialSlot(srv, "u-a", "access")), "access");
  assert.equal(box.decrypt(cred.encryptedRefreshToken!, mcpCredentialSlot(srv, "u-a", "refresh")), "refresh");
  const c = await read(db.select().from(mcpOAuthCodes).where(eq(mcpOAuthCodes.id, code!.id)));
  assert.equal(box.decrypt(c.tokenBundle, { kind: "mcp_oauth_code", organizationId: "org-a", connectionId: connection!.id }), "{}");

  // A second pass finds nothing new to seal.
  const second = await upgradeLegacySecrets({ db, secretBox: box });
  assert.deepEqual(second.upgraded, {});

  // The attack: org A's sealed key copied over org B's row. B's reads
  // name B's slot, so the copy is refused rather than spent as B's key.
  await db.update(secrets).set({ ciphertext: a.ciphertext }).where(eq(secrets.id, secretB!.id));
  const moved = await read(db.select().from(secrets).where(eq(secrets.id, secretB!.id)));
  assert.throws(
    () => box.decrypt(moved.ciphertext, { kind: "org_secret", organizationId: moved.organizationId, name: moved.name }),
    SecretUnreadable,
  );
  // And a legacy value planted after the upgrade is never read directly.
  const planted = legacy("sk-ant-a");
  assert.equal(isLegacySecret(planted), true);
  assert.throws(() => box.decrypt(planted, { kind: "org_secret", organizationId: "org-b", name: "ANTHROPIC_API_KEY" }), /legacy/);
});
