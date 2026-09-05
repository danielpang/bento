import { useMemo, useState } from "react";
import { Modal } from "./Modal.js";
import { estimateSwarm, formatUsd, tierLabel, tierNote } from "../swarm/money.js";
import { creationNotes, type ModeSurfaces } from "../swarm/plan.js";
import type { NewSwarmInput, SwarmTemplate } from "../swarm/types.js";

/**
 * Starting a swarm.
 *
 * The dialog is a cost decision as much as a work decision, so a
 * template's cost shape sits beside it where it has one: which model
 * plans, which model works, and which tier each tool reports in. A
 * person choosing a template is choosing how much of their bill will
 * be a measurement and how much a guess, and that is said here rather
 * than discovered on the header afterwards.
 *
 * It asks for what the create route takes and nothing else. A field
 * the server has no home for is a promise the console cannot keep, so
 * the branch is a preview of the one the server will name rather than
 * a choice, and there is no plan only box: a swarm always plans first
 * and waits for Start.
 *
 * Local mode drops the plan footer and the agent hours line, because
 * it has neither a plan nor an organization to bill, and shows the
 * dollar estimate alone. That is the only difference: one hook, not a
 * second dialog.
 */
export function NewSwarmDialog({
  projectId,
  templates,
  surfaces,
  busy,
  onClose,
  onCreate,
}: {
  projectId: string;
  templates: SwarmTemplate[];
  surfaces: ModeSurfaces;
  busy?: boolean;
  onClose: () => void;
  onCreate: (input: NewSwarmInput) => void;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const template = templates.find((entry) => entry.id === templateId) ?? templates[0] ?? null;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [workers, setWorkers] = useState(template?.maxWorkers ? Math.min(4, template.maxWorkers) : 4);

  const leaves = template?.typicalLeaves ?? 0;
  const estimate = useMemo(
    () => (template ? estimateSwarm(template, leaves) : { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 }),
    [template, leaves],
  );
  /**
   * Whether this template says what a run of it costs.
   *
   * Templates carry ceilings today and no cost shape, and an estimate
   * of nothing printed as a figure would read as a swarm that is free.
   * So the shape and the estimate are drawn when there is one and left
   * out when there is not.
   */
  const hasCostShape = (template?.tools.length ?? 0) > 0 || leaves > 0;

  // The server names the branch after the swarm, so this is a preview
  // of what it will be rather than a choice.
  const branchName = suggestBranch(name);
  const ready = name.trim() !== "" && goal.trim() !== "" && template !== null;

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

        {template && hasCostShape && (
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

        {/*
          * The money lines, and which of them this mode has.
          *
          * The estimate is split the three ways the run will report
          * in. Local mode has no plan and no agent hour pool, so it
          * gets the estimate and nothing else: one list, decided in
          * `creationNotes`, rather than three conditions to keep in
          * step.
          */}
        <p className="muted">
          Creating a swarm puts its planner to work. Nothing else starts until you have read the plan
          and pressed Start.
        </p>

        {template &&
          hasCostShape &&
          creationNotes(surfaces, estimate, leaves).map((note) => (
            <p key={note.id} className={note.emphasis ? "swarm-estimate" : "muted"}>
              {note.text}
            </p>
          ))}
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
    if (!ready || !template) return;
    onCreate({
      projectId,
      templateId: template.id,
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
