import { readFile } from "node:fs/promises";
import path from "node:path";

/** Cursor stores macOS logins in Keychain and Linux/Windows logins in auth.json. */
export async function cursorLoginEnv(options: {
  platform: NodeJS.Platform;
  home: string;
  xdgConfigHome?: string | undefined;
  appData?: string | undefined;
  readKeychain: (service: string) => Promise<string | null>;
}): Promise<Record<string, string>> {
  let token: unknown;
  let apiKey: unknown;
  if (options.platform === "darwin") {
    token = await options.readKeychain("cursor-access-token");
    if (!usableToken(token)) apiKey = await options.readKeychain("cursor-api-key");
  }
  if (!usableToken(token) && !nonempty(apiKey)) {
    const directory =
      options.platform === "darwin"
        ? path.join(options.home, ".cursor")
        : options.platform === "win32"
          ? path.join(options.appData || path.join(options.home, "AppData", "Roaming"), "Cursor")
          : path.join(options.xdgConfigHome || path.join(options.home, ".config"), "cursor");
    try {
      const auth = JSON.parse(await readFile(path.join(directory, "auth.json"), "utf8"));
      token = auth.accessToken;
      apiKey = auth.apiKey;
    } catch {
      return {};
    }
  }
  if (usableToken(token)) return { CURSOR_AUTH_TOKEN: token.trim() };
  if (nonempty(apiKey)) return { CURSOR_API_KEY: apiKey.trim() };
  return {};
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function usableToken(value: unknown): value is string {
  if (!nonempty(value)) return false;
  // Do not forward an expired JWT. The host retains the refresh token.
  try {
    const payload = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString());
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return false;
  } catch {
    // Opaque tokens are also accepted by Cursor.
  }
  return true;
}
