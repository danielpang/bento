import path from "node:path";
import type { DesktopSettings } from "./contracts.js";

export const LAUNCHER_ORIGIN = "bento-desktop://launcher";

export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS server address without embedded credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter the server address without a path, query, or fragment.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote servers need HTTPS. HTTP is supported for a server on this Mac.");
  }
  return url.origin;
}

export function validateSettings(input: unknown): DesktopSettings {
  if (!input || typeof input !== "object") throw new Error("Connection settings are required.");
  const value = input as Record<string, unknown>;
  const string = (key: string, max = 4096) => {
    const result = value[key];
    if (typeof result !== "string" || result.length > max || result.includes("\0")) {
      throw new Error(`Invalid ${key}.`);
    }
    return result.trim();
  };
  const mode = value.mode;
  if (mode !== "local" && mode !== "remote") throw new Error("Choose a connection mode.");
  const sandbox = value.sandbox;
  if (sandbox !== "docker" && sandbox !== "local-process") throw new Error("Choose a sandbox driver.");
  const dataDir = string("dataDir");
  if (!path.isAbsolute(dataDir)) throw new Error("The data directory must be an absolute path.");
  const serverUrl = mode === "local" ? string("serverUrl") : normalizeServerUrl(string("serverUrl"));
  const databaseUrl = string("databaseUrl");
  if (databaseUrl && !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) {
    throw new Error("The database address must be a PostgreSQL URL.");
  }
  const sandboxImage = string("sandboxImage", 255);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(sandboxImage)) throw new Error("Enter a valid sandbox image name.");
  return { mode, sandbox, dataDir, serverUrl, databaseUrl, sandboxImage };
}

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/mcp/") ||
    pathname.startsWith("/mcp-oauth/") || pathname.startsWith("/.well-known/");
}

export function isConsolePage(pathname: string): boolean {
  return ["/", "/index.html", "/settings", "/sessions", "/spend", "/changelog", "/device", "/connect-mcp", "/accept-invitation", "/reset-password"].includes(pathname) ||
    /^\/(session|artifact)\/[0-9a-f-]{36}$/.test(pathname);
}

export function isTrustedConsoleUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && isConsolePage(url.pathname);
  } catch { return false; }
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function assetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const file = path.resolve(root, `.${decoded}`);
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? file : null;
}

/** Opaque artifact frames and foreign pages must never borrow the user's token. */
export function canProxyApi(initiatorOrigin: string | undefined, origin: string): boolean {
  return initiatorOrigin === origin;
}
