import { MAX_SWARM_GOAL_CHARS, MAX_SWARM_WORKERS } from "@bento/core";
import { useState } from "react";
import { Modal } from "./Modal.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { NewSwarmInput } from "../swarm/types.js";
import type { SwarmAgent } from "../swarm/client.js";
import { SwarmAgentSelect } from "./SwarmAgentSelect.js";
import {
  DEFAULT_RUN_SETTINGS,
  SwarmRunSettingsFields,
  budgetHelp,
  parseBudget,
  parseTimeLimit,
  runSettingsSummary,
  settingsFrom,
  timeLimitHelp,
  type RunSettingsDraft,
} from "./SwarmSettingsFields.js";

/**
 * Starting a swarm.
 *
 * The dialog asks for the goal, the agents, and the limits, each
 * already filled with what most swarms want, so a name and a goal are
 * enough to press Create. Everything else about how the swarm is run
 * waits behind More settings, with one line saying what it is set to,
 * and can be changed later in the swarm's own settings.
 *
 * It asks for what the create route takes and nothing else. A field
 * the server has no home for is a promise the console cannot keep, so
 * the branch is a preview of the one the server will name rather than
 * a choice, and there is no plan only box: a swarm always plans first
 * and waits for Start.
 */
export function NewSwarmDialog({
  projectId,
  agents,
  surfaces,
  busy,
  onClose,
  onCreate,
}: {
  projectId: string;
  agents: SwarmAgent[];
  surfaces: ModeSurfaces;
  busy?: boolean;
  onClose: () => void;
  onCreate: (input: NewSwarmInput) => Promise<void>;
}) {
  /*
   * The install's own Swarm Planner and Swarm Worker when they exist,
   * and otherwise the empty choice, which the server answers by making
   * them. Never "the first agent in the list": that is whichever one
   * somebody happened to create first, and a person who did not look
   * would get it as their planner.
   */
  const [plannerChoice, setPlannerChoice] = useState<string | null>(null);
  const [workerChoice, setWorkerChoice] = useState<string | null>(null);
  const plannerProfileId = plannerChoice ?? agents.find((agent) => agent.name === "Swarm Planner")?.id ?? "";
  const workerProfileId = workerChoice ?? agents.find((agent) => agent.name === "Swarm Worker")?.id ?? "";
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState("");
  const [budget, setBudget] = useState("");
  const [timeLimit, setTimeLimit] = useState("");
  const [workers, setWorkers] = useState(clampWorkers(surfaces.defaultSwarmWorkers, MAX_SWARM_WORKERS));
  /**
   * A branch that already exists, to continue.
   *
   * Empty is the ordinary case and means a new branch cut from the
   * repository's default branch. A name here says the work carries on
   * somebody's feature branch, and the planner's first turn then
   * carries what is on it and what its pull request is still being
   * asked about.
   */
  const [startBranch, setStartBranch] = useState("");
  const [deliverable, setDeliverable] = useState<"code" | "document">("code");
  const [runSettings, setRunSettings] = useState<RunSettingsDraft>(DEFAULT_RUN_SETTINGS);

  // The server names the branch after the swarm, so this is a preview
  // of what it will be rather than a choice.
  const branchName = suggestBranch(name);
  const continuing = startBranch.trim();
  const branchRefusal = continuing && !isBranchName(continuing) ? branchNameRefusal : null;
  const goalLength = goal.trim().length;
  const goalTooLong = goalLength > MAX_SWARM_GOAL_CHARS;
  const budgetUsd = parseBudget(budget);
  const timeLimitMin = parseTimeLimit(timeLimit);
  const ready =
    name.trim() !== "" &&
    goalLength > 0 &&
    !goalTooLong &&
    branchRefusal === null &&
    budgetUsd !== undefined &&
    timeLimitMin !== undefined;

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
            aria-invalid={goalTooLong}
            aria-describedby="new-swarm-goal-length"
          />
          <span id="new-swarm-goal-length" className={goalTooLong ? "error" : "muted"}>
            {goalLength.toLocaleString()} / {MAX_SWARM_GOAL_CHARS.toLocaleString()} characters
            {goalTooLong ? ". Shorten the goal to create this swarm." : ""}
          </span>
        </label>

        <div className="field-row swarm-agent-row">
          <SwarmAgentSelect
            label="Planner agent"
            value={plannerProfileId}
            agents={agents}
            onChange={setPlannerChoice}
            fallback="Swarm Planner (created for you)"
          />
          <SwarmAgentSelect
            label="Worker agent"
            value={workerProfileId}
            agents={agents}
            onChange={setWorkerChoice}
            fallback="Swarm Worker (created for you)"
          />
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-heading">Workers at once</span>
            <input
              className="input"
              type="number"
              min={1}
              max={MAX_SWARM_WORKERS}
              value={workers}
              onChange={(e) => setWorkers(clampWorkers(Number(e.target.value), MAX_SWARM_WORKERS))}
            />
            <span className="muted">Up to {MAX_SWARM_WORKERS}. You can change this while it runs.</span>
          </label>
          <label className="field">
            <span className="field-heading">Budget</span>
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              placeholder="No cap"
              aria-invalid={budgetUsd === undefined}
              onChange={(e) => setBudget(e.target.value)}
            />
            <span className={budgetUsd === undefined ? "error" : "muted"}>{budgetHelp(budgetUsd)}</span>
          </label>
          <label className="field">
            <span className="field-heading">Time limit</span>
            <input
              className="input"
              inputMode="numeric"
              value={timeLimit}
              placeholder="No limit"
              aria-invalid={timeLimitMin === undefined}
              onChange={(e) => setTimeLimit(e.target.value)}
            />
            <span className={timeLimitMin === undefined ? "error" : "muted"}>{timeLimitHelp(timeLimitMin)}</span>
          </label>
        </div>

        <label className="field">
          <span className="field-heading">Start from a branch</span>
          <input
            className="input"
            value={startBranch}
            placeholder={branchName || "A new branch"}
            onChange={(e) => setStartBranch(e.target.value)}
          />
          <span className="muted">
            {continuing
              ? `This swarm starts from ${continuing}. The planner will see its existing work and pull request comments.`
              : "Leave blank for a new branch, or enter an existing branch to continue its work."}
          </span>
          {branchRefusal && <span className="swarm-reopen-refusal">{branchRefusal}</span>}
        </label>

        <details className="swarm-more-settings">
          <summary>
            <span className="field-heading">
              More settings <span className="swarm-more-marker" aria-hidden="true" />
            </span>
            <span className="muted">{runSettingsSummary(runSettings, agents, deliverable)}</span>
          </summary>
          <SwarmRunSettingsFields
            draft={runSettings}
            onChange={setRunSettings}
            agents={agents}
            deliverable={deliverable}
            onDeliverable={setDeliverable}
          />
        </details>

        <p className="muted">Creating a swarm starts the planner. Review its plan, then start the work.</p>

        {error && <p className="error error-box" role="alert">{error}</p>}
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
    setError("");
    void onCreate({
      projectId,
      name: name.trim(),
      goal: goal.trim(),
      ...(plannerProfileId ? { plannerProfileId } : {}),
      ...(workerProfileId ? { workerProfileId } : {}),
      settings: settingsFrom(runSettings),
      attachments: [],
      start: continuing ? { kind: "existing-branch", name: continuing } : { kind: "new-branch", name: branchName },
      deliverable,
      budgetUsd: budgetUsd ?? null,
      timeLimitMin: timeLimitMin ?? null,
      workers,
      planOnly: true,
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }
}

/** What the dialog says about a branch name git would refuse. */
export const branchNameRefusal =
  "A branch name has no spaces and no colons in it. Check what the branch is actually called, or leave this empty for a new one.";

/**
 * Whether this is a branch name, asked before the request is sent.
 *
 * The server asks the same question and is the one that decides; this
 * is here so a typo is a sentence under the field rather than a
 * refusal after the form has been submitted. Git's own rules, stated
 * positively: letters, digits, and the four characters branch names
 * use, in segments that do not start with a dot or end in ".lock".
 */
export function isBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("..") || value.includes("@{")) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"));
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

export function clampWorkers(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.round(value)), Math.max(1, max));
}
