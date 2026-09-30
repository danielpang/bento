import { useState } from "react";
import { Modal } from "./Modal.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { NewSwarmInput } from "../swarm/types.js";

/**
 * Starting a swarm.
 *
 * A name and a goal are all it needs: the swarm runs as the install's
 * own Swarm Planner and Swarm Worker, which the server makes the first
 * time anybody asks, and starts with the workers this kind of install
 * can afford.
 *
 * It asks for what the create route takes and nothing else. A field
 * the server has no home for is a promise the console cannot keep, so
 * the branch is a preview of the one the server will name rather than
 * a choice, and there is no plan only box: a swarm always plans first
 * and waits for Start.
 */
export function NewSwarmDialog({
  projectId,
  surfaces,
  busy,
  onClose,
  onCreate,
}: {
  projectId: string;
  surfaces: ModeSurfaces;
  busy?: boolean;
  onClose: () => void;
  onCreate: (input: NewSwarmInput) => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [workers, setWorkers] = useState(surfaces.defaultSwarmWorkers);

  // The server names the branch after the swarm, so this is a preview
  // of what it will be rather than a choice.
  const branchName = suggestBranch(name);
  const ready = name.trim() !== "" && goal.trim() !== "";

  return (
    <Modal
      title="New swarm"
      onClose={onClose}
      large
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <div className="swarm-new">
        <label className="field">
          <span className="field-heading">Name</span>
          <input
            className="input"
            value={name}
            autoFocus
            placeholder="Checkout rewrite"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-heading">Goal</span>
          <textarea
            className="input textarea-grow"
            value={goal}
            rows={4}
            placeholder="What should be true when this is finished?"
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-heading">Budget</span>
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              placeholder="No cap"
              onChange={(e) => setBudget(e.target.value)}
            />
            <span className="muted">In dollars. Leave empty for no cap.</span>
          </label>
          <label className="field">
            <span className="field-heading">Workers</span>
            <input
              className="input"
              type="number"
              min={1}
              max={MAX_WORKERS}
              value={workers}
              onChange={(e) => setWorkers(clampWorkers(Number(e.target.value), MAX_WORKERS))}
            />
            <span className="muted">How many work at once. You can change this while it runs.</span>
          </label>
        </div>

        <p className="muted">
          Creating a swarm puts its planner to work. Nothing else starts until you have read the plan
          and pressed Start.
        </p>
      </div>
    </Modal>
  );

  /**
   * What the create route takes, and the fields the console still
   * carries for its own fixtures.
   *
   * A swarm always plans first and waits for Start, so plan only is
   * how every swarm begins rather than a box to tick.
   */
  function submit() {
    if (!ready) return;
    onCreate({
      projectId,
      name: name.trim(),
      goal: goal.trim(),
      attachments: [],
      start: { kind: "new-branch", name: branchName },
      deliverable: "code",
      budgetUsd: parseBudget(budget),
      workers,
      planOnly: true,
    });
  }
}

/** The most workers the create route takes. */
const MAX_WORKERS = 32;

/** A branch name from the swarm's name, as a placeholder and a default. */
export function suggestBranch(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `bento/${slug}` : "";
}

/** A typed budget as a number, or null for no cap. Never NaN. */
export function parseBudget(raw: string): number | null {
  const trimmed = raw.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function clampWorkers(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.round(value)), Math.max(1, max));
}
