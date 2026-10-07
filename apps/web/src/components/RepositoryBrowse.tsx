import { useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { desktop } from "../desktop.js";
import { useToast } from "./Toasts.js";

/**
 * Browse for a checkout instead of typing its path.
 *
 * The Mac app opens its own native picker. A browser cannot learn a
 * folder's path at all, so in local mode, where the server runs on the
 * same machine, the server opens the OS dialog and answers with the
 * path. Anywhere neither is possible (a shared server, a server in a
 * container) the button is not shown and the field is typed as before.
 */
export function RepositoryBrowse({
  client,
  onChoose,
  disabled = false,
}: {
  client: BentoClient;
  onChoose(path: string): void;
  disabled?: boolean;
}) {
  const [via, setVia] = useState<"desktop" | "server" | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    if (desktop) {
      void desktop
        .connection()
        .then((connection) => {
          if (!cancelled && connection.mode === "local") setVia("desktop");
        })
        .catch(() => {});
    } else {
      void client
        .folderPickerStatus()
        .then((status) => {
          if (!cancelled && status.available) setVia("server");
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!via) return null;

  async function browse() {
    setBusy(true);
    try {
      const path = via === "desktop" ? await desktop!.chooseDirectory() : (await client.pickFolder()).path;
      if (path) onChoose(path);
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : "Could not open the folder picker.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-ghost" disabled={disabled || busy} onClick={() => void browse()}>
      {busy ? "Choosing..." : "Browse..."}
    </button>
  );
}
