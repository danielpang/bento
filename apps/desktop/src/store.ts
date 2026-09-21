import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { safeStorage } from "electron";
import { validateSettings } from "./security.js";
import type { DesktopSettings } from "./contracts.js";

interface StoredData { settings: DesktopSettings; tokens: Record<string, string>; }

export class DesktopStore {
  configured = false;
  private data: StoredData = {
    settings: {
      mode: "local", serverUrl: "https://app.usebento.ai", dataDir: path.join(os.homedir(), ".bento"),
      databaseUrl: "", sandbox: "docker", sandboxImage: "bento-sandbox:dev",
    },
    tokens: {},
  };

  constructor(private directory: string) {}

  async load(): Promise<void> {
    let bytes: Buffer;
    try { bytes = await readFile(path.join(this.directory, "connections.enc")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Unlock your login keychain to open saved Bento connections.");
    const saved = JSON.parse(safeStorage.decryptString(bytes)) as StoredData;
    this.data = { settings: validateSettings(saved.settings), tokens: saved.tokens ?? {} };
    this.configured = true;
  }

  get settings(): DesktopSettings { return { ...this.data.settings }; }
  token(origin: string): string | null { return this.data.tokens[origin] ?? null; }

  async saveSettings(settings: DesktopSettings): Promise<void> {
    this.data.settings = validateSettings(settings);
    this.configured = true;
    await this.persist();
  }

  async setToken(origin: string, token: string | null): Promise<void> {
    if (token) this.data.tokens[origin] = token;
    else delete this.data.tokens[origin];
    await this.persist();
  }

  private writing: Promise<void> = Promise.resolve();
  private persist(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return Promise.reject(new Error("Unlock your login keychain to save this connection."));
    const bytes = safeStorage.encryptString(JSON.stringify(this.data));
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = path.join(this.directory, "connections.enc");
      await writeFile(`${destination}.tmp`, bytes, { mode: 0o600 });
      await rename(`${destination}.tmp`, destination);
    });
    return this.writing;
  }
}
