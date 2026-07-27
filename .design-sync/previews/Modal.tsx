import { Modal } from "@bento/web";

/** The shape every dialog in the console is built from. */
export function WithForm() {
  return (
    <Modal
      title="New agent"
      description="Pair a coding tool with a model. Assign it to a stage afterwards under Pipeline."
      onClose={() => {}}
      actions={
        <>
          <button className="btn btn-ghost">Cancel</button>
          <button className="btn btn-primary">Add agent</button>
        </>
      }
    >
      <label className="field">
        <span className="label">Tool</span>
        <select className="select" defaultValue="claude-code">
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex CLI</option>
        </select>
      </label>
      <label className="field">
        <span className="label">Name</span>
        <input className="input" defaultValue="Implementer" />
      </label>
    </Modal>
  );
}

/** A dialog that only asks. No form, one decision, and a way out. */
export function Confirmation() {
  return (
    <Modal
      title="Remove the GitHub token?"
      description="Pull requests can no longer be opened or updated until a new one is saved."
      onClose={() => {}}
      actions={
        <>
          <button className="btn btn-ghost">Cancel</button>
          <button className="btn btn-danger">Remove token</button>
        </>
      }
    />
  );
}
