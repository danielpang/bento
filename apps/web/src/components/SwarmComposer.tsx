import * as Menu from "@radix-ui/react-dropdown-menu";
import { MAX_SWARM_GOAL_CHARS, MAX_SWARM_WORKERS, MODEL_GUIDANCE } from "@bento/core";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { growComposer, SendMark } from "./ChatComposer.js";
import { capitalise, CheckMark, ChevronMark, CloseMark, FileMark, GearMark, GlobeMark, ImageMark, PlusMark, StepGlyph } from "./SwarmMarks.js";
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
import { REPOSITORY_SETUP_ACTION } from "../repository-setup.js";
import { isApplePlatform, sendModifierName } from "../platform.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { SwarmAgent } from "../swarm/client.js";
import type { NewPlanSource, NewSwarmInput, SwarmSummary } from "../swarm/types.js";
import { swarmTone, swarmWords } from "../swarm/status.js";
import { formatAge } from "../swarm/time.js";
import {
  attachmentName,
  attachmentSize,
  branchNameRefusal,
  clampWorkers,
  existingPlanHelp,
  isBranchName,
  nameFromGoal,
  readPlanFile,
  suggestBranch,
  withPlanSource,
} from "../swarm/new-swarm.js";

/**
 * Starting a swarm, as one composer in the middle of the board.
 *
 * The goal is the only thing a person has to write. The name is
 * suggested from its first words and can be edited in place; the
 * planner, the worker and how many run at once sit on the composer's
 * own toolbar, already set to what most swarms want; everything else
 * waits behind Defaults, with one line under the card saying what it
 * is set to. Attachments go inside the card, because they are part of
 * what the person is saying, and the switch under it says whether they
 * are the plan itself or material to plan from.
 *
 * It asks for what the create route takes and nothing else. A field
 * the server has no home for is a promise the console cannot keep, so
 * the branch is a preview of the one the server will name rather than
 * a choice, and there is no plan only box: a swarm always plans first
 * and waits for Start.
 *
 * Also what a project with no swarms shows, so the first thing a
 * person sees on the Swarms tab is the thing they came to do.
 */
