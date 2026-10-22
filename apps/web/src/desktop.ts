import { useEffect, useState } from "react";

/** Only the Electron console's isolated preload supplies this narrow bridge. */
export interface DesktopBridge {
  openIntegration(tab: "github" | "slack" | "mcp"): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  settings(): Promise<void>;
  connection(): Promise<{ mode: "local" | "remote"; serverUrl: string }>;
}

export const desktop: DesktopBridge | undefined = typeof window === "undefined"
  ? undefined : (window as Window & { bentoDesktop?: DesktopBridge }).bentoDesktop;

/**
 * Where this desktop window's Bento runs: a local server on this Mac, or
 * a server elsewhere. Null outside the desktop app and until it answers.
 * Each window belongs to one connection, so the answer never changes.
 */
export function useDesktopConnection(): { mode: "local" | "remote"; serverUrl: string } | null {
  const [connection, setConnection] = useState<{ mode: "local" | "remote"; serverUrl: string } | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktop.connection().then((value) => { if (!cancelled) setConnection(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return connection;
}

/** OAuth state, provider cookies, and callbacks stay in the system browser. */
export async function startIntegration(tab: "github" | "slack" | "mcp", start: () => Promise<{ url: string }>): Promise<void> {
  if (desktop) await desktop.openIntegration(tab);
  else window.location.assign((await start()).url);
}

/** Refresh integration status on return, without losing unsaved form fields. */
export function useDesktopIntegrationRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!desktop) return;
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return revision;
}
