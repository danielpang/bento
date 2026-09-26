import { useState } from "react";
import { Modal } from "./Modal.js";

/** The longest name the route takes, so Save refuses before the round trip. */
const MAX_NAME = 120;

/**
 * Names the template a swarm is being saved as.
 *
 * A Modal rather than window.prompt, which the desktop app does not
 * implement at all: in Electron the call throws in the renderer, so the
 * button did nothing and said nothing. Every other question this
 * console asks is a Modal, and this is not the one to be different.
 */
export function SaveTemplateDialog({
  suggested,
  busy,
  onSave,
  onClose,
}: {
  suggested: string;
  busy: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(suggested.slice(0, MAX_NAME));
  const ready = name.trim() !== "" && !busy;

  return (
    <Modal
      title="Save as template"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => onSave(name.trim())}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-heading">Name</span>
        <input
          className="input"
          value={name}
          maxLength={MAX_NAME}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onSave(name.trim());
          }}
        />
        <span className="muted">
          This swarm's workers, budget and time limit, on top of the template it was started from.
        </span>
      </label>
    </Modal>
  );
}
