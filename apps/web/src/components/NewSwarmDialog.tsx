import {
  MAX_SWARM_GOAL_CHARS,
  MAX_SWARM_PLAN_CHARS,
  MAX_SWARM_PLAN_SOURCES,
  MAX_SWARM_PLAN_SOURCE_CHARS,
  MAX_SWARM_PLAN_SOURCE_NAME_CHARS,
  MAX_SWARM_WORKERS,
} from "@bento/core";
import { useRef, useState } from "react";
import { Modal } from "./Modal.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { NewPlanSource, NewSwarmInput } from "../swarm/types.js";
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
 * Between the goal and the agents is the plan: files a person already
 * has, read here as text, and pages the server fetches for them, with
 * a switch that says whether those are the plan to implement or
 * material to plan from. The switch is the difference between a
 * planner that reads a document and plans anyway, and one that turns
 * the document into the tree.
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
  /**
   * The plan the person already has, and whether it is the plan.
   *
   * Files are read in the browser as text, so what travels is what
   * the planner reads and a file that is not text is refused here,
   * with a sentence, rather than after the request. Addresses travel
   * as addresses: the server fetches them, through the same guarded
   * fetch every other tenant chosen URL goes through.
   */
  const [planSources, setPlanSources] = useState<NewPlanSource[]>([]);
  const [existingPlan, setExistingPlan] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [planRefusal, setPlanRefusal] = useState("");
  /** Files still being read. Create waits for them. */
  const [reading, setReading] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

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
    timeLimitMin !== undefined &&
    reading === 0;

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
            placeholder={existingPlan ? "What should the swarm do with the plan?" : "What should be true when this is finished?"}
            onChange={(e) => setGoal(e.target.value)}
            aria-invalid={goalTooLong}
            aria-describedby="new-swarm-goal-length"
          />
          <span id="new-swarm-goal-length" className={goalTooLong ? "error" : "muted"}>
            {goalLength.toLocaleString()} / {MAX_SWARM_GOAL_CHARS.toLocaleString()} characters
            {goalTooLong ? ". Shorten the goal to create this swarm." : ""}
          </span>
        </label>

        <fieldset className="field swarm-plan-field" aria-label="Plan">
          <legend className="field-heading">Plan</legend>
          <span className="muted">
            Already have a plan? Upload it as one or more text files, or point at a page, and the planner reads it before it plans.
          </span>
          <div className="swarm-plan-actions">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.html,.htm,.rst,.adoc,text/*,application/json"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void addFiles(files);
              }}
            />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              Upload files
            </button>
            <input
              className="input"
              type="url"
              inputMode="url"
              value={siteUrl}
              placeholder="https://"
              aria-label="Website address"
              onChange={(e) => setSiteUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addWebsite();
                }
              }}
            />
            <button type="button" className="btn btn-ghost" disabled={busy || siteUrl.trim() === ""} onClick={addWebsite}>
              Add website
            </button>
          </div>
          {planSources.length > 0 && (
            <ul className="swarm-plan-sources" aria-label="Plan sources">
              {planSources.map((source, index) => (
                <li key={`${index}-${source.kind === "file" ? source.name : source.url}`}>
                  <span className="swarm-plan-source-kind">{source.kind === "file" ? "File" : "Website"}</span>
                  <span className="swarm-plan-source-name" title={source.kind === "file" ? source.name : source.url}>
                    {source.kind === "file" ? source.name : source.url}
                  </span>
                  {source.kind === "file" && <span className="muted">{formatChars(source.content.length)}</span>}
                  <button
                    type="button"
                    className="btn btn-ghost swarm-plan-source-remove"
                    aria-label={`Remove ${source.kind === "file" ? source.name : source.url}`}
                    onClick={() => {
                      setPlanRefusal("");
                      setPlanSources((current) => current.filter((_, at) => at !== index));
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {reading > 0 && <span className="muted" role="status">Reading {reading === 1 ? "a file" : `${reading} files`}.</span>}
          {planRefusal && <span className="swarm-reopen-refusal" role="alert">{planRefusal}</span>}
          <label className="switch-row">
            <input
              type="checkbox"
              role="switch"
              checked={existingPlan}
              aria-checked={existingPlan}
              onChange={(e) => setExistingPlan(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <strong>Use existing plan</strong>
              <span className="muted">{existingPlanHelp(existingPlan, planSources.length)}</span>
            </span>
          </label>
        </fieldset>

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

        <p className="muted">
          {existingPlan
            ? "Creating a swarm starts the planner on your plan. Review the task tree it builds, then start the work."
            : "Creating a swarm starts the planner. Review its plan, then start the work."}
        </p>

        {error && <p className="error error-box" role="alert">{error}</p>}
      </div>
    </Modal>
  );

  /**
   * Reads each chosen file as text and adds it, refusing what cannot
   * be a plan source with a sentence under the list.
   *
   * One file at a time, in the order chosen, so the list reads in the
   * order the person picked and the refusal names the file it is
   * about. A folder upload arrives with each file's relative path,
   * which is kept as its name: two README files from two folders are
   * two sources.
   */
  async function addFiles(files: File[]) {
    setPlanRefusal("");
    setReading((count) => count + files.length);
    let current = planSources;
    try {
      for (const file of files) {
        const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        let content: string;
        try {
          content = await file.text();
        } catch {
          setPlanRefusal(`${name} could not be read.`);
          continue;
        }
        const refusal = planSourceRefusal(current, { kind: "file", name, content });
        if (refusal) {
          setPlanRefusal(refusal);
          continue;
        }
        current = [...current, { kind: "file", name, content }];
        setPlanSources(current);
      }
    } finally {
      setReading((count) => count - files.length);
    }
  }

  /** Adds the typed address, or says why not. */
  function addWebsite() {
    const url = siteUrl.trim();
    if (!url) return;
    const refusal = planSourceRefusal(planSources, { kind: "website", url });
    if (refusal) {
      setPlanRefusal(refusal);
      return;
    }
    setPlanRefusal("");
    setPlanSources((current) => [...current, { kind: "website", url }]);
    setSiteUrl("");
  }

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
      planSources,
      planMode: existingPlan ? "existing" : "goal",
      start: continuing ? { kind: "existing-branch", name: continuing } : { kind: "new-branch", name: branchName },
      deliverable,
      budgetUsd: budgetUsd ?? null,
      timeLimitMin: timeLimitMin ?? null,
      workers,
      planOnly: true,
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }
}