export function SwarmComposer({
  projectId,
  agents,
  surfaces,
  swarms = [],
  busy,
  repositoriesMissing = false,
  onAddRepository,
  onNewAgent,
  onManageAgents,
  onSelectSwarm,
  onCancel,
  onCreate,
  now = Date.now(),
}: {
  projectId: string;
  agents: SwarmAgent[];
  surfaces: ModeSurfaces;
  /** The project's swarms, for the recent list under the composer. */
  swarms?: SwarmSummary[];
  busy?: boolean;
  /** Create stays disabled until the project has a repository. */
  repositoriesMissing?: boolean;
  /** Opens Repositories. */
  onAddRepository?: () => void;
  /** Opens the Agents panel on a new agent. */
  onNewAgent?: () => void;
  /** Opens the Agents panel. */
  onManageAgents?: () => void;
  onSelectSwarm?: (swarmId: string) => void;
  /** Leaves the composer for the swarm that was open. Absent when there is none to go back to. */
  onCancel?: () => void;
  onCreate: (input: NewSwarmInput) => Promise<void>;
  /** The clock the recent list's ages are read against. */
  now?: number;
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
  const plannerDefault = agents.find((agent) => agent.name === "Swarm Planner")?.id ?? "";
  const workerDefault = agents.find((agent) => agent.name === "Swarm Worker")?.id ?? "";
  const plannerProfileId = plannerChoice ?? plannerDefault;
  const workerProfileId = workerChoice ?? workerDefault;

  const [goal, setGoal] = useState("");
  /** A name the person typed. Null while the composer suggests one from the goal. */
  const [customName, setCustomName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const name = customName ?? nameFromGoal(goal);
  const [error, setError] = useState("");
  const defaultWorkers = clampWorkers(surfaces.defaultSwarmWorkers, MAX_SWARM_WORKERS);
  const [budget, setBudget] = useState("");
  const [timeLimit, setTimeLimit] = useState("");
  const [workers, setWorkers] = useState(defaultWorkers);
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
   * Files are read in the browser, so what travels is what the planner
   * reads, and a file that cannot be a plan source is refused here,
   * with a sentence, rather than after the request. Addresses travel
   * as addresses: the server fetches them, through the same guarded
   * fetch every other tenant chosen URL goes through.
   */
  const [planSources, setPlanSources] = useState<NewPlanSource[]>([]);
  const [existingPlan, setExistingPlan] = useState(false);
  const [addingSite, setAddingSite] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [planRefusal, setPlanRefusal] = useState("");
  /** Files still being read. Create waits for them. */
  const [reading, setReading] = useState(0);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const siteInput = useRef<HTMLInputElement>(null);
  /** Set while the attach menu closes onto the website field, so the menu does not take focus back. */
  const siteFieldNext = useRef(false);
  /** A create in flight, so a second press cannot send the same swarm twice. */
  const sending = useRef(false);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const ids = useId();

  useLayoutEffect(() => {
    growComposer(goalInput.current);
  }, [goal]);

  useEffect(() => {
    if (addingSite) siteInput.current?.focus();
  }, [addingSite]);

  // The server names the branch after the swarm, so this is a preview
  // of what it will be rather than a choice.
  const branchName = suggestBranch(name);
  const continuing = startBranch.trim();
  const branchRefusal = continuing && !isBranchName(continuing) ? branchNameRefusal : null;
  const goalLength = goal.trim().length;
  const goalTooLong = goalLength > MAX_SWARM_GOAL_CHARS;
  const budgetUsd = parseBudget(budget);
  const timeLimitMin = parseTimeLimit(timeLimit);
  const defaultsInvalid = branchRefusal !== null || budgetUsd === undefined || timeLimitMin === undefined;
  const ready =
    name.trim() !== "" &&
    goalLength > 0 &&
    !goalTooLong &&
    !defaultsInvalid &&
    reading === 0 &&
    !repositoriesMissing;

  const plannerName = agentName(agents, plannerProfileId, "Swarm Planner");
  const workerName = agentName(agents, workerProfileId, "Swarm Worker");
  const agentsAreDefault = plannerProfileId === plannerDefault && workerProfileId === workerDefault;

  /*
   * Enter is a newline: a goal is a paragraph or two, and a swarm is
   * not something to start by accident at the end of a line. The
   * modifier and Enter, or the send button, creates it. Escape in an
   * empty field goes back to the swarm that was open.
   */
  const onGoalKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && onCancel && goal.trim() === "" && planSources.length === 0) {
      event.preventDefault();
      onCancel();
    }
  };
  const modifier = sendModifierName(isApplePlatform());

  return (
    <div className="swarm-composer-screen">
      <div className="swarm-composer-column">
        <div className="swarm-composer-intro">
          <h1 className="swarm-composer-title">What should the swarm build?</h1>
          <p className="swarm-composer-subtitle">
            Describe the outcome. Attach a plan, a PRD or screenshots and the planner reads them first.
          </p>
        </div>

        <section className="swarm-composer" aria-label="New swarm">
          <label htmlFor={`${ids}-goal`} className="visually-hidden">Goal</label>
          <textarea
            id={`${ids}-goal`}
            ref={goalInput}
            className="swarm-composer-goal"
            rows={4}
            value={goal}
            autoFocus
            placeholder={existingPlan ? "What should the swarm do with the plan?" : "What should be true when this is finished?"}
            aria-invalid={goalTooLong}
            aria-describedby={`${ids}-goal-length`}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={onGoalKey}
          />

          {planSources.length > 0 && (
            <ul className="swarm-composer-chips" aria-label="Attachments">
              {planSources.map((source, index) => {
                const label = attachmentName(source);
                const size = attachmentSize(source);
                return (
                  <li key={`${index}-${label}`} className="swarm-chip" title={source.kind === "file" ? source.name : source.url}>
                    <SourceIcon source={source} />
                    <span className="swarm-chip-name">{label}</span>
                    {size && <span className="swarm-chip-size">{size}</span>}
                    <button
                      type="button"
                      className="swarm-chip-remove"
                      aria-label={`Remove ${label}`}
                      onClick={() => {
                        setPlanRefusal("");
                        setPlanSources((current) => current.filter((_, at) => at !== index));
                      }}
                    >
                      <CloseMark size={10} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {addingSite && (
            <div className="swarm-composer-site">
              <input
                ref={siteInput}
                className="input"
                type="url"
                inputMode="url"
                value={siteUrl}
                placeholder="https://"
                aria-label="Website address"
                onChange={(event) => setSiteUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addWebsite();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setAddingSite(false);
                    setSiteUrl("");
                  }
                }}
              />
              <button type="button" className="btn" disabled={busy || siteUrl.trim() === ""} onClick={addWebsite}>
                Add
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setAddingSite(false); setSiteUrl(""); }}>
                Cancel
              </button>
            </div>
          )}

          <div className="swarm-composer-notes" data-empty={reading > 0 || planRefusal || goalTooLong ? undefined : ""}>
            {reading > 0 && <span className="muted" role="status">Reading {reading === 1 ? "a file" : `${reading} files`}.</span>}
            {planRefusal && <span className="swarm-reopen-refusal" role="alert">{planRefusal}</span>}
            {/* Always in the document, so the field's description points at
                something; it says nothing until the goal is too long. */}
            <span id={`${ids}-goal-length`} className="error" role={goalTooLong ? "alert" : undefined}>
              {goalTooLong
                ? `${goalLength.toLocaleString()} / ${MAX_SWARM_GOAL_CHARS.toLocaleString()} characters. Shorten the goal to create this swarm.`
                : ""}
            </span>
          </div>

          <div className="swarm-composer-toolbar">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.html,.htm,.rst,.adoc,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/json,application/pdf,image/png,image/jpeg,image/gif,image/webp"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void addFiles(files);
              }}
            />
            <Menu.Root>
              <Menu.Trigger className="swarm-tool swarm-tool-icon" aria-label="Attach a plan, files or images" title="Attach" disabled={busy}>
                <PlusMark />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content
                  className="picker-menu swarm-attach-menu"
                  align="start"
                  sideOffset={6}
                  data-portal-layer=""
                  // Radix gives focus back to the trigger a tick after the
                  // menu closes, which would take it off the website field
                  // the item just opened. The field keeps it instead.
                  onCloseAutoFocus={(event) => {
                    if (!siteFieldNext.current) return;
                    siteFieldNext.current = false;
                    event.preventDefault();
                    siteInput.current?.focus();
                  }}
                >
                  <Menu.Item className="picker-item" onSelect={() => fileInput.current?.click()}>
                    <FileMark />
                    <span className="picker-item-name">Upload files</span>
                  </Menu.Item>
                  <Menu.Item
                    className="picker-item"
                    onSelect={() => {
                      siteFieldNext.current = true;
                      setAddingSite(true);
                    }}
                  >
                    <GlobeMark />
                    <span className="picker-item-name">Add website</span>
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>

            <span className="swarm-composer-agent-single">
              <SwarmAgentPicker
                role="Planner"
                value={plannerProfileId}
                defaultId={plannerDefault}
                fallbackName="Swarm Planner"
                agents={agents}
                onChange={setPlannerChoice}
                onNewAgent={onNewAgent}
                onManageAgents={onManageAgents}
              />
            </span>
            <span className="swarm-composer-agent-single">
              <SwarmAgentPicker
                role="Worker"
                value={workerProfileId}
                defaultId={workerDefault}
                fallbackName="Swarm Worker"
                agents={agents}
                onChange={setWorkerChoice}
                onNewAgent={onNewAgent}
                onManageAgents={onManageAgents}
              />
            </span>
            <span className="swarm-composer-agents-combined">
              <SwarmAgentsMenu
                label={agentsAreDefault ? "Agents: default" : `Agents: ${plannerName}, ${workerName}`}
                agents={agents}
                planner={{ value: plannerProfileId, defaultId: plannerDefault, fallbackName: "Swarm Planner", onChange: setPlannerChoice }}
                worker={{ value: workerProfileId, defaultId: workerDefault, fallbackName: "Swarm Worker", onChange: setWorkerChoice }}
                onManageAgents={onManageAgents}
              />
            </span>
            <span className="swarm-composer-workers">
              <Menu.Root>
                <Menu.Trigger className="swarm-tool" aria-label={`Workers at once: ${workers}`}>
                  <span className="swarm-tool-key">Workers</span>
                  <span className="swarm-tool-value swarm-mono">{workers}</span>
                  <ChevronMark />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content className="picker-menu swarm-workers-menu" align="start" sideOffset={6} data-portal-layer="">
                    <Menu.Label className="swarm-switcher-label">Workers at once</Menu.Label>
                    <Menu.RadioGroup value={String(workers)} onValueChange={(value) => setWorkers(clampWorkers(Number(value), MAX_SWARM_WORKERS))}>
                      {Array.from({ length: MAX_SWARM_WORKERS }, (_, at) => at + 1).map((count) => (
                        <Menu.RadioItem key={count} value={String(count)} className="picker-item swarm-workers-item">
                          <span className="picker-item-name swarm-mono">{count}</span>
                          {count === defaultWorkers && <span className="swarm-agent-default">Default</span>}
                          <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </span>

            <span className="swarm-composer-spacer" />

            {onCancel && (
              <button type="button" className="btn btn-ghost swarm-composer-cancel" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button
              ref={gear}
              type="button"
              className="swarm-tool swarm-tool-icon swarm-tool-quiet"
              aria-label="Defaults: budget, time limit, branch, final check"
              title="Defaults"
              aria-expanded={defaultsOpen}
              aria-controls={`${ids}-defaults`}
              data-defaults-trigger=""
              data-invalid={defaultsInvalid ? "" : undefined}
              onClick={() => setDefaultsOpen((open) => !open)}
            >
              <GearMark />
            </button>
            <button
              type="button"
              className="swarm-send"
              aria-label="Create swarm"
              title={`Create swarm (${modifier}+Enter)`}
              disabled={!ready || busy}
              onClick={submit}
            >
              <SendMark />
            </button>
          </div>

          {defaultsOpen && (
            <SwarmDefaultsPopover
              id={`${ids}-defaults`}
              agents={agents}
              workers={workers}
              onWorkers={setWorkers}
              budget={budget}
              onBudget={setBudget}
              timeLimit={timeLimit}
              onTimeLimit={setTimeLimit}
              deliverable={deliverable}
              onDeliverable={setDeliverable}
              startBranch={startBranch}
              onStartBranch={setStartBranch}
              branchPlaceholder={branchName ? `${branchName} (new)` : "A new branch"}
              branchRefusal={branchRefusal}
              draft={runSettings}
              onDraft={setRunSettings}
              onReset={() => {
                setWorkers(defaultWorkers);
                setBudget("");
                setTimeLimit("");
                setDeliverable("code");
                setStartBranch("");
                setRunSettings(DEFAULT_RUN_SETTINGS);
              }}
              onClose={(returnFocus) => {
                setDefaultsOpen(false);
                if (returnFocus) gear.current?.focus();
              }}
            />
          )}
        </section>

        {/*
          * Why Create is disabled, said beside it. The board's own
          * banner says the same at the top of every board, so this is
          * one line with the way to fix it rather than a second banner.
          */}
        {repositoriesMissing && (
          <div className="swarm-composer-blocked" role="status">
            <span>A swarm needs a repository to work in. Add one to this project to create a swarm.</span>
            {onAddRepository && (
              <button className="swarm-link" type="button" onClick={onAddRepository}>
                {REPOSITORY_SETUP_ACTION}
              </button>
            )}
          </div>
        )}

        <div className="swarm-composer-under">
          <label className="switch-row swarm-composer-switch" title={existingPlanHelp(existingPlan, planSources.length)}>
            <input
              type="checkbox"
              role="switch"
              checked={existingPlan}
              aria-checked={existingPlan}
              aria-describedby={`${ids}-plan-help`}
              onChange={(event) => setExistingPlan(event.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <span className="swarm-composer-switch-label">Attachments are the plan</span>
              <span id={`${ids}-plan-help`} className="visually-hidden">{existingPlanHelp(existingPlan, planSources.length)}</span>
            </span>
          </label>
          <span className="swarm-composer-divider" aria-hidden="true">|</span>
          <span className="swarm-composer-name">
            {editingName ? (
              <input
                className="input swarm-composer-name-input"
                aria-label="Swarm name"
                autoFocus
                maxLength={200}
                defaultValue={name}
                placeholder="Checkout rewrite"
                onBlur={(event) => commitName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitName(event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingName(false);
                  }
                }}
              />
            ) : (
              <>
                <span className="swarm-composer-key">Name</span>
                <span className="swarm-composer-name-value" title={name || undefined}>
                  {name || <span className="swarm-composer-key">from the goal</span>}
                </span>
                <button type="button" className="swarm-link" onClick={() => setEditingName(true)}>
                  edit
                </button>
              </>
            )}
          </span>
          <span className="swarm-composer-spacer" />
          {(continuing || branchName) && (
            <span className="swarm-composer-branch swarm-mono" title={continuing ? "The branch this swarm continues" : "The branch the server will create"}>
              {continuing || branchName}
            </span>
          )}
          <button
            type="button"
            className="swarm-link swarm-composer-defaults-link"
            data-defaults-trigger=""
            aria-expanded={defaultsOpen}
            aria-controls={`${ids}-defaults`}
            onClick={() => setDefaultsOpen((open) => !open)}
          >
            Defaults
          </button>
        </div>

        {/* The second line: how to send, and what Defaults is set to, in
            the settings dialog's own sentence so a judge or a command set
            there is read here once the popover closes. */}
        <div className="swarm-composer-foot">
          <span className="swarm-composer-hint">{modifier}+Enter creates the swarm. Enter starts a new line.</span>
          <span className="swarm-composer-summary" title={runSettingsSummary(runSettings, agents, deliverable)}>
            {summaryWords({ continuing: continuing !== "", budgetUsd, timeLimitMin, settings: runSettingsSummary(runSettings, agents, deliverable) })}
          </span>
        </div>

        {error && <p className="error error-box" role="alert">{error}</p>}

        {swarms.length > 0 && <RecentSwarms swarms={swarms} now={now} onSelect={onSelectSwarm} />}
      </div>
    </div>
  );

  function commitName(value: string) {
    const typed = value.trim();
    // Cleared is "suggest one again", rather than a swarm with no name.
    setCustomName(typed === "" || typed === nameFromGoal(goal) ? null : typed);
    setEditingName(false);
  }

  /**
   * Reads each chosen file and adds it, refusing what cannot be a
   * plan source with a sentence under the chips.
   *
   * One file at a time, in the order chosen, so the chips read in the
   * order the person picked and the refusal names the file it is
   * about. Each file is added against the list as it is at that
   * moment, not as it was when the picker closed: reading a large PDF
   * takes long enough for a person to add a website or remove a chip
   * meanwhile, and a write made from a stale copy would undo that.
   */
  async function addFiles(files: File[]) {
    setPlanRefusal("");
    setReading((count) => count + files.length);
    try {
      for (const file of files) {
        const fileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        let candidate: NewPlanSource;
        try {
          candidate = await readPlanFile(file, fileName);
        } catch {
          setPlanRefusal(`${fileName} could not be read.`);
          continue;
        }
        setPlanSources((current) => {
          const added = withPlanSource(current, candidate);
          if (added.refusal) setPlanRefusal(added.refusal);
          return added.sources;
        });
      }
    } finally {
      setReading((count) => count - files.length);
    }
  }

  /** Adds the typed address, or says why not. */
  function addWebsite() {
    const url = siteUrl.trim();
    if (!url) return;
    setPlanRefusal("");
    setPlanSources((current) => {
      const added = withPlanSource(current, { kind: "website", url });
      if (added.refusal) {
        setPlanRefusal(added.refusal);
      } else {
        setSiteUrl("");
        setAddingSite(false);
      }
      return added.sources;
    });
  }

  /**
   * What the create route takes, unchanged from the dialog this
   * replaced. A swarm always plans first and waits for Start, so plan
   * only is how every swarm begins rather than a box to tick.
   */
  function submit() {
    if (!ready || busy || sending.current) {
      if (defaultsInvalid) setDefaultsOpen(true);
      return;
    }
    setError("");
    sending.current = true;
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
    })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        sending.current = false;
      });
  }
}

/**
 * The line under the composer, after the branch: what kind of branch,
 * its ceilings, and then what the run settings say (what it produces,
 * the final check, planning, instructions), in the sentence the
 * settings dialog uses, so a judge or a command set in Defaults is
 * read here once the popover closes.
 */
export function summaryWords(input: {
  continuing: boolean;
  budgetUsd: number | null | undefined;
  timeLimitMin: number | null | undefined;
  /** `runSettingsSummary`'s sentence. */
  settings: string;
}): string {
  const parts = [
    input.continuing ? "existing branch" : "new branch",
    typeof input.budgetUsd === "number" ? `$${input.budgetUsd.toLocaleString()} cap` : "no cap",
  ];
  if (typeof input.timeLimitMin === "number") parts.push(`${input.timeLimitMin.toLocaleString()} min limit`);
  const settings = input.settings.replace(/\.$/, "");
  if (settings) parts.push(settings.charAt(0).toLowerCase() + settings.slice(1));
  return parts.join(" · ");
}

/** A tool as people call it: "Claude Code" rather than its id. */
export function toolName(cli: string): string {
  return MODEL_GUIDANCE.find((tool) => tool.cli === cli)?.label ?? cli;
}

function agentName(agents: SwarmAgent[], id: string, fallback: string): string {
  if (!id) return fallback;
  return agents.find((agent) => agent.id === id)?.name ?? "Unavailable agent";
}

/**
 * The planner's or the worker's agent, picked from a menu.
 *
 * A search field over the agents, one radio item each with its tool
 * and model, the install's default marked, and the way to the Agents
 * panel at the bottom. When the install has no Swarm Planner yet the
 * first item is the empty choice, which the server answers by making
 * one, so the default is always somewhere in the list.
 */
export function SwarmAgentPicker({
  role,
  value,
  defaultId,
  fallbackName,
  agents,
  onChange,
  onNewAgent,
  onManageAgents,
}: {
  role: "Planner" | "Worker";
  value: string;
  defaultId: string;
  fallbackName: string;
  agents: SwarmAgent[];
  onChange: (id: string) => void;
  onNewAgent?: () => void;
  onManageAgents?: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = agents.filter((agent) =>
    needle === "" || `${agent.name} ${agent.cli} ${agent.model}`.toLowerCase().includes(needle),
  );
  const showFallback = defaultId === "" && (needle === "" || fallbackName.toLowerCase().includes(needle));
  const missing = value !== "" && !agents.some((agent) => agent.id === value);
  const current = value === "" ? fallbackName : agents.find((agent) => agent.id === value)?.name ?? "Unavailable agent";

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) requestAnimationFrame(() => search.current?.focus());
        else setQuery("");
      }}
    >
      <Menu.Trigger className="swarm-tool" aria-label={`${role} agent: ${current}`}>
        <span className="swarm-tool-key">{role}</span>
        <span className="swarm-tool-value">{current}</span>
        <ChevronMark />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={content}
          className="picker-menu swarm-agent-menu"
          align="start"
          sideOffset={6}
          aria-label={`${role} agent`}
          data-portal-layer=""
        >
          <div className="swarm-agent-search">
            <input
              ref={search}
              className="swarm-agent-search-input"
              value={query}
              placeholder="Search agents"
              aria-label="Search agents"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // The menu's own typeahead would take every letter.
                if (event.key === "Escape") return;
                event.stopPropagation();
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  content.current?.querySelector<HTMLElement>("[role='menuitemradio']")?.focus();
                }
              }}
            />
          </div>
          <Menu.Label className="swarm-agent-label">Agents</Menu.Label>
          <Menu.RadioGroup className="picker-group" value={value} onValueChange={onChange}>
            {showFallback && (
              <Menu.RadioItem value="" className="picker-item swarm-agent-item">
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">{fallbackName}</span>
                  <span className="swarm-agent-meta">Created for you</span>
                </span>
                <span className="swarm-agent-default">Default</span>
                <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
              </Menu.RadioItem>
            )}
            {missing && (
              <Menu.RadioItem value={value} className="picker-item swarm-agent-item" disabled>
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">Selected agent is unavailable</span>
                </span>
                <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
              </Menu.RadioItem>
            )}
            {matches.map((agent) => (
              <Menu.RadioItem key={agent.id} value={agent.id} className="picker-item swarm-agent-item">
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">{agent.name}</span>
                  <span className="swarm-agent-meta">{toolName(agent.cli)} · {agent.model}</span>
                </span>
                {agent.id === defaultId && <span className="swarm-agent-default">Default</span>}
                <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
            {!showFallback && matches.length === 0 && <p className="swarm-agent-none">No agent matches.</p>}
          </Menu.RadioGroup>
          {(onNewAgent || onManageAgents) && (
            <div className="swarm-agent-foot">
              {onNewAgent && (
                <Menu.Item className="picker-item swarm-agent-foot-item" onSelect={onNewAgent}>
                  <PlusMark size={13} />
                  New agent
                </Menu.Item>
              )}
              {onManageAgents && (
                <Menu.Item className="picker-item swarm-agent-foot-item" onSelect={onManageAgents}>
                  Manage
                </Menu.Item>
              )}
            </div>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface AgentChoice {
  value: string;
  defaultId: string;
  fallbackName: string;
  onChange: (id: string) => void;
}

/**
 * Both agents in one menu, for a phone's toolbar, where two pickers
 * and a workers count do not fit beside the attach and send buttons.
 */
function SwarmAgentsMenu({
  label,
  agents,
  planner,
  worker,
  onManageAgents,
}: {
  label: string;
  agents: SwarmAgent[];
  planner: AgentChoice;
  worker: AgentChoice;
  onManageAgents?: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="swarm-tool swarm-tool-wide">
        <span className="swarm-tool-value">{label}</span>
        <ChevronMark />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="picker-menu swarm-agent-menu" align="start" sideOffset={6} data-portal-layer="">
          {([["Planner", planner], ["Worker", worker]] as const).map(([role, choice], index) => (
            <Menu.Group key={role}>
              {index > 0 && <Menu.Separator className="picker-sep" />}
              <Menu.Label className="swarm-agent-label">{role}</Menu.Label>
              <Menu.RadioGroup value={choice.value} onValueChange={choice.onChange}>
                {choice.defaultId === "" && (
                  <Menu.RadioItem value="" className="picker-item swarm-agent-item">
                    <span className="swarm-agent-copy">
                      <span className="swarm-agent-name">{choice.fallbackName}</span>
                      <span className="swarm-agent-meta">Created for you</span>
                    </span>
                    <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
                  </Menu.RadioItem>
                )}
                {agents.map((agent) => (
                  <Menu.RadioItem key={agent.id} value={agent.id} className="picker-item swarm-agent-item">
                    <span className="swarm-agent-copy">
                      <span className="swarm-agent-name">{agent.name}</span>
                      <span className="swarm-agent-meta">{toolName(agent.cli)} · {agent.model}</span>
                    </span>
                    <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          ))}
          {onManageAgents && (
            <div className="swarm-agent-foot">
              <Menu.Item className="picker-item swarm-agent-foot-item" onSelect={onManageAgents}>Manage agents</Menu.Item>
            </div>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Everything about how the swarm runs that a person rarely changes,
 * in a popover under the composer: the ceilings, what it produces,
 * where it starts, the final check, planning, and instructions.
 *
 * The ceilings and the branch are this popover's own fields, checked
 * by the settings dialog's rules (`parseBudget`, `parseTimeLimit`,
 * `isBranchName`); what it produces, the final check, planning and
 * the instructions are `SwarmRunSettingsFields`, the dialog's own
 * fields, so a value refused or described here is the one the swarm's
 * settings would refuse or describe too. Each field is used for
 * this swarm only; what can change after it exists is changed in the
 * swarm's own settings.
 */
function SwarmDefaultsPopover({
  id,
  agents,
  workers,
  onWorkers,
  budget,
  onBudget,
  timeLimit,
  onTimeLimit,
  deliverable,
  onDeliverable,
  startBranch,
  onStartBranch,
  branchPlaceholder,
  branchRefusal,
  draft,
  onDraft,
  onReset,
  onClose,
}: {
  id: string;
  agents: SwarmAgent[];
  workers: number;
  onWorkers: (workers: number) => void;
  budget: string;
  onBudget: (value: string) => void;
  timeLimit: string;
  onTimeLimit: (value: string) => void;
  deliverable: "code" | "document";
  onDeliverable: (value: "code" | "document") => void;
  startBranch: string;
  onStartBranch: (value: string) => void;
  branchPlaceholder: string;
  branchRefusal: string | null;
  draft: RunSettingsDraft;
  onDraft: (draft: RunSettingsDraft) => void;
  onReset: () => void;
  onClose: (returnFocus: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const budgetUsd = parseBudget(budget);
  const timeLimitMin = parseTimeLimit(timeLimit);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("[data-portal-layer]")) return;
      event.preventDefault();
      close.current(true);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panel.current?.contains(target) || target.closest("[data-defaults-trigger], [data-portal-layer]")) return;
      close.current(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  return (
    <div ref={panel} id={id} className="swarm-defaults" role="dialog" aria-label="Swarm defaults">
      <div className="swarm-defaults-head">
        <span className="swarm-defaults-title">Defaults</span>
        <span className="swarm-defaults-note">For this swarm. Ceilings and agents can change later in its settings.</span>
      </div>

      <div className="swarm-defaults-row swarm-defaults-row-3">
        <div className="swarm-defaults-field">
          <span className="swarm-defaults-label">Workers at once</span>
          <div className="swarm-defaults-stepper">
            <button type="button" aria-label="Fewer workers" disabled={workers <= 1} onClick={() => onWorkers(clampWorkers(workers - 1, MAX_SWARM_WORKERS))}>
              <StepGlyph />
            </button>
            <span className="swarm-mono" aria-live="polite">{workers}</span>
            <button type="button" aria-label="More workers" disabled={workers >= MAX_SWARM_WORKERS} onClick={() => onWorkers(clampWorkers(workers + 1, MAX_SWARM_WORKERS))}>
              <StepGlyph plus />
            </button>
          </div>
        </div>
        <label className="swarm-defaults-field">
          <span className="swarm-defaults-label">Budget (USD)</span>
          <input
            className="input"
            inputMode="decimal"
            value={budget}
            placeholder="No cap"
            aria-invalid={budgetUsd === undefined}
            onChange={(event) => onBudget(event.target.value)}
          />
          {budgetUsd === undefined && <span className="error">{budgetHelp(budgetUsd)}</span>}
        </label>
        <label className="swarm-defaults-field">
          <span className="swarm-defaults-label">Time limit (minutes)</span>
          <input
            className="input"
            inputMode="numeric"
            value={timeLimit}
            placeholder="No limit"
            aria-invalid={timeLimitMin === undefined}
            onChange={(event) => onTimeLimit(event.target.value)}
          />
          {timeLimitMin === undefined && <span className="error">{timeLimitHelp(timeLimitMin)}</span>}
        </label>
      </div>

      <label className="swarm-defaults-field">
        <span className="swarm-defaults-label">Start from a branch</span>
        <input
          className="input swarm-mono"
          value={startBranch}
          placeholder={branchPlaceholder}
          spellCheck={false}
          aria-invalid={branchRefusal !== null}
          onChange={(event) => onStartBranch(event.target.value)}
        />
        {branchRefusal && <span className="swarm-reopen-refusal">{branchRefusal}</span>}
      </label>

      {/* The rest is the settings dialog's own fields, so the two
          cannot describe one setting differently. */}
      <SwarmRunSettingsFields
        draft={draft}
        onChange={onDraft}
        agents={agents}
        deliverable={deliverable}
        onDeliverable={onDeliverable}
      />

      <div className="swarm-defaults-foot">
        <span className="swarm-composer-spacer" />
        <button type="button" className="btn" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onClose(true)}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * The project's swarms under the composer, newest first.
 *
 * A row is a way back to a swarm, so it says what the switcher would:
 * its status, how far along it is, and how old it is. Five at first,
 * and the rest one click away.
 */
export function RecentSwarms({
  swarms,
  now,
  onSelect,
}: {
  swarms: SwarmSummary[];
  now: number;
  onSelect?: (swarmId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const ordered = [...swarms].sort((a, b) => {
    const left = new Date(a.createdAt).getTime();
    const right = new Date(b.createdAt).getTime();
    return right !== left ? right - left : b.id.localeCompare(a.id);
  });
  const shown = all ? ordered : ordered.slice(0, 5);
  return (
    <section className="swarm-recent" aria-label="Recent swarms">
      <div className="swarm-recent-head">
        <span className="swarm-recent-title">Recent swarms</span>
        {ordered.length > 5 && (
          <button type="button" className="swarm-link swarm-link-quiet" onClick={() => setAll((on) => !on)}>
            {all ? "Show fewer" : `View all ${ordered.length}`}
          </button>
        )}
      </div>
      <ul className="swarm-recent-list">
        {shown.map((swarm) => (
          <li key={swarm.id}>
            <button type="button" className="swarm-recent-row" onClick={() => onSelect?.(swarm.id)}>
              <span className="dot" data-state={swarmTone(swarm.status)} aria-hidden="true" />
              <span className="swarm-recent-name">{swarm.name}</span>
              <span className="swarm-recent-sub">
                <span className="swarm-recent-status">{capitalise(swarmWords(swarm.status))}</span>
                <span className="swarm-recent-meta">{swarm.archivedAt ? "Archived" : `${Math.round(swarm.completion * 100)}% done`}</span>
                <span className="swarm-recent-age">{formatAge(swarm.createdAt, now)}</span>
              </span>
              <ChevronMark right />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceIcon({ source }: { source: NewPlanSource }) {
  if (source.kind === "website") return <GlobeMark />;
  if ("data" in source && source.mime.startsWith("image/")) return <ImageMark />;
  return <FileMark />;
}

