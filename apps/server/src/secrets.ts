import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * The stored format every write produces: `v2:<key id>:<iv>:<tag>:<ciphertext>`,
 * with the version and key id inside the associated data as well.
 */
const VERSION = "v2";
/** The one key there is today. Rotation adds ids beside it, not a new format. */
const CURRENT_KEY_ID = "k0";

/**
 * Where an encrypted value lives: what it is, whose it is, and which
 * slot holds it. Every value is sealed to its slot (as AES-GCM
 * associated data), so a ciphertext copied into another row, another
 * slot, or another organization fails to decrypt instead of handing that
 * owner somebody else's key.
 *
 * Only identifiers that never change for the life of the value go in a
 * slot: an organization id (null in local mode), a row's uuid, a secret's
 * name (the routes upsert by name and never rename). A field a route can
 * edit in place (a server's URL, a credential's kind) stays out, or every
 * edit would have to re-encrypt.
 */
export type SecretSlot =
  /** `secrets.ciphertext`: an agent credential, keyed by (organization, name). */
  | { kind: "org_secret"; organizationId: string | null; name: string }
  /** `custom_model_providers.encrypted_api_key`. */
  | { kind: "custom_provider_key"; organizationId: string | null; providerId: string }
  /** `linear_connections.encrypted_api_key`: one connection per organization. */
  | { kind: "linear_api_key"; organizationId: string | null }
  /** `linear_connections.encrypted_webhook_secret`. */
  | { kind: "linear_webhook_secret"; organizationId: string | null }
  /** `slack_connections.encrypted_bot_token`: one connection per organization. */
  | { kind: "slack_bot_token"; organizationId: string | null }
  /** `mcp_servers.encrypted_client_secret`. */
  | { kind: "mcp_client_secret"; organizationId: string | null; serverId: string }
  /**
   * `mcp_credentials.encrypted_secret` ("access") and
   * `encrypted_refresh_token` ("refresh"), keyed like the table's unique
   * index: the server, and the member (null for the team's own row).
   */
  | {
    kind: "mcp_credential";
    organizationId: string | null;
    serverId: string;
    userId: string | null;
    part: "access" | "refresh";
  }
  /** `mcp_oauth_codes.token_bundle`, sealed to the connection it was minted for. */
  | { kind: "mcp_oauth_code"; organizationId: string | null; connectionId: string }
  /** The PKCE verifier carried in a signed MCP OAuth state; never stored. */
  | { kind: "mcp_oauth_verifier"; organizationId: string | null; userId: string; serverId: string; scope: string };

/**
 * The slot's fields in a fixed order. Encoded as a JSON array, so a null
 * organization, an empty string and a separator inside an id can never
 * read as one another.
 */
function slotFields(slot: SecretSlot): (string | null)[] {
  switch (slot.kind) {
    case "org_secret":
      return [slot.kind, slot.organizationId, slot.name];
    case "custom_provider_key":
      return [slot.kind, slot.organizationId, slot.providerId];
    case "linear_api_key":
    case "linear_webhook_secret":
    case "slack_bot_token":
      return [slot.kind, slot.organizationId];
    case "mcp_client_secret":
      return [slot.kind, slot.organizationId, slot.serverId];
    case "mcp_credential":
      return [slot.kind, slot.organizationId, slot.serverId, slot.userId, slot.part];
    case "mcp_oauth_code":
      return [slot.kind, slot.organizationId, slot.connectionId];
    case "mcp_oauth_verifier":
      return [slot.kind, slot.organizationId, slot.userId, slot.serverId, slot.scope];
  }
}

function associatedData(version: string, keyId: string, slot: SecretSlot): Buffer {
  return Buffer.from(JSON.stringify(["bento-secret", version, keyId, ...slotFields(slot)]), "utf8");
}

/** A value written before slots existed: `iv:tag:ciphertext`, bound to nothing. */
export function isLegacySecret(stored: string): boolean {
  return !stored.startsWith(`${VERSION}:`);
}

/** A stored value this server will not read; the message never carries the value. */
export class SecretUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnreadable";
  }
}

