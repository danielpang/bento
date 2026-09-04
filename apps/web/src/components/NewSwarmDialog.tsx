import { useMemo, useState } from "react";
import { Modal } from "./Modal.js";
import { estimateSwarm, formatUsd, tierLabel, tierNote } from "../swarm/money.js";
import { creationNotes, type ModeSurfaces } from "../swarm/plan.js";
import type { NewSwarmInput, SwarmTemplate } from "../swarm/types.js";

/**
 * Starting a swarm.
 *
 * The dialog is a cost decision as much as a work decision, so the
 * template and its cost shape sit side by side: which model plans,
 * which model works, and which tier each tool will report in. A
 * person choosing a template is choosing how much of their bill will
 * be a measurement and how much a guess, and that is said here rather
 * than discovered on the header afterwards.
 *
 * Local mode drops the plan footer and the agent hours line, because
 * it has neither a plan nor an organization to bill, and shows the
 * dollar estimate alone. That is the only difference: one hook, not a
 * second dialog.
 */
export function NewSwarmDialog({
  projectId,
  templates,
  branches,
  surfaces,
  busy,
  onClose,
  onCreate,
}: {
  projectId: string;
  templates: SwarmTemplate[];
  /** Branches this project already has, for starting on one of them. */
  branches: string[];
  surfaces: ModeSurfaces;
  busy?: boolean;
  onClose: () => void;
  onCreate: (input: NewSwarmInput) => void;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const template = templates.find((entry) => entry.id === templateId) ?? templates[0] ?? null;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [attachments, setAttachments] = useState<{ name: string; bytes: number }[]>([]);
  const [startKind, setStartKind] = useState<"new-branch" | "existing-branch">("new-branch");
  const [branch, setBranch] = useState("");
  const [deliverable, setDeliverable] = useState<"code" | "document">("code");
  const [budget, setBudget] = useState("");
  const [workers, setWorkers] = useState(template?.maxWorkers ? Math.min(4, template.maxWorkers) : 4);
  const [planOnly, setPlanOnly] = useState(false);

  const leaves = template?.typicalLeaves ?? 0;
  const estimate = useMemo(
    () => (template ? estimateSwarm(template, leaves) : { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 }),
    [template, leaves],
  );

  const branchName =
    startKind === "new-branch"
      ? branch.trim() || suggestBranch(name)
      : branch.trim() || branches[0] || "";
  const ready = name.trim() !== "" && goal.trim() !== "" && template !== null && branchName !== "";

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
          <button
            className="btn"
            disabled={!ready || busy}
            onClick={() => submit(true)}
            title="Plan the work and stop before any worker starts"
          >
            Plan only
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => submit(false)}>
            Create
          </button>
        </>
      }
    >
      <div className="swarm-new">
        <div className="swarm-new-templates">
          <span className="label">Template</span>
          {templates.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="swarm-template"
              data-on={entry.id === templateId ? "" : undefined}
              aria-pressed={entry.id === templateId}
              onClick={() => {
                setTemplateId(entry.id);
                setWorkers((current) => Math.min(current, entry.maxWorkers));
              }}
            >
              <span className="swarm-template-name">{entry.name}</span>
              <span className="muted">{entry.description}</span>
            </button>
          ))}
        </div>

        {template && (
          <div className="swarm-new-shape">
            <span className="label">Cost shape</span>
            <dl className="swarm-shape">
              <div>
                <dt>Planner</dt>
                <dd>{template.plannerModel}</dd>
              </div>
              <div>
                <dt>Worker</dt>
                <dd>{template.workerModel}</dd>
              </div>
              <div>
                <dt>Assumed per task</dt>
                <dd>{formatUsd(template.assumedUsdPerLeaf)}</dd>
              </div>
            </dl>
            <ul className="swarm-tools">
              {template.tools.map((tool) => (
                <li key={tool.name} title={tierNote(tool.tier)}>
                  <span className="swarm-tool-name">{tool.name}</span>
                  <span className="chip" data-tier={tool.tier}>
                    {tierLabel(tool.tier)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Each tool reports its spend in one of three ways, and the swarm keeps them apart:
              measured is the tool&apos;s own figure, estimated comes from the tokens it printed, and
              assumed is this template&apos;s guess for a tool that reports nothing.
            </p>
          </div>
        )}

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

        <label className="field">
          <span className="field-heading">Attachments</span>
          <input
            type="file"
            className="input"
            multiple
            onChange={(e) =>
              setAttachments(
                Array.from(e.target.files ?? []).map((file) => ({ name: file.name, bytes: file.size })),
              )
            }
          />
          {attachments.length > 0 && (
            <ul className="swarm-attachments">
              {attachments.map((file) => (
                <li key={file.name}>
                  <span className="chip">{file.name}</span>
                </li>
              ))}
            </ul>
          )}
        </label>

        <div className="field">
          <span className="field-heading">Starting point</span>
          <div className="seg" role="group" aria-label="Starting point">
            <button
              type="button"
              className="seg-item"
              data-on={startKind === "new-branch" ? "" : undefined}
              onClick={() => setStartKind("new-branch")}
            >
              New branch
            </button>
            <button
              type="button"
              className="seg-item"
              data-on={startKind === "existing-branch" ? "" : undefined}
              onClick={() => setStartKind("existing-branch")}
            >
              Existing branch
            </button>
          </div>
          {startKind === "new-branch" ? (
            <input
              className="input"
              value={branch}
              placeholder={suggestBranch(name)}
              aria-label="New branch name"
              onChange={(e) => setBranch(e.target.value)}
            />
          ) : (
            <select
              className="select"
              value={branch}
              aria-label="Existing branch"
              onChange={(e) => setBranch(e.target.value)}
            >
              {branches.length === 0 && <option value="">No branches loaded</option>}
              {branches.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="field">
          <span className="field-heading">Deliverable</span>
          <div className="seg" role="group" aria-label="Deliverable">
            <button
              type="button"
              className="seg-item"
              data-on={deliverable === "code" ? "" : undefined}
              onClick={() => setDeliverable("code")}
            >
              Code
            </button>
            <button
              type="button"
              className="seg-item"
              data-on={deliverable === "document" ? "" : undefined}
              onClick={() => setDeliverable("document")}
            >
              Document
            </button>
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-heading">Budget</span>
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              placeholder={template?.maxBudgetUsd === null || template === null ? "No cap" : String(template.maxBudgetUsd)}
              onChange={(e) => setBudget(e.target.value)}
            />
            <span className="muted">
              {template?.maxBudgetUsd === null || template === null
                ? "This template sets no maximum."
                : `Up to ${formatUsd(template.maxBudgetUsd)} on this template.`}
            </span>
          </label>
          <label className="field">
            <span className="field-heading">Workers</span>
            <input
              className="input"
              type="number"
              min={1}
              max={template?.maxWorkers ?? 1}
              value={workers}
              onChange={(e) => setWorkers(clampWorkers(Number(e.target.value), template?.maxWorkers ?? 1))}
            />
            <span className="muted">Up to {template?.maxWorkers ?? 1} at once on this template.</span>
          </label>
        </div>

        <label className="field">
          <span className="field-heading">Plan only</span>
          <span className="swarm-checkline">
            <input type="checkbox" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />
            <span className="muted">
              Stop after the planner has split the goal, before any worker starts.
            </span>
          </span>
        </label>

        {/*
          * The money lines, and which of them this mode has.
          *
          * The estimate is split the three ways the run will report
          * in. Local mode has no plan and no agent hour pool, so it
          * gets the estimate and nothing else: one list, decided in
          * `creationNotes`, rather than three conditions to keep in
          * step.
          */}
        {template &&
          creationNotes(surfaces, estimate, leaves).map((note) => (
            <p key={note.id} className={note.emphasis ? "swarm-estimate" : "muted"}>
              {note.text}
            </p>
          ))}
      </div>
    </Modal>
  );

  function submit(onlyPlan: boolean) {
    if (!ready || !template) return;
    onCreate({
      projectId,
      templateId: template.id,
      name: name.trim(),
      goal: goal.trim(),
      attachments,
      start: { kind: startKind, name: branchName },
      deliverable,
      budgetUsd: parseBudget(budget),
      workers,
      planOnly: onlyPlan || planOnly,
    });
  }
}

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
