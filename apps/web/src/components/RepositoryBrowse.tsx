import { useEffect, useState } from "react";
import { desktop } from "../desktop.js";
import { useToast } from "./Toasts.js";

export function RepositoryBrowse({ onChoose, disabled = false }: { onChoose(path: string): void; disabled?: boolean }) {
  const [local, setLocal] = useState(false);
  const toast = useToast();
  useEffect(() => { void desktop?.connection().then((connection) => setLocal(connection.mode === "local")).catch(() => {}); }, []);
  if (!local || !desktop) return null;
  return <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => {
    void desktop?.chooseDirectory().then((path) => { if (path) onChoose(path); }).catch((error: unknown) => {
      toast.fail(error instanceof Error ? error.message : "Could not open the folder picker.");
    });
  }}>Browse...</button>;
}