/**
 * Encryption at rest for credentials: agent API keys, MCP and OAuth
 * tokens, custom provider keys, Linear and Slack tokens.
 *
 * Values are encrypted with a key held only by the server, and are never
 * returned by any route: the UI shows names and a masked hint. Plaintext
 * leaves the database only into this server's own memory, for the use
 * the credential exists for. In multi mode the model proxy
 * (`routes/model-proxy.ts`) decrypts a provider key per request and
 * sends it upstream itself, so a proxied key never enters a sandbox; the
 * MCP gateway does the same with MCP credentials, and the Linear, Slack
 * and GitHub clients with theirs. A key still reaches a sandbox in
 * plaintext when it is not proxied: local mode, an adapter that does
 * not list it in `modelProxy`, a saved base URL the proxy will not
 * fetch, a login token, a custom provider's key (`resolveAgentEnv`,
 * `planModelProxy` and `proxyModelCredentials` decide which).
 *
 * AES-256-GCM is authenticated, so a tampered ciphertext fails to
 * decrypt rather than yielding attacker-chosen plaintext, and every value
 * is sealed to its `SecretSlot`, so database write access alone cannot
 * move one organization's key into another's row.
 */
export class SecretBox {
  private key: Buffer;
  /**
   * Names the key a value was written under, so a keyring can later pick
   * the right one without a new format. Ids match `^k[0-9a-z]{1,15}$`;
   * `k0` is today's single `BENTO_SECRET_KEY`, and a legacy unprefixed
   * value was written under it too.
   */
  readonly keyId = CURRENT_KEY_ID;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("BENTO_SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32");
    }
    // Hashing accepts a passphrase of any length while giving AES the
    // exact 32 bytes it needs.
    this.key = createHash("sha256").update(secret).digest();
  }

  /** Returns `v2:<key id>:<iv>:<tag>:<ciphertext>`, base64 each, sealed to `slot`. */
  encrypt(plaintext: string, slot: SecretSlot): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(associatedData(VERSION, this.keyId, slot));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.keyId, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  /**
   * Decrypts a value sealed to `slot`. A value sealed anywhere else, under
   * another key, tampered with, or still in the legacy unbound format
   * throws. Legacy values are upgraded in place at boot
   * (`upgradeLegacySecrets`), so none should be left for a read to meet.
   */
  decrypt(stored: string, slot: SecretSlot): string {
    if (isLegacySecret(stored)) {
      throw new SecretUnreadable("secret is in the legacy unbound format, which is no longer read");
    }
    const [, keyId, ivPart, tagPart, dataPart, extra] = stored.split(":");
    if (!keyId || !ivPart || !tagPart || dataPart === undefined || extra !== undefined) {
      throw new SecretUnreadable("secret is not in the expected format");
    }
    if (keyId !== this.keyId) throw new SecretUnreadable(`secret names key ${JSON.stringify(keyId.slice(0, 16))}, which this server does not hold`);
    const tag = Buffer.from(tagPart, "base64");
    if (tag.length !== AUTH_TAG_LENGTH) throw new SecretUnreadable("secret has a malformed authentication tag");

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64"));
    decipher.setAAD(associatedData(VERSION, keyId, slot));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretUnreadable("secret does not belong to this slot, or was tampered with");
    }
  }

  /**
   * Reads a legacy `iv:tag:ciphertext` value (written under key `k0`, the
   * only key there has been) and returns it re-encrypted,
   * sealed to `slot`. Only the boot upgrade calls this: it is the one
   * place an unbound value is still read, and it seals the value to the
   * row it was found in.
   */
  upgradeLegacy(stored: string, slot: SecretSlot): string {
    if (!isLegacySecret(stored)) throw new SecretUnreadable("secret is already in the current format");
    const [ivPart, tagPart, dataPart, extra] = stored.split(":");
    if (!ivPart || !tagPart || dataPart === undefined || extra !== undefined) {
      throw new SecretUnreadable("secret is not in the expected format");
    }
    const tag = Buffer.from(tagPart, "base64");
    if (tag.length !== AUTH_TAG_LENGTH) throw new SecretUnreadable("secret has a malformed authentication tag");
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(tag);
    let plaintext: string;
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretUnreadable("legacy secret was encrypted under a different key, or was tampered with");
    }
    return this.encrypt(plaintext, slot);
  }
}

/** Why a stored value was refused, for a log line. Never the value. */
export function unreadableReason(err: unknown): string {
  return err instanceof SecretUnreadable ? err.message : err instanceof Error ? err.name : "unknown error";
}

/**
 * A non-reversible hint, so someone can tell which key is stored without
 * the value being recoverable. Short values show nothing at all.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(8);
  return `${"•".repeat(8)}${plaintext.slice(-4)}`;
}
