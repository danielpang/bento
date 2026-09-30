import { MAX_PLAN_DEPTH } from "@bento/core";
import { useId, useState } from "react";
import { Modal } from "./Modal.js";
import { SwarmAgentSelect } from "./SwarmAgentSelect.js";
import type { SwarmAgent } from "../swarm/client.js";
import type { Swarm, SwarmSettings, SwarmSettingsChange } from "../swarm/types.js";

/**
 * How a swarm is run, beyond its agents and ceilings, as a form edits it.
 *
 * Strings rather than nulls, because that is what inputs hold: an empty
 * judge is "no judge" and an empty command or instruction is "none".
 * `settingsFrom` turns it back into what the route takes.
 */
export interface RunSettingsDraft {
  judgeProfileId: string;
  completionCommand: string;
  maxPlanDepth: number;
  plannerInstructions: string;
  workerInstructions: string;
}

/** What a swarm does when nobody changes anything. */
export const DEFAULT_RUN_SETTINGS: RunSettingsDraft = {
  judgeProfileId: "",
  completionCommand: "",
  maxPlanDepth: 1,
  plannerInstructions: "",
  workerInstructions: "",
};

export function draftFrom(settings: SwarmSettings): RunSettingsDraft {
  return {
    judgeProfileId: settings.judgeProfileId ?? "",
    completionCommand: settings.completionCommand ?? "",
    maxPlanDepth: settings.maxPlanDepth,
    plannerInstructions: settings.plannerInstructions ?? "",
    workerInstructions: settings.workerInstructions ?? "",
  };
}

export function settingsFrom(draft: RunSettingsDraft): Omit<SwarmSettings, "plannerProfileId" | "workerProfileId"> {
  return {
    judgeProfileId: draft.judgeProfileId || null,
    completionCommand: draft.completionCommand.trim() || null,
    maxPlanDepth: draft.maxPlanDepth,
    plannerInstructions: draft.plannerInstructions.trim() || null,
    workerInstructions: draft.workerInstructions.trim() || null,
  };
}

/** The planning choices, in words, from the one the planner does alone. */
const PLAN_DEPTHS: { depth: number; label: string }[] = [
  { depth: 1, label: "The planner writes the whole plan" },
  { depth: 2, label: "The planner may hand a large part to a sub planner" },
  { depth: 3, label: "Sub planners may hand parts on once more" },
].filter((option) => option.depth <= MAX_PLAN_DEPTH);

/**
 * One line saying what the collapsed section is set to.
 *
 * So a person who never opens it still reads what the swarm will do,
 * and one who changed something sees it without opening it again.
 */
export function runSettingsSummary(
  draft: RunSettingsDraft,
  agents: SwarmAgent[],
  deliverable?: "code" | "document",
): string {
  const parts: string[] = [];
  if (deliverable) parts.push(deliverable === "document" ? "writes a document" : "changes code");
  const judge = agents.find((agent) => agent.id === draft.judgeProfileId);
  const command = draft.completionCommand.trim();
  // Every part opens with a word of ours, so capitalising the first
  // letter below never changes a command or an agent's name.
  if (judge && command) parts.push(`final check by ${judge.name} after ${command}`);
  else if (judge) parts.push(`final check by ${judge.name}`);
  else if (command) parts.push(`final check runs ${command}`);
  else parts.push("no final check");
  parts.push(draft.maxPlanDepth > 1 ? "sub planners allowed" : "one planner");
  const instructed = [draft.plannerInstructions, draft.workerInstructions].filter((text) => text.trim()).length;
  if (instructed > 0) parts.push(instructed === 2 ? "planner and worker instructions" : "extra instructions");
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1) + ".";
}

/**
 * The fields themselves, shared by the New swarm dialog and a swarm's
 * settings so the two cannot describe the same setting differently.
 *
 * Grouped by the question each answers, with a sentence under each
 * group, because none of these mean much from the label alone.
 */
