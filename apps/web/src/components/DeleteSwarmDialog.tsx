import { useState } from "react";
import { Modal } from "./Modal.js";

/** Confirms removal and keeps a refusal beside the action that caused it. */
export function DeleteSwarmDialog({
  name,
  onClose,
  onDelete,
}: {
  name: string;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Delete ${name}?`}
      description="This permanently removes the swarm, its plan, runs, transcripts, artifacts, and workspaces. Published branches and pull requests remain. Stop the swarm first if agents are working. This cannot be undone."
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>Delete swarm</button>
        </>
      }
    >
      {error && <p className="error error-box" role="alert">{error}</p>}
    </Modal>
  );
}
