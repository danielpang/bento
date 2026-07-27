import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenStore } from "@bento/api-client";

const CONFIG_DIR = path.join(homedir(), ".bento");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

interface Credentials {
  baseUrl: string;
  token: string;
}

/**
 * Stores the bearer token from the device flow at ~/.bento/credentials.json
 * with owner-only permissions. The file holds a live session token, so
 * it is written 0600 and never logged.
 */
export class FileTokenStore implements TokenStore {
  private cached: string | null | undefined;

  constructor(private baseUrl: string) {}

  async get(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached;
    try {
      const raw = await readFile(CREDENTIALS_FILE, "utf8");
      const creds = JSON.parse(raw) as Credentials;
      this.cached = creds.baseUrl === this.baseUrl ? creds.token : null;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  async set(token: string | null): Promise<void> {
    this.cached = token;
    if (token === null) {
      await writeFile(CREDENTIALS_FILE, "{}", { mode: 0o600 }).catch(() => {});
      return;
    }
    await mkdir(CONFIG_DIR, { recursive: true });
    const payload: Credentials = { baseUrl: this.baseUrl, token };
    await writeFile(CREDENTIALS_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await chmod(CREDENTIALS_FILE, 0o600);
  }
}

export const credentialsPath = CREDENTIALS_FILE;