/** What the switch says it does, in its current position. */
export function existingPlanHelp(on: boolean, sources: number): string {
  if (on) {
    return sources > 0
      ? "The planner builds the task tree from this plan. If it has no implementation steps yet, the planner writes them first, then the tree."
      : "The goal above is the plan. The planner builds the task tree from it rather than planning from scratch. Upload files or add a page to hand over more.";
  }
  return sources > 0
    ? "The planner reads what you handed over as background and plans from the goal."
    : "Off: the planner reads the goal and the code and writes the plan itself.";
}

/**
 * Why a source cannot be added to this list, or null when it can.
 *
 * The same rules the route applies, asked before the request so the
 * refusal is a sentence under the list rather than a failed Create:
 * how many sources, how big each, how big all of them, and whether a
 * file is text at all. The server decides; this is here so a person
 * is told at the moment they pick the file.
 */
export function planSourceRefusal(current: NewPlanSource[], candidate: NewPlanSource): string | null {
  if (current.length >= MAX_SWARM_PLAN_SOURCES) {
    return `A swarm takes up to ${MAX_SWARM_PLAN_SOURCES} plan sources. Remove one to add another.`;
  }
  if (candidate.kind === "website") {
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      return `${candidate.url} is not a web address. Enter the whole address, starting with https://.`;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return `${candidate.url} is not a web address. Enter the whole address, starting with https://.`;
    }
    if (current.some((source) => source.kind === "website" && source.url === candidate.url)) {
      return `${candidate.url} is already in the list.`;
    }
    return null;
  }
  const name = candidate.name.trim();
  if (name === "" || name.length > MAX_SWARM_PLAN_SOURCE_NAME_CHARS) {
    return "That file's name is too long to be a plan source.";
  }
  if (candidate.content.trim() === "") {
    return `${name} is empty, so there is nothing in it to plan from.`;
  }
  if (candidate.content.includes("\u0000")) {
    return `${name} is not a text file. A plan source is markdown, plain text, or another text format.`;
  }
  if (candidate.content.length > MAX_SWARM_PLAN_SOURCE_CHARS) {
    return `${name} holds ${formatChars(candidate.content.length)}, and a plan source holds at most ${formatChars(MAX_SWARM_PLAN_SOURCE_CHARS)}.`;
  }
  const total = current.reduce((sum, source) => sum + (source.kind === "file" ? source.content.length : 0), 0);
  if (total + candidate.content.length > MAX_SWARM_PLAN_CHARS) {
    return `Adding ${name} would take the plan past ${formatChars(MAX_SWARM_PLAN_CHARS)} in all. Leave out what is not the plan.`;
  }
  return null;
}

/** A character count as a person reads one. */
export function formatChars(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
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
