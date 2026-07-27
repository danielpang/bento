import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Envelope encryption for organization secrets (agent API keys).
 *
 * Values are encrypted at rest with a key held only by the server, and
 * are never returned by any route: the UI shows names and a masked hint,
 * and plaintext leaves the database only on its way into a sandbox.
 *
 * AES-256-GCM is authenticated, so a tampered ciphertext fails to
 * decrypt rather than yielding attacker-chosen plaintext.
 */
export class SecretBox {
  private key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("BENTO_SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32");
    }
    // Hashing accepts a passphrase of any length while giving AES the
    // exact 32 bytes it needs.
    this.key = createHash("sha256").update(secret).digest();
  }

  /** Returns iv:tag:ciphertext, base64 each, so rotation can be detected. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  decrypt(stored: string): string {
    const [ivPart, tagPart, dataPart] = stored.split(":");
    if (!ivPart || !tagPart || !dataPart) throw new Error("secret is not in the expected format");
    const tag = Buffer.from(tagPart, "base64");
    if (tag.length !== AUTH_TAG_LENGTH) throw new Error("secret has a malformed authentication tag");

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
  }
}

/**
 * A non-reversible hint, so someone can tell which key is stored without
 * the value being recoverable. Short values show nothing at all.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(8);
  return `${"•".repeat(8)}${plaintext.slice(-4)}`;
}
