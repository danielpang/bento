import { isSandboxCapacityError } from "@bento/core";
import { CapacityNotice } from "./CapacityNotice.js";
import { Fragment, useEffect, useRef, useState } from "react";
import { capitalise, ChevronMark, DiagramMark, FileMark, GlobeMark, ImageMark } from "./SwarmMarks.js";
import { MergeQueue } from "./MergeQueue.js";
import { OutOfCompute } from "./OutOfCompute.js";
import { SwarmOutline } from "./SwarmOutline.js";
import { SwarmTree, type SwarmTreeSearch } from "./SwarmTree.js";
import { canPause, canReopen, canResume, canStop, ceilingAction, pausedWords, swarmTone, swarmWords } from "../swarm/status.js";
import { idleWords } from "../swarm/waiting.js";
import { cappedUsd, formatUsd, showSwarmSpend } from "../swarm/money.js";
import type { SwarmModel } from "../swarm/layout.js";
import { elapsedSince, formatAge, formatDuration, formatElapsed, shortDate } from "../swarm/time.js";
import { artifactSourceLabel, artifactTypeLabel, splitArtifactPath } from "../swarm/artifacts.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { SwarmArtifact, SwarmDetail, SwarmPlanSource } from "../swarm/types.js";
import type { LandingPage, SwarmAgent, SwarmPublishOutcome } from "../swarm/client.js";
import { formatBytes } from "@bento/core";
import { externalHttpUrl } from "../external-url.js";
import { copyText } from "../clipboard.js";
import { browserStorage, readRailOpen, rememberRailOpen, type StorageLike, type SwarmView } from "../swarm/view-state.js";

/**
 * The page's clock: every second while something is running, and
 * every thirty seconds otherwise.
 *
 * Never frozen, because the page is not keyed by swarm and the ages
 * on it ("Finished 2h ago", the duration, when each artifact was
 * written) are read against this. Set once at mount, a finished swarm
 * left open said "just now" for as long as the tab lived, and one
 * switched to from a live swarm kept the live swarm's clock.
 */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), live ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/**
 * The out of compute banner, or nothing.
 *
 * Local mode has one user, no organization and no plan, so there is
 * no wall for it to hit and no owner to ask: the banner would be
 * describing something that is not there. Its own component so the
 * absence is a thing a test can hold, rather than a condition buried
 * in a header.
 *
 * Shown when this swarm is actually stopped on the plan, rather than
 * on every swarm page a hosted team opens. The same banner the board
 * already uses, in the place a person is looking when their swarm
 * stops moving: it is the one message that says who can fix it, which
 * on a team is usually not the person watching.
 */
export function ComputeBanner({
  surfaces,
  pausedReason,
}: {
  surfaces: ModeSurfaces;
  pausedReason?: SwarmDetail["swarm"]["pausedReason"];
}) {
  if (!surfaces.outOfComputeBanner) return null;
  if (pausedReason !== undefined && pausedReason !== "plan_limit") return null;
  return <OutOfCompute />;
}

export interface SwarmActions {
  onPause: () => void;
  onResume: () => void;
  onRetryPlanner?: () => void;
  onStop: () => void;
  onReleaseBranch?: () => void;
  /** Retries one task's failed merge queue entry, from the queue's own row. */
  onRetryLanding?: (taskId: string) => void;
  /**
   * Opens the swarm's pull requests, in the shape a person chooses: one
   * for the swarm, or one per task, stacked. Offered once anything has
   * landed, not only once the swarm is done, so the work can be on
   * GitHub before its sandbox is gone.
   */
  onPublish?: (mode: "combined" | "stacked") => void;
  /** A page of the merge queue's older rows, or the rows a search matches. */
  onLoadLandings?: (input: { query?: string; offset: number }) => Promise<LandingPage>;
  /**
   * Opens the reopen dialog for a swarm that has finished.
   *
   * Not a resume. Resuming asks a swarm to carry on with the plan it
   * has; this adds something to a plan that finished, on the same
   * branch, so the pull requests it already opened are updated rather
   * than joined by a second set.
   */
  onReopen: () => void;
  /** Opens the confirmation for permanently deleting this swarm. */
  onDelete: () => void;
  /** Puts a finished swarm in the archived menu and releases its machine. */
  onArchive: () => void;
  /** Returns an archived swarm to the strip without changing its work. */
  onRestore: () => void;
  onWorkers: (workers: number) => void;
  /** Opens the swarm's settings: its agents, ceilings, final check and instructions. */
  onSettings: () => void;
  onAnswer: (questionId: string, text: string) => void;
}

/**
 * What the plan was built from, under the goal.
 *
 * Nothing at all for the ordinary swarm, whose planner read the goal
 * and the code. A swarm handed files or pages lists them as small
 * pills: a person reading the tree wants to know which file it came
 * from, and each is one click from opening (a page at its address,
 * a file from the content route). Whether they were the plan or
 * material to plan from is said once, on the goal card's header.
 */