export function SwarmRunSettingsFields({
  draft,
  onChange,
  agents,
  deliverable,
  onDeliverable,
}: {
  draft: RunSettingsDraft;
  onChange: (draft: RunSettingsDraft) => void;
  agents: SwarmAgent[];
  /** Only at creation: what a swarm produces is fixed once it exists. */
  deliverable?: "code" | "document";
  onDeliverable?: (value: "code" | "document") => void;
}) {
  const set = (change: Partial<RunSettingsDraft>) => onChange({ ...draft, ...change });
  const idPrefix = useId();
  return (
    <div className="swarm-settings-fields">
      {deliverable && onDeliverable && (
        <fieldset className="swarm-settings-group">
          <legend className="field-heading">What it produces</legend>
          <div className="board-filters" role="radiogroup" aria-label="What it produces">
            {(
              [
                ["code", "Code change"],
                ["document", "Document"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="board-filter"
                role="radio"
                aria-checked={deliverable === value}
                aria-pressed={deliverable === value}
                onClick={() => onDeliverable(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="muted">
            {deliverable === "document"
              ? "Each worker writes a section, and the planner assembles them into one file on the branch."
              : "Each worker makes a change on its own branch, and they land on the swarm's branch one at a time."}
          </span>
        </fieldset>
      )}

      <fieldset className="swarm-settings-group">
        <legend className="field-heading">Final check</legend>
        <span className="muted">Runs once everything else is done. Either one can send work back.</span>
        <div className="field-row">
          <SwarmAgentSelect
            label="Judge agent"
            value={draft.judgeProfileId}
            agents={agents}
            onChange={(judgeProfileId) => set({ judgeProfileId })}
            fallback="None"
          />
          <label className="field">
            <span className="field-heading">Command that must pass</span>
            <input
              className="input"
              value={draft.completionCommand}
              placeholder="pnpm test"
              spellCheck={false}
              onChange={(event) => set({ completionCommand: event.target.value })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="swarm-settings-group">
        <legend className="field-heading">Planning</legend>
        <select
          className="input"
          aria-label="How the plan is written"
          aria-describedby={`${idPrefix}-planning-help`}
          value={draft.maxPlanDepth}
          onChange={(event) => set({ maxPlanDepth: Number(event.target.value) })}
        >
          {PLAN_DEPTHS.map((option) => (
            <option key={option.depth} value={option.depth}>
              {option.label}
            </option>
          ))}
        </select>
        <span id={`${idPrefix}-planning-help`} className="muted">
          Sub planners help with very large goals. Most swarms need only one planner.
        </span>
      </fieldset>

      <fieldset className="swarm-settings-group">
        <legend className="field-heading">Instructions</legend>
        <span className="muted">Optional. Added to every prompt the planner or the workers get.</span>
        <label className="field">
          <span className="field-heading">For the planner</span>
          <textarea
            className="input textarea-grow"
            rows={2}
            value={draft.plannerInstructions}
            placeholder="Split the work by package."
            onChange={(event) => set({ plannerInstructions: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-heading">For the workers</span>
          <textarea
            className="input textarea-grow"
            rows={2}
            value={draft.workerInstructions}
            placeholder="Add a test for every change."
            onChange={(event) => set({ workerInstructions: event.target.value })}
          />
        </label>
      </fieldset>
    </div>
  );
}

/** A typed budget as a number, null for no cap, or undefined when it is not a number. */
function parseMoney(raw: string): number | null | undefined {
  const trimmed = raw.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Typed minutes as a whole number, null for no limit, or undefined when it is not one. */
function parseMinutes(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * A swarm's settings, changed after it exists.
 *
 * Everything the New swarm dialog asked, except the goal and what it
 * produces, which are what the swarm is and are changed by a follow up
 * rather than in place. Saves only what was changed, so opening this
 * and pressing Save changes nothing.
 */
export function SwarmSettingsDialog({
  swarm,
  agents,
  busy,
  onClose,
  onSave,
}: {
  swarm: Swarm;
  agents: SwarmAgent[];
  busy?: boolean;
  onClose: () => void;
  onSave: (change: SwarmSettingsChange) => Promise<void>;
}) {
  const initial = draftFrom(swarm.settings);
  const [planner, setPlanner] = useState(swarm.settings.plannerProfileId ?? "");
  const [worker, setWorker] = useState(swarm.settings.workerProfileId ?? "");
  const [budget, setBudget] = useState(swarm.budgetUsd === null ? "" : String(swarm.budgetUsd));
  const [timeLimit, setTimeLimit] = useState(swarm.timeLimitMin === null ? "" : String(swarm.timeLimitMin));
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");

  const budgetUsd = parseMoney(budget);
  const timeLimitMin = parseMinutes(timeLimit);
  const ready = budgetUsd !== undefined && timeLimitMin !== undefined && planner !== "";

  return (
    <Modal
      title="Swarm settings"
      onClose={onClose}
      large
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="swarm-new">
        <div className="field-row swarm-agent-row">
          <SwarmAgentSelect
            label="Planner agent"
            value={planner}
            agents={agents}
            onChange={setPlanner}
            fallback="Choose an agent"
          />
          <SwarmAgentSelect
            label="Worker agent"
            value={worker}
            agents={agents}
            onChange={setWorker}
            fallback="Choose an agent"
          />
        </div>
        <span className="muted">A new agent takes over from the next task it starts. Work already running is not interrupted.</span>

        <div className="field-row">
          <label className="field">
            <span className="field-heading">Budget</span>
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              placeholder="No cap"
              aria-invalid={budgetUsd === undefined}
              onChange={(event) => setBudget(event.target.value)}
            />
            <span className={budgetUsd === undefined ? "error" : "muted"}>
              {budgetUsd === undefined ? "Enter an amount in dollars, or leave it empty for no cap." : "Leave empty for no cap."}
            </span>
          </label>
          <label className="field">
            <span className="field-heading">Time limit</span>
            <input
              className="input"
              inputMode="numeric"
              value={timeLimit}
              placeholder="No limit"
              aria-invalid={timeLimitMin === undefined}
              onChange={(event) => setTimeLimit(event.target.value)}
            />
            <span className={timeLimitMin === undefined ? "error" : "muted"}>
              {timeLimitMin === undefined ? "Enter whole minutes, or leave it empty for no limit." : "In minutes. Leave empty for no limit."}
            </span>
          </label>
        </div>

        <SwarmRunSettingsFields draft={draft} onChange={setDraft} agents={agents} />

        {error && <p className="error error-box" role="alert">{error}</p>}
      </div>
    </Modal>
  );

  function save() {
    if (!ready) return;
    setError("");
    const before = settingsFrom(initial);
    const after = settingsFrom(draft);
    const change: SwarmSettingsChange = {};
    if (planner !== (swarm.settings.plannerProfileId ?? "")) change.plannerProfileId = planner;
    if (worker && worker !== (swarm.settings.workerProfileId ?? "")) change.workerProfileId = worker;
    if (after.judgeProfileId !== before.judgeProfileId) change.judgeProfileId = after.judgeProfileId;
    if (after.completionCommand !== before.completionCommand) change.completionCommand = after.completionCommand;
    if (after.maxPlanDepth !== before.maxPlanDepth) change.maxPlanDepth = after.maxPlanDepth;
    if (after.plannerInstructions !== before.plannerInstructions) change.plannerInstructions = after.plannerInstructions;
    if (after.workerInstructions !== before.workerInstructions) change.workerInstructions = after.workerInstructions;
    if (budgetUsd !== swarm.budgetUsd) change.budgetUsd = budgetUsd ?? null;
    if (timeLimitMin !== swarm.timeLimitMin) change.timeLimitMin = timeLimitMin ?? null;
    void onSave(change).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }
}