export function SwarmPlanBrief({
  sources,
}: {
  planMode?: SwarmDetail["swarm"]["planMode"];
  sources: NonNullable<SwarmDetail["planSources"]>;
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="swarm-sources" aria-label="Plan sources">
      {sources.map((source) => {
        const size = planSourceSize(source);
        return (
          <li key={source.id} data-media={source.media}>
            <a
              className="swarm-source"
              href={source.kind === "website" ? source.url ?? source.contentPath : source.contentPath}
              target="_blank"
              rel="noreferrer noopener"
              title={[source.url ?? source.name, size].filter(Boolean).join(", ")}
            >
              {source.kind === "website" ? <GlobeMark size={11} /> : source.media === "image" ? <ImageMark size={11} /> : <FileMark size={11} />}
              <span className="visually-hidden">{planSourceLabel(source)}: </span>
              <span className="swarm-source-name">{source.name}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The goal as one line, for the folded brief.
 *
 * The first line that says anything, cut at a word so the fold reads
 * as a sentence trailing off rather than a word chopped in half. The
 * whole goal is a hover away and one click away.
 */
export function goalExcerpt(goal: string, max = 120): string {
  const line = goal.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd()}\u2026`;
}

/** What a source is, as the list labels it. */
export function planSourceLabel(source: Pick<SwarmPlanSource, "kind" | "media">): string {
  if (source.media === "pdf") return "PDF";
  if (source.media === "image") return "Image";
  return source.kind === "file" ? "File" : "Website";
}

/**
 * How big a source is, in the unit a person reads it by.
 *
 * A text file has no size worth printing: a character count does not
 * say whether the plan is the right one. A PDF or an image is a
 * download, so its size is in bytes.
 */
export function planSourceSize(source: Pick<SwarmPlanSource, "media" | "size" | "hasText" | "byteSize">): string | null {
  if (source.media === "text") return null;
  const bytes = formatBytes(source.byteSize ?? 0);
  if (source.media === "image") return bytes;
  return source.hasText ? bytes : `${bytes}, no text (a scan)`;
}

/**
 * One swarm's page: the title row, the figures, the goal, what it made
 * and its pull request, and the plan under them.
 *
 * The title row names the swarm, its state and its next action. The
 * figures are one strip, so spend, workers and time are read in one
 * glance rather than hunted for. The goal card folds; the figures and
 * the sentence about what the swarm waits on never do.
 *
 * Tree and Outline are two renderings of one model. The toggle
 * changes the shape of the page and nothing else: same selection,
 * same numbers, same yellow.
 */
export function SwarmPage({
  detail,
  model,
  view,
  onView,
  selectedId,
  onSelect,
  onToggleNode,
  search,
  actions,
  surfaces,
  busy,
  artifacts = [],
  railStorage,
  onOpenArtifact,
  onOpenPlannerOutput,
  publish = null,
  agents = [],
}: {
  detail: SwarmDetail;
  /** The agents the swarm can name, so the figures say who plans and who works. */
  agents?: SwarmAgent[];
  /** The publish this person started here: the mode still running, or what it opened. */
  publish?: { inFlight: "combined" | "stacked" | null; outcome: SwarmPublishOutcome | null } | null;
  model: SwarmModel;
  view: SwarmView;
  onView: (view: SwarmView) => void;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  onToggleNode: (taskId: string) => void;
  search?: SwarmTreeSearch;
  actions: SwarmActions;
  surfaces: ModeSurfaces;
  busy?: boolean;
  /** What the swarm produced for people to read, newest first. */
  artifacts?: SwarmArtifact[];
  /** Opens one in the viewer every other artifact in Bento opens in. */
  onOpenArtifact?: (artifact: SwarmArtifact) => void;
  onOpenPlannerOutput?: () => void;
  /** Where the rail's fold is remembered. The browser's own unless a test says otherwise. */
  railStorage?: StorageLike | null;
}) {
  /*
   * The details rail hides so the diagram gets the whole width. The
   * choice is this browser's, remembered across swarms, and never in
   * the address: whoever follows a link sees the goal.
   */
  const storage = railStorage === undefined ? browserStorage() : railStorage;
  const [railOpen, setRailOpen] = useState(() => readRailOpen(storage));
  const setRail = (open: boolean) => {
    setRailOpen(open);
    rememberRailOpen(storage, open);
  };
  /** A card to scroll to once the rail is open again, from the collapsed strip. */
  const reveal = useRef<RailCard | null>(null);
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!railOpen || !reveal.current) return;
    const card = railRef.current?.querySelector<HTMLElement>(`[data-rail-card="${reveal.current}"]`);
    reveal.current = null;
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [railOpen]);
  const showCard = (card: RailCard) => {
    reveal.current = card;
    setRail(true);
  };
  const swarm = detail.swarm;
  const live = canPause(swarm.status);
  const now = useNow(live);
  const stopped = pausedWords(swarm.status, swarm.pausedReason, swarm.pausedUntil);
  const planReady = detail.tasks.some((task) => task.nodeType === "leaf" && task.status !== "cancelled");
  const openLeaves = detail.tasks.filter((task) => task.nodeType === "leaf" && task.status === "open" && task.attention === "none");
  const plannerActive = detail.plannerRun != null && ["queued", "starting", "running"].includes(detail.plannerRun.status);
  // A planner can finish a later turn after the swarm has entered
  // running. Older swarms may even say done while a dependent leaf
  // remains open. Both need the saved work approved here.
  const planNeedsApproval = !plannerActive && (
    (swarm.status === "planning" && planReady) ||
    (openLeaves.length > 0 && (swarm.status === "running" || swarm.status === "waiting" || swarm.status === "done"))
  );
  const waitingForPlan = swarm.status === "planning" && !planReady;
  const plannerAtCapacity = waitingForPlan && detail.plannerRun?.status === "failed" && isSandboxCapacityError(detail.plannerRun.error);
  /** The one sentence about what this swarm waits on a person for, shown whether or not the brief is open. */
  const nextStep = plannerAtCapacity
    ? "Your swarm is saved. Retry the planner in a few minutes to start building the plan."
    : waitingForPlan
      ? detail.plannerRun?.status === "failed"
        ? "Planner failed. Open its output below, then retry."
        : detail.plannerRun?.status === "queued"
          ? "Your planner is queued. The plan will appear here after it starts."
          : detail.plannerRun?.status === "starting"
            ? "Preparing a workspace for the planner. Your plan will appear here once it starts."
            : plannerActive
              ? "Planner is building the task tree. Review the plan here before starting work."
              : "The plan is not ready. Message the planner to finish it."
      : "Review the diagram, then approve the plan to start ready workers.";
  const plannerFailed = waitingForPlan && detail.plannerRun?.status === "failed";
  const ceiling = ceilingAction(swarm.status);
  const primaryAction = planNeedsApproval
    ? { label: "Approve plan", onClick: actions.onResume }
    : canResume(swarm.status)
      ? { label: "Resume work", onClick: actions.onResume }
      // A ceiling is lifted by raising it, which Settings does and the
      // coordinator acts on. Starting is refused for both.
      : ceiling
        ? { label: ceiling, onClick: actions.onSettings }
        : canReopen(swarm.status)
          ? { label: "Add follow up", onClick: actions.onReopen }
          : swarm.status === "running" || swarm.status === "waiting"
            ? { label: "Pause work", onClick: actions.onPause }
            : null;
  /*
   * Why a swarm that says it is at work is not moving. "waiting" is the
   * server's blocked: something in the tree wants a person. A running
   * swarm with nothing running and nothing landing says what it is
   * waiting on, when the tree shows it; without this the header showed
   * only Pause and Stop over a swarm that was doing nothing.
   */
  const stillWords = swarm.status === "waiting"
    ? "This swarm is waiting for you. Open the highlighted tasks in the diagram to see what each one needs."
    : idleWords(detail);

  const tone = plannerFailed || swarm.status === "failed" ? "gated" : swarmTone(swarm.status);
  const statusLabel = plannerAtCapacity ? "Waiting for capacity" : plannerFailed || swarm.status === "failed" ? "stalled" : swarmWords(swarm.status);
  const showNextStep = waitingForPlan || planNeedsApproval;

  return (
    <div className="swarm-page">
      <ComputeBanner surfaces={surfaces} pausedReason={swarm.pausedReason} />

      <div className="swarm-top">
        <header className="swarm-title-row">
          <div className="swarm-title-copy">
            <div className="swarm-title-line">
              <h1 className="swarm-name" title={swarm.name}>{swarm.name}</h1>
              <span className="status swarm-badge" data-tone={tone}>
                <span className="dot" data-state={tone} />
                {capitalise(statusLabel)}
              </span>
            </div>
            <div className="swarm-title-meta">
              <span className="swarm-title-when">{whenWords(swarm, now)}</span>
              {swarm.branchName && <BranchName name={swarm.branchName} />}
              {/* That this is not the first pass, said on the title row.
                  The tree says which subtree each follow up is; this
                  says there were any. */}
              {swarm.reopenCount > 0 && (
                <span title="This swarm was reopened, so part of its tree is follow up work on the same branch.">
                  {swarm.reopenCount === 1 ? "Reopened once" : `Reopened ${swarm.reopenCount} times`}
                </span>
              )}
            </div>
          </div>

          <div className="swarm-title-actions" data-primary={primaryAction ? "" : undefined}>
            {waitingForPlan && plannerActive && <span className="swarm-awaiting-plan">{detail.plannerRun?.status === "queued" ? "Waiting to start" : detail.plannerRun?.status === "starting" ? "Starting planner" : "Planner at work"}</span>}
            <button className="btn swarm-settings-action" disabled={busy} onClick={actions.onSettings}>Settings</button>
            <details className="swarm-more-actions">
              <summary className="btn" aria-label="More swarm actions">
                <span>Actions</span>
                <svg className="swarm-actions-chevron" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="swarm-more-menu">
                {swarm.status === "planning" && plannerActive && canPause(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onPause}>Pause planner</button>}
                {(swarm.status === "running" || swarm.status === "waiting") && primaryAction?.label !== "Pause work" && (
                  <button className="btn" disabled={busy} onClick={actions.onPause}>Pause work</button>
                )}
                {canReopen(swarm.status) && primaryAction?.label !== "Add follow up" && (
                  <button className="btn" disabled={busy} onClick={actions.onReopen}>Add follow up</button>
                )}
                {canStop(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onStop}>Stop swarm</button>}
                {swarm.archivedAt ? (
                  <button className="btn" disabled={busy} onClick={actions.onRestore}>Restore</button>
                ) : (
                  canReopen(swarm.status) && (
                    <button className="btn" disabled={busy} onClick={actions.onArchive}>Archive</button>
                  )
                )}
                <button className="btn btn-danger-quiet" disabled={busy} onClick={actions.onDelete}>
                  Delete swarm
                </button>
              </div>
            </details>
            {primaryAction && <button className="btn btn-primary swarm-main-action" disabled={busy} onClick={primaryAction.onClick}>{primaryAction.label}</button>}
          </div>
        </header>

        {/*
         * Why this swarm is not starting anything, in a sentence.
         *
         * Four different things leave a swarm sitting still, and the
         * status word is the same for two of them. What a person needs
         * is which one and what it takes to move it, so the page says
         * it under the title rather than leaving them to guess from a
         * greyed out button.
         */}
        {stopped && (
          <p className="swarm-paused" role="status">
            {stopped}
          </p>
        )}
        {!stopped && stillWords && (
          <p className="swarm-paused" role="status" data-kind="idle">
            {stillWords}
          </p>
        )}
        {/*
         * What the fold must never hide: the one sentence that says
         * what this swarm is waiting on a person for. It sits under the
         * title, outside the goal card, because the fold is remembered
         * for every swarm and the next swarm's trouble is not this one's.
         */}
        {showNextStep && <p className="swarm-next-step" role="status">{nextStep}</p>}

        {swarm.question && (
          <PlannerQuestionBanner
            question={swarm.question}
            busy={busy}
            onAnswer={(text) => actions.onAnswer(swarm.question?.id ?? "", text)}
          />
        )}

        {swarm.status === "failed" && swarm.updatedAt && (
          detail.pullRequests.length > 0 || stackedPullRequests(detail.tasks).length > 0 ? (
            <p className="muted swarm-grace-note">
              This swarm&apos;s pull request is open, so its sandbox was released. A retry rebuilds it from the branch on
              GitHub, and a failed task keeps its own sandbox until about {graceDate(swarm.updatedAt)}.
            </p>
          ) : (
            <p className="muted swarm-grace-note">
              This swarm&apos;s sandbox is kept until about {graceDate(swarm.updatedAt)} so its tasks and merge queue can be
              retried. Its branches are also on GitHub when the project has a GitHub connection.
            </p>
          )
        )}

        <SwarmStats detail={detail} model={model} agents={agents} busy={busy} now={now} onWorkers={actions.onWorkers} />

      </div>

      {/*
       * The diagram and the rail. The tree is what the page is for, so
       * it is on screen at first paint with the goal, the artifacts and
       * the pull request beside it, and the rail hides to give it the
       * whole width. On a phone the rail's cards stack under the tree.
       */}
      <div className="swarm-body" data-rail={railOpen ? "open" : "closed"}>
        <div className="swarm-main">
          {plannerAtCapacity ? (
            <div className="swarm-capacity-stage">
              <CapacityNotice context="planner" busy={busy} onRetry={actions.onRetryPlanner} />
              <p className="swarm-capacity-next">Once the planner starts, your task tree will appear here.</p>
            </div>
          ) : (
            <>
              <div className="swarm-viewbar">
                <span className="swarm-section-title">Task tree</span>
                <span className="swarm-viewbar-note">{treeWords(model, swarm.status, stillWords)}</span>
                <div className="seg swarm-view-toggle" role="group" aria-label="View">
                  <button
                    type="button"
                    className="seg-item"
                    data-on={view === "tree" ? "" : undefined}
                    aria-current={view === "tree" ? "page" : undefined}
                    onClick={() => onView("tree")}
                  >
                    Tree
                  </button>
                  <button
                    type="button"
                    className="seg-item"
                    data-on={view === "outline" ? "" : undefined}
                    aria-current={view === "outline" ? "page" : undefined}
                    onClick={() => onView("outline")}
                  >
                    Outline
                  </button>
                </div>
              </div>

              {view === "tree" ? (
                <SwarmTree key={detail.swarm.id} model={model} selectedId={selectedId} onSelect={onSelect} onToggle={onToggleNode} search={search}
                  plannerRun={detail.plannerRun} onRetryPlanner={actions.onRetryPlanner} onOpenPlannerOutput={onOpenPlannerOutput} canRetryPlanner={!planReady && swarm.status === "planning"} busy={busy} now={now} />
              ) : (
                <SwarmOutline model={model} selectedId={selectedId} onSelect={onSelect}
                  plannerRun={detail.plannerRun} onRetryPlanner={actions.onRetryPlanner} onOpenPlannerOutput={onOpenPlannerOutput} canRetryPlanner={!planReady && swarm.status === "planning"} busy={busy} now={now} />
              )}
            </>
          )}
        </div>

        {!railOpen && (
          <div className="swarm-rail-strip" role="toolbar" aria-label="Swarm details, collapsed">
            <button type="button" className="swarm-rail-show" aria-label="Show details" title="Show details" onClick={() => setRail(true)}>
              <ChevronMark left />
            </button>
            <button type="button" className="swarm-rail-icon" aria-label="Goal and plan sources" title="Goal and plan sources" onClick={() => showCard("goal")}>
              <GoalMark />
            </button>
            <button
              type="button"
              className="swarm-rail-icon"
              aria-label={`Artifacts, ${artifacts.length}`}
              title={`Artifacts, ${artifacts.length}`}
              onClick={() => showCard("artifacts")}
            >
              <FileMark size={15} />
              {artifacts.length > 0 && <span className="swarm-rail-badge swarm-mono">{artifacts.length}</span>}
            </button>
            <button
              type="button"
              className="swarm-rail-icon"
              data-tone={detail.pullRequests.length > 0 || stackedPullRequests(detail.tasks).length > 0 ? "succeeded" : undefined}
              aria-label={pullRequestWords(detail)}
              title={pullRequestWords(detail)}
              onClick={() => showCard("pull-request")}
            >
              <PullRequestMark />
            </button>
          </div>
        )}

        <aside ref={railRef} className="swarm-rail" aria-label="Swarm details">
          <div className="swarm-rail-head">
            <span className="swarm-rail-label">Details</span>
            <button
              type="button"
              className="swarm-rail-hide"
              aria-label="Hide details"
              title="Hide details"
              aria-expanded={railOpen}
              onClick={() => setRail(false)}
            >
              Hide
              <ChevronMark right />
            </button>
          </div>

          <section className="swarm-card swarm-rail-goal" aria-label="Swarm goal" data-rail-card="goal">
            <div className="swarm-card-head">
              <span className="swarm-card-title">Goal</span>
              <span className="swarm-card-spacer" />
              {planNote(swarm.planMode, detail.planSources ?? []) && (
                <span className="swarm-card-note">{planNote(swarm.planMode, detail.planSources ?? [])}</span>
              )}
            </div>
            <p className="swarm-goal-text">{swarm.goal}</p>
            <SwarmPlanBrief planMode={swarm.planMode} sources={detail.planSources ?? []} />
          </section>

          {artifacts.length > 0 && (
            <SwarmArtifacts artifacts={artifacts} deliverable={swarm.deliverable} tasks={detail.tasks} now={now} onOpen={onOpenArtifact} />
          )}

          {pullRequestCardShown(detail, publish, Boolean(actions.onPublish)) && (
            <SwarmPullRequestCard
              detail={detail}
              publish={publish}
              busy={busy}
              onPublish={actions.onPublish}
            />
          )}
        </aside>
      </div>

      {detail.landings.length > 0 && (
        <MergeQueue
          key={swarm.id}
          landings={detail.landings}
          summary={detail.landingSummary}
          destination={swarm.branchName}
          swarmDone={swarm.status === "done"}
          checkout={detail.branchCheckout}
          onReleaseBranch={actions.onReleaseBranch}
          onRetryLanding={actions.onRetryLanding}
          swarmStatus={swarm.status}
          busy={busy}
          tasks={detail.tasks}
          selectedId={selectedId}
          onSelect={onSelect}
          loadFinished={actions.onLoadLandings}
        />
      )}
    </div>
  );
}

/** What the goal card's header says about where the plan came from, or nothing for an ordinary swarm. */
function planNote(planMode: SwarmDetail["swarm"]["planMode"], sources: SwarmPlanSource[]): string | null {
  if (planMode === "existing") return sources.length > 0 ? "Existing plan" : "The goal is the plan";
  return sources.length > 0 ? "Read before planning" : null;
}

/** The three cards on the rail, as the collapsed strip names them. */
type RailCard = "goal" | "artifacts" | "pull-request";

/**
 * The line beside "Task tree": how far along, and whether anything
 * waits on a person. The longer sentence about what is waiting stays
 * under the title; this is the glance.
 */
export function treeWords(model: SwarmModel, status: SwarmDetail["swarm"]["status"], stillWords: string | null): string {
  const done = `${model.root.doneLeaves} of ${model.root.totalLeaves} tasks done`;
  if (status === "waiting") return `${done} · waiting on you`;
  if (stillWords) return `${done} · nothing running`;
  if (status === "done") return `${done} · nothing waiting on you`;
  return done;
}

/** What the collapsed strip's pull request button is called. */
function pullRequestWords(detail: SwarmDetail): string {
  const prs = detail.pullRequests;
  if (prs.length === 1) return `Pull request #${prs[0]!.number}`;
  if (prs.length > 1) return `${prs.length} pull requests`;
  const stacked = stackedPullRequests(detail.tasks);
  if (stacked.length > 0) return `${stacked.length} stacked pull requests`;
  return "Pull request, not opened yet";
}

/** When the swarm last moved, for the title row: finished, ended, started, or created. */
function whenWords(swarm: SwarmDetail["swarm"], now: number): string {
  if (swarm.endedAt) return `${swarm.status === "done" ? "Finished" : "Ended"} ${formatAge(swarm.endedAt, now)}`;
  if (swarm.startedAt) return `Started ${formatAge(swarm.startedAt, now)}`;
  return `Created ${formatAge(swarm.createdAt, now)}`;
}

/** The swarm's branch in mono, with a button that copies it. */
function BranchName({ name }: { name: string }) {
  const [copied, setCopied] = useCopied();
  return (
    <span className="swarm-branch" title={name}>
      <BranchMark />
      <span className="swarm-branch-name">{name}</span>
      <button
        type="button"
        className="swarm-copy"
        aria-label={copied ? "Branch name copied" : "Copy branch name"}
        title={copied ? "Copied" : "Copy branch name"}
        onClick={() => setCopied(name)}
      >
        {copied ? <TickMark /> : <CopyMark />}
      </button>
    </span>
  );
}

/** Copies text, and says so for a moment. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void copyText(text).then(() => setCopied(true), () => setCopied(false));
    },
  ];
}

/**
 * The swarm's figures, as one strip.
 *
 * Tasks, agent time, spend, workers, how long it has run, and who is
 * on it. Spend is drawn only when there is something to say about it:
 * a figure the agents reported, or a budget to hold it against.
 * Nothing here folds with the goal, because these are what a person
 * checks on every visit.
 */
function SwarmStats({
  detail,
  model,
  agents,
  busy,
  now,
  onWorkers,
}: {
  detail: SwarmDetail;
  model: SwarmModel;
  agents: SwarmAgent[];
  busy?: boolean;
  now: number;
  onWorkers: (workers: number) => void;
}) {
  const swarm = detail.swarm;
  const leaves = model.nodes.filter((node) => node.nodeType === "leaf");
  const open = leaves.filter((node) => node.status === "open").length;
  const blocked = leaves.filter((node) => node.status === "blocked").length;
  const started = swarm.startedAt ?? swarm.createdAt;
  const ran = elapsedSince(started, swarm.endedAt ? new Date(swarm.endedAt).getTime() : now);
  const nameOf = (id: string | null, fallback: string) =>
    (id ? agents.find((agent) => agent.id === id)?.name : undefined) ?? fallback;
  const planner = nameOf(swarm.settings.plannerProfileId, detail.plannerRun?.agent?.name ?? "Swarm Planner");
  const worker = nameOf(swarm.settings.workerProfileId, "Swarm Worker");
  const judge = swarm.settings.judgeProfileId ? nameOf(swarm.settings.judgeProfileId, "an agent") : null;

  return (
    <div className="swarm-stats" role="list" aria-label="Swarm figures">
      <div className="swarm-stat" role="listitem" title="Tasks done, out of the tasks planned">
        <span className="swarm-stat-label">Tasks</span>
        <span className="swarm-stat-value">
          {model.root.doneLeaves}
          <span className="swarm-stat-of"> / {model.root.totalLeaves}</span>
        </span>
        <span className="swarm-stat-sub">{open} open · {blocked} blocked</span>
      </div>
      <div className="swarm-stat" role="listitem" title="Agent run time, excluding time spent waiting between runs">
        <span className="swarm-stat-label">Agent time</span>
        <span className="swarm-stat-value">{formatElapsed(detail.agentTimeMs ?? 0)}</span>
        <span className="swarm-stat-sub">Not counting waits</span>
      </div>
      {showSwarmSpend(swarm.spend, swarm.budgetUsd) && (
        <div className="swarm-stat swarm-spend-summary" role="listitem">
          <span className="swarm-stat-label">Spend estimate</span><strong className="spend-figure">{formatUsd(cappedUsd(swarm.spend))}</strong>
          <small className="swarm-stat-sub">{swarm.budgetUsd === null ? "No budget cap" : `${formatUsd(swarm.budgetUsd)} budget`}</small>
        </div>
      )}
      <div className="swarm-stat swarm-worker-control" role="listitem">
        <span className="swarm-stat-label">Workers</span>
        <span className="swarm-stat-line">
          <span className="swarm-stat-value">
            {swarm.workers}
            <span className="swarm-stat-of"> / {swarm.maxWorkers}</span>
          </span>
          <WorkerStepper
            workers={swarm.workers}
            active={swarm.workersActive}
            max={swarm.maxWorkers}
            disabledReason={busy ? "Wait for the current change to finish." : !canStop(swarm.status) ? "Worker count cannot change after the swarm ends." : null}
            onChange={onWorkers}
          />
        </span>
        <span className="swarm-stat-sub">{swarm.workersActive > 0 ? `${swarm.workersActive} active` : "None active"}</span>
      </div>
      <div className="swarm-stat" role="listitem">
        <span className="swarm-stat-label">Duration</span>
        <span className="swarm-stat-value">{formatDuration(ran)}</span>
        <span className="swarm-stat-sub">Started {shortDate(started, now)}</span>
      </div>
      <div className="swarm-stat swarm-stat-agents" role="listitem" title={`Planner: ${planner}. Worker: ${worker}.`}>
        <span className="swarm-stat-label">Agents</span>
        <span className="swarm-stat-names">
          <span>{planner}</span>
          <span>{worker}</span>
        </span>
        <span className="swarm-stat-sub">{judge ? `Judge: ${judge}` : "Judge: none"}</span>
      </div>
    </div>
  );
}

/**
 * Whether to offer pull requests, and in what words.
 *
 * Offered as soon as one task is committed to the swarm's branch, so a
 * person can get the work onto GitHub before the sandbox holding it is
 * reaped. A combined pull request follows the swarm's branch by itself,
 * so once it is open there is nothing more to offer; a stack covers the
 * tasks landed when it was opened, so tasks landed since are offered as
 * an addition to it.
 */
function PublishOutcome({ outcome }: { outcome: SwarmPublishOutcome }) {
  return (
    <div className="swarm-pr-outcome" role="status">
      {outcome.pullRequests.length > 0 && (
        <p>
          Opened{" "}
          {outcome.pullRequests.map((pr, index) => (
            <Fragment key={`${pr.name}#${pr.number}`}>
              {index > 0 && ", "}
              {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> : `#${pr.number}`}
            </Fragment>
          ))}
        </p>
      )}
      {outcome.behind && <p>Missing tasks: the sandbox was lost before they reached GitHub.</p>}
      {outcome.failures.map((failure) => (
        <p key={failure.name} className="muted">{failure.name}: {failure.reason}</p>
      ))}
    </div>
  );
}

export function publishOffer(detail: SwarmDetail): { words: string; stackOnly: boolean } | null {
  if (detail.pullRequests.length > 0) return null;
  const committed = detail.landingSummary?.committed
    ?? detail.landings.filter((landing) => landing.status === "landed").length;
  if (committed === 0) return null;
  const stacked = new Set(stackedPullRequests(detail.tasks).map((pr) => pr.taskId));
  if (stacked.size > 0) {
    const unstacked = detail.tasks.filter((task) => {
      const heads = (task.flags as { landedHeads?: Record<string, unknown> }).landedHeads;
      return heads && Object.keys(heads).length > 0 && !stacked.has(task.id);
    }).length;
    if (unstacked === 0) return null;
    return {
      words: unstacked === 1
        ? "1 task was committed after the stack of pull requests was created."
        : `${unstacked} tasks were committed after the stack of pull requests was created.`,
      stackOnly: true,
    };
  }
  if (detail.swarm.status === "done") {
    return {
      words: "Every branch is on GitHub. Open the pull requests as one for the swarm, or one per task, stacked in the order the tasks were committed.",
      stackOnly: false,
    };
  }
  return {
    words: `${committed === 1 ? "1 task is" : `${committed} tasks are`} committed to the swarm's branch. Open pull requests now to keep that work on GitHub if the swarm's sandbox is deleted. One pull request picks up later commits automatically. A stack can be extended later.`,
    stackOnly: false,
  };
}

/**
 * Whether the pull request card has anything to say: a pull request,
 * a stack, what a publish just did, or an offer to open one.
 */
function pullRequestCardShown(
  detail: SwarmDetail,
  publish: { inFlight: "combined" | "stacked" | null; outcome: SwarmPublishOutcome | null } | null,
  canPublish: boolean,
): boolean {
  return (
    detail.pullRequests.length > 0 ||
    stackedPullRequests(detail.tasks).length > 0 ||
    Boolean(publish?.outcome) ||
    (canPublish && publishOffer(detail) !== null)
  );
}

/** A repository address as a person reads it: owner and name, without the host. */
export function repoLabel(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/**
 * The swarm's pull request, or the offer to open one.
 *
 * One card whatever state it is in, so the place a person looks for
 * the pull request is the same before it exists and after. Its rows
 * are only what the console actually has: the repository and number,
 * the swarm's branch, and the head commit the server recorded. Checks,
 * reviews and line counts would be rows here too, and are not drawn
 * because the swarm detail carries none of them; they can be added
 * when the API does.
 *
 * A pull request is a link only when its row carried an address the
 * console would follow. `client.ts` nulls anything that is not http or
 * https, because an href is the one place a string the agents' side of
 * the world wrote could run as the console. Drawn as text instead,
 * with the reason in the tooltip, so a pull request that exists is
 * still visible.
 */
function SwarmPullRequestCard({
  detail,
  publish,
  busy,
  onPublish,
}: {
  detail: SwarmDetail;
  publish: { inFlight: "combined" | "stacked" | null; outcome: SwarmPublishOutcome | null } | null;
  busy?: boolean;
  onPublish?: (mode: "combined" | "stacked") => void;
}) {
  const swarm = detail.swarm;
  const prs = detail.pullRequests;
  const stacked = stackedPullRequests(detail.tasks);
  const offer = onPublish && !publish?.outcome ? publishOffer(detail) : null;
  const inFlight = publish?.inFlight ?? null;
  const single = prs.length === 1 ? prs[0]! : null;
  const [copied, copy] = useCopied();
  const plural = prs.length > 1 || (prs.length === 0 && stacked.length > 0);

  return (
    <section
      className="swarm-card swarm-pr-card"
      aria-label={plural ? "Pull requests" : "Pull request"}
      aria-busy={inFlight !== null}
    >
      <div className="swarm-card-head">
        <span className="swarm-card-title">{plural ? "Pull requests" : "Pull request"}</span>
        {plural && <span className="swarm-card-count">{prs.length > 0 ? prs.length : stacked.length}</span>}
        <span className="swarm-card-spacer" />
        {prs.length === 0 && stacked.length > 0 ? (
          <span className="swarm-card-note">Stacked, each on the one before</span>
        ) : prs.length === 0 && !publish?.outcome ? (
          <span className="swarm-card-note">Not opened yet</span>
        ) : null}
      </div>

      {publish?.outcome && (
        <div className="swarm-pr-body">
          <PublishOutcome outcome={publish.outcome} />
        </div>
      )}

      {prs.map((pr) => (
        <div key={pr.id} className="swarm-pr">
          <div className="swarm-pr-title">
            {pr.url ? (
              <a className="swarm-pr-name" href={pr.url} target="_blank" rel="noreferrer">
                {repoLabel(pr.repoUrl)} <span className="swarm-pr-number">#{pr.number}</span>
              </a>
            ) : (
              <span className="swarm-pr-name" title="This pull request's address is not a web link, so it is shown without one.">
                {repoLabel(pr.repoUrl)} <span className="swarm-pr-number">#{pr.number}</span>
              </span>
            )}
            <span className="swarm-pr-sub">{pr.repoUrl}</span>
          </div>
          {/* Checks, review and change counts belong here once the API carries them. */}
          <dl className="swarm-pr-rows">
            {swarm.branchName && (
              <>
                <dt>Branch</dt>
                <dd className="swarm-mono" title={swarm.branchName}>{swarm.branchName}</dd>
              </>
            )}
            {pr.headSha && (
              <>
                <dt>Head commit</dt>
                <dd className="swarm-mono" title={pr.headSha}>{pr.headSha.slice(0, 7)}</dd>
              </>
            )}
          </dl>
        </div>
      ))}

      {stacked.length > 0 && (
        <ol className="swarm-pr-stack" aria-label="Stacked pull requests">
          {stacked.map((pr, index) => (
            <li key={pr.key}>
              <span className="swarm-pr-stack-index swarm-mono">{index + 1}</span>
              {pr.url ? (
                <a className="swarm-pr-name" href={pr.url} target="_blank" rel="noreferrer" title={pr.repoUrl}>
                  {pr.title} <span className="swarm-pr-number">#{pr.number}</span>
                </a>
              ) : (
                <span className="swarm-pr-name" title="This pull request's address is not a web link, so it is shown without one.">
                  {pr.title} <span className="swarm-pr-number">#{pr.number}</span>
                </span>
              )}
              <span className="swarm-pr-stack-onto">{index > 0 ? `onto #${stacked[index - 1]!.number}` : ""}</span>
            </li>
          ))}
        </ol>
      )}

      {offer && (
        <div className="swarm-pr-body" role="group" aria-label="Open pull requests">
          {!offer.stackOnly && (
            <span className="swarm-pr-offer-title">{swarm.status === "done" ? "Ready for review" : "Keep the work on GitHub"}</span>
          )}
          <p className="swarm-pr-offer">{offer.words}</p>
        </div>
      )}

      {(offer || single?.url) && (
        <div className="swarm-card-foot">
          {offer ? (
            offer.stackOnly ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => onPublish?.("stacked")}>
                {inFlight === "stacked" ? "Opening\u2026" : "Add them to the stack"}
              </button>
            ) : (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => onPublish?.("combined")}>
                  {inFlight === "combined" ? "Opening\u2026" : "Open pull request"}
                </button>
                <button className="btn" disabled={busy} onClick={() => onPublish?.("stacked")}>
                  {inFlight === "stacked" ? "Opening\u2026" : "Open one per task"}
                </button>
              </>
            )
          ) : (
            single?.url && (
              <>
                <a className="btn swarm-pr-open" href={single.url} target="_blank" rel="noreferrer">
                  Open on GitHub <span aria-hidden="true">{"\u2197"}</span>
                </a>
                <button
                  className="btn swarm-copy-link"
                  onClick={() => copy(single.url!)}
                  aria-label={copied ? "Link copied" : "Copy link"}
                  title={copied ? "Link copied" : "Copy link"}
                >
                  {copied ? <TickMark /> : <CopyMark />}
                </button>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What the swarm produced for people to read, as a list on the rail:
 * the file's name, and one line saying what it is, how big, where it
 * came from and when.
 *
 * On a document swarm the assembled file is the deliverable, so it is
 * named as such and sits first: it is what the swarm was for, and a
 * person opening the page after it finished is looking for it rather
 * than for the tree.
 *
 * Nothing here renders an artifact. Opening one hands it to the drawer,
 * which renders through the same canvas a card's artifacts use: that is
 * where the rule lives that keeps agent bytes off this origin, markdown
 * through react-markdown with raw HTML off, HTML only inside a
 * sandboxed iframe, everything else offered as a download. A second
 * renderer here would be a second place for that to be got wrong.
 */
export function SwarmArtifacts({
  artifacts,
  deliverable,
  tasks = [],
  now = Date.now(),
  onOpen,
}: {
  artifacts: SwarmArtifact[];
  deliverable: SwarmDetail["swarm"]["deliverable"];
  tasks?: SwarmDetail["tasks"];
  now?: number;
  onOpen?: (artifact: SwarmArtifact) => void;
}) {
  if (artifacts.length === 0) return null;
  const ordered = orderArtifacts(artifacts, deliverable);
  const lead = deliverable === "document" ? leadDocument(artifacts) : undefined;

  return (
    <section className="swarm-card swarm-artifacts" aria-label={lead ? "The document" : "Artifacts"}>
      <div className="swarm-card-head">
        <span className="swarm-card-title">{deliverable === "document" ? "The document" : "Artifacts"}</span>
        <span className="swarm-card-count">{artifacts.length}</span>
      </div>
      <ul className="swarm-art-list">
        {ordered.map((artifact) => {
          const { name } = splitArtifactPath(artifact.path);
          const isLead = artifact === lead;
          const type = artifactTypeLabel(artifact.kind);
          const source = artifactSourceLabel(artifact, tasks);
          const age = formatAge(artifact.createdAt, now);
          return (
            <li key={artifact.id} className="swarm-art-row" data-lead={isLead ? "" : undefined}>
              <button type="button" className="swarm-art-open" disabled={!onOpen} title={artifact.path} onClick={() => onOpen?.(artifact)}>
                <ArtifactMark kind={artifact.kind} />
                <span className="swarm-art-names">
                  <span className="swarm-art-name">{name}</span>
                  <span className="swarm-art-meta" title={isLead ? "Combined document, committed to the swarm branch." : undefined}>
                    {[isLead ? "Combined document" : type, formatBytes(artifact.size), isLead ? null : source, age].filter(Boolean).join(" \u00B7 ")}
                  </span>
                </span>
                <span className="swarm-art-go" aria-hidden="true"><ChevronMark right /></span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The assembled document, found by what it is rather than by where it
 * sits in the list. It was written last on a swarm's first pass, so
 * newest first happened to put it at the top; a swarm reopened and
 * worked again puts its workers' files above it, and the table would
 * then caption one of those as the combined document.
 */
function leadDocument(artifacts: SwarmArtifact[]): SwarmArtifact | undefined {
  return artifacts.find((artifact) => artifact.stageSlug === "document");
}

/**
 * The artifacts in the order the page lists them, which is also the
 * order the drawer steps through: a document swarm's assembled file
 * first, then the rest as the route sent them, newest first.
 */
export function orderArtifacts(artifacts: SwarmArtifact[], deliverable: SwarmDetail["swarm"]["deliverable"]): SwarmArtifact[] {
  const lead = deliverable === "document" ? leadDocument(artifacts) : undefined;
  return lead ? [lead, ...artifacts.filter((artifact) => artifact.id !== lead.id)] : artifacts;
}

function ArtifactMark({ kind }: { kind: SwarmArtifact["kind"] }) {
  if (kind === "image") return <ImageMark />;
  if (kind === "mermaid") return <DiagramMark />;
  return <FileMark />;
}

/**
 * How many workers this swarm may run at once, one more or one fewer.
 *
 * A stepper rather than a field: the number is small, bounded by
 * MAX_SWARM_WORKERS, and changed by one far more often than it is
 * typed. The figure itself is printed beside it by whoever draws it,
 * with what is already working, because raising the ceiling while six
 * workers are busy is a different decision from raising it while none
 * are.
 */
export function WorkerStepper({
  workers,
  active,
  max,
  disabledReason,
  onChange,
}: {
  workers: number;
  active: number;
  max: number;
  disabledReason?: string | null;
  onChange: (workers: number) => void;
}) {
  const decreaseReason = disabledReason ?? (workers <= 1 ? "A swarm needs at least one worker." : null);
  const increaseReason = disabledReason ?? (workers >= max ? `Maximum is ${max} workers.` : null);
  return (
    <span className="swarm-stepper" role="group" aria-label="Workers" title={`${active} of ${workers} working, maximum ${max} workers`}>
      <span className="swarm-worker-step" title={decreaseReason ?? `Decrease to ${workers - 1} workers`}>
        <button
          type="button"
          className="swarm-stepper-btn"
          aria-label="One fewer worker"
          disabled={Boolean(decreaseReason)}
          onClick={() => onChange(workers - 1)}
        >
          <StepMark direction="down" />
        </button>
      </span>
      <span className="swarm-worker-step" title={increaseReason ?? `Increase to ${workers + 1} workers`}>
        <button
          type="button"
          className="swarm-stepper-btn"
          aria-label="One more worker"
          disabled={Boolean(increaseReason)}
          onClick={() => onChange(workers + 1)}
        >
          <StepMark direction="up" />
        </button>
      </span>
    </span>
  );
}

function StepMark({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 8h9" />
      {direction === "up" && <path d="M8 3.5v9" />}
    </svg>
  );
}

function GoalMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 2v2M8 12v2M2 8h2M12 8h2" />
    </svg>
  );
}

function PullRequestMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H8.5M10 3 8 5l2 2" />
    </svg>
  );
}

function BranchMark() {
  return (
    <svg className="swarm-mark" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </svg>
  );
}

function CopyMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function TickMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

/**
 * The planner asking something.
 *
 * A banner with the reply in it, rather than a notification that
 * sends you somewhere else: the question is the only thing standing
 * between this swarm and its next task, and the answer is usually a
 * sentence.
 */
function PlannerQuestionBanner({
  question,
  busy,
  onAnswer,
}: {
  question: { id: string; text: string };
  busy?: boolean;
  onAnswer: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="swarm-question" role="status">
      <div className="swarm-question-copy">
        <span className="label">The planner is asking</span>
        {/* Agent written, so text and only text. */}
        <p className="swarm-text">{question.text}</p>
      </div>
      <form
        className="swarm-question-reply"
        onSubmit={(e) => {
          e.preventDefault();
          const answer = text.trim();
          if (!answer) return;
          setText("");
          onAnswer(answer);
        }}
      >
        <input
          className="input"
          value={text}
          placeholder="Answer the planner"
          aria-label="Answer the planner"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || text.trim() === ""}>
          Send
        </button>
      </form>
    </div>
  );
}

/** When a failed swarm's sandbox is reaped, a week after the swarm last changed, as a date. */
function graceDate(updatedAt: string): string {
  const date = new Date(new Date(updatedAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The per-task pull requests of a swarm published as a stack, in the
 * order the tasks were laid out. Each task records its own, per
 * repository; the address goes through the same check every other
 * link here does.
 */
export function stackedPullRequests(
  tasks: SwarmDetail["tasks"],
): { key: string; taskId: string; title: string; repoUrl: string; number: number; url: string | null }[] {
  const out: { key: string; taskId: string; title: string; repoUrl: string; number: number; url: string | null }[] = [];
  for (const task of tasks) {
    const prs = (task.flags as { pullRequests?: Record<string, { number?: unknown; url?: unknown }> }).pullRequests;
    if (!prs || typeof prs !== "object") continue;
    for (const [repoUrl, pr] of Object.entries(prs)) {
      if (typeof pr?.number !== "number") continue;
      out.push({
        key: `${task.id}:${repoUrl}`,
        taskId: task.id,
        title: task.title,
        repoUrl,
        number: pr.number,
        url: typeof pr.url === "string" ? externalHttpUrl(pr.url) : null,
      });
    }
  }
  return out;
}
