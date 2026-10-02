import { useEffect, useState } from "react";
import { CompletionRing } from "./CompletionRing.js";
import { MergeQueue } from "./MergeQueue.js";
import { OutOfCompute } from "./OutOfCompute.js";
import { SwarmOutline } from "./SwarmOutline.js";
import { SwarmTree } from "./SwarmTree.js";
import { canPause, canReopen, canResume, canStop, pausedWords, swarmTone, swarmWords } from "../swarm/status.js";
import { cappedUsd, formatUsd } from "../swarm/money.js";
import { formatCompletion, type SwarmModel } from "../swarm/layout.js";
import { formatElapsed } from "../swarm/time.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { SwarmArtifact, SwarmDetail, SwarmPlanSource } from "../swarm/types.js";
import { browserStorage, readBriefOpen, rememberBriefOpen, type SwarmView } from "../swarm/view-state.js";

/** Ticks the header's clock, and only while there is something running. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
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
  /**
   * Opens a pull request for the swarm's branch.
   *
   * Optional, and absent is the answer today: no route does it, so the
   * button says so by being unavailable rather than by doing nothing
   * when it is pressed.
   */
  onCreatePullRequest?: () => void;
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
 * and the code. A swarm handed a plan says so, and lists what was
 * handed over: a person reading the tree wants to know whether it was
 * the planner's idea or theirs, and which file it came from.
 */
export function SwarmPlanBrief({
  planMode,
  sources,
}: {
  planMode: SwarmDetail["swarm"]["planMode"];
  sources: NonNullable<SwarmDetail["planSources"]>;
}) {
  if (planMode !== "existing" && sources.length === 0) return null;
  return (
    <div className="swarm-brief-plan">
      <span className="label">{planMode === "existing" ? "Existing plan" : "Plan material"}</span>
      <p className="muted">
        {planMode === "existing"
          ? sources.length > 0
            ? "The planner builds the task tree from this plan rather than from the goal alone."
            : "The goal is the plan. The planner builds the task tree from it rather than planning from scratch."
          : "The planner reads these before it plans."}
      </p>
      {sources.length > 0 && (
        <ul className="swarm-plan-sources" aria-label="Plan sources">
          {sources.map((source) => (
            <li key={source.id} data-media={source.media}>
              {source.media === "image" && (
                <img className="swarm-plan-source-thumb" src={source.contentPath} alt="" loading="lazy" />
              )}
              <span className="swarm-plan-source-kind">{planSourceLabel(source)}</span>
              {source.url
                ? <a className="swarm-plan-source-name" href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}>{source.name}</a>
                : <span className="swarm-plan-source-name" title={source.name}>{source.name}</span>}
              <span className="muted">{planSourceSize(source)}</span>
              {source.media !== "text" && (
                <a className="swarm-plan-source-open" href={source.contentPath} target="_blank" rel="noreferrer noopener">
                  {source.media === "image" ? "Open" : "Download"}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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

/** How big a source is, in the unit a person reads it by. */
export function planSourceSize(source: Pick<SwarmPlanSource, "media" | "size" | "hasText" | "byteSize">): string {
  if (source.media === "text") return `${source.size.toLocaleString()} characters`;
  const bytes = formatBytes(source.byteSize ?? 0);
  if (source.media === "image") return bytes;
  return source.hasText ? `${bytes}, ${source.size.toLocaleString()} characters of text` : `${bytes}, no text (a scan)`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * One swarm's page: the header, and the plan under it.
 *
 * The header names the swarm and its next action. The brief beneath
 * it carries the goal, the spend estimate and the worker limit.
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
  actions,
  surfaces,
  busy,
  artifacts = [],
  onOpenArtifact,
  onOpenPlannerOutput,
}: {
  detail: SwarmDetail;
  model: SwarmModel;
  view: SwarmView;
  onView: (view: SwarmView) => void;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  onToggleNode: (taskId: string) => void;
  actions: SwarmActions;
  surfaces: ModeSurfaces;
  busy?: boolean;
  /** What the swarm produced for people to read, newest first. */
  artifacts?: SwarmArtifact[];
  /** Opens one in the viewer every other artifact in Bento opens in. */
  onOpenArtifact?: (artifact: SwarmArtifact) => void;
  onOpenPlannerOutput?: () => void;
}) {
  /*
   * The brief folds to one line so the diagram gets the screen. The
   * choice is this browser's, remembered across swarms, and never in
   * the address: whoever follows a link sees the goal.
   */
  const [briefOpen, setBriefOpen] = useState(() => readBriefOpen(browserStorage()));
  const toggleBrief = () => {
    const next = !briefOpen;
    setBriefOpen(next);
    rememberBriefOpen(browserStorage(), next);
  };
  const swarm = detail.swarm;
  const live = canPause(swarm.status);
  const now = useNow(live);
  const stopped = pausedWords(swarm.status, swarm.pausedReason);
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
  const plannerFailed = waitingForPlan && detail.plannerRun?.status === "failed";
  const primaryAction = planNeedsApproval
    ? { label: "Approve plan", onClick: actions.onResume }
    : canResume(swarm.status)
      ? { label: "Resume work", onClick: actions.onResume }
      : canReopen(swarm.status)
        ? { label: "Add follow up", onClick: actions.onReopen }
        : swarm.status === "running"
          ? { label: "Pause work", onClick: actions.onPause }
          : null;

  return (
    <div className="swarm-page">
      <ComputeBanner surfaces={surfaces} pausedReason={swarm.pausedReason} />

      {/*
       * Why this swarm is not starting anything, in a sentence.
       *
       * Four different things leave a swarm sitting still, and the
       * status word is the same for two of them. What a person needs
       * is which one and what it takes to move it, so the header says
       * it rather than leaving them to guess from a greyed out button.
       */}
      {stopped && (
        <p className="swarm-paused" role="status">
          {stopped}
        </p>
      )}

      <header className="swarm-head">
        <div className="swarm-head-lead">
          <CompletionRing fraction={model.root.completion} size={40} stroke={3.2} showLabel />
          <div className="swarm-head-copy">
            <h1 className="swarm-name">{swarm.name}</h1>
            <div className="swarm-head-chips">
              <span className="status">
                <span className="dot" data-state={plannerFailed || swarm.status === "failed" ? "gated" : swarmTone(swarm.status)} />
                {plannerFailed || swarm.status === "failed" ? "stalled" : swarmWords(swarm.status)}
              </span>
              {swarm.branchName && (
                <span className="chip chip-clip" title={swarm.branchName}>
                  {swarm.branchName}
                </span>
              )}
              <span className="chip" title="Agent run time, excluding time spent waiting between runs">
                {formatElapsed(detail.agentTimeMs ?? 0)} agent time
              </span>
              <span className="chip" title="Tasks done, out of the tasks planned">
                {model.root.doneLeaves} of {model.root.totalLeaves} tasks
              </span>
              {/* That this is not the first pass, said on the header.
                  The tree says which subtree each follow up is; this
                  says there were any. */}
              {swarm.reopenCount > 0 && (
                <span
                  className="chip"
                  title="This swarm was reopened, so part of its tree is follow up work on the same branch."
                >
                  {swarm.reopenCount === 1 ? "Reopened once" : `Reopened ${swarm.reopenCount} times`}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="swarm-head-actions">
          {primaryAction && <button className="btn btn-primary swarm-main-action" disabled={busy} onClick={primaryAction.onClick}>{primaryAction.label}</button>}
          {waitingForPlan && plannerActive && <span className="swarm-awaiting-plan">Planner at work</span>}
          <button className="btn" disabled={busy} onClick={actions.onSettings}>Settings</button>
          <details className="swarm-more-actions">
            <summary className="btn" aria-label="More swarm actions">
              <span>Actions</span>
              <svg className="swarm-actions-chevron" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="swarm-more-menu">
              {swarm.status === "planning" && plannerActive && canPause(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onPause}>Pause planner</button>}
              {planNeedsApproval && (swarm.status === "running" || swarm.status === "waiting") && (
                <button className="btn" disabled={busy} onClick={actions.onPause}>Pause work</button>
              )}
              {canStop(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onStop}>Stop swarm</button>}
              {swarm.archivedAt ? (
                <button className="btn" disabled={busy} onClick={actions.onRestore}>Restore</button>
              ) : (
                canReopen(swarm.status) && (
                  <button className="btn" disabled={busy} onClick={actions.onArchive}>Archive</button>
                )
              )}
              {actions.onCreatePullRequest && <button className="btn" disabled={busy} onClick={actions.onCreatePullRequest}>Create PR</button>}
              <button className="btn btn-danger-quiet" disabled={busy} onClick={actions.onDelete}>
                Delete swarm
              </button>
            </div>
          </details>
        </div>

      </header>

      <section className="swarm-brief" aria-label="Swarm goal" data-open={briefOpen}>
        <div className="swarm-brief-copy">
          <div className="swarm-brief-head">
            <span className="label">Goal</span>
            {!briefOpen && <span className="swarm-brief-excerpt" title={swarm.goal}>{goalExcerpt(swarm.goal)}</span>}
            <button
              type="button"
              className="swarm-brief-toggle"
              aria-expanded={briefOpen}
              aria-controls="swarm-brief-body"
              onClick={toggleBrief}
            >
              {briefOpen ? "Hide" : "Show"}
              <svg className="swarm-brief-chevron" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {briefOpen && (
            <div id="swarm-brief-body">
              <p>{swarm.goal}</p>
              <SwarmPlanBrief planMode={swarm.planMode} sources={detail.planSources ?? []} />
            </div>
          )}
        </div>
        {briefOpen && <div className="swarm-brief-side">
          {waitingForPlan && (
            <p className="swarm-next-step" role="status">
              {detail.plannerRun?.status === "failed"
                ? "Planner failed. Open its output below, then retry."
                : plannerActive
                  ? "Planner is building the task tree. Review the plan here before starting work."
                  : "The plan is not ready. Message the planner to finish it."}
            </p>
          )}
          {planNeedsApproval && (
            <p className="swarm-next-step" role="status">Review the diagram, then approve the plan to start ready workers.</p>
          )}
          <div className="swarm-brief-metrics">
            <div className="swarm-spend-summary"><span>Spend estimate</span><strong className="spend-figure">{formatUsd(cappedUsd(swarm.spend))}</strong><small>{swarm.budgetUsd === null ? "No budget cap" : `${formatUsd(swarm.budgetUsd)} budget`}</small></div>
            <div className="swarm-worker-control"><span className="swarm-control-label">Workers</span><WorkerStepper workers={swarm.workers} active={swarm.workersActive} max={swarm.maxWorkers} disabledReason={busy ? "Wait for the current change to finish." : !canStop(swarm.status) ? "Worker count cannot change after the swarm ends." : null} onChange={actions.onWorkers} /></div>
          </div>
        </div>}
      </section>

      {swarm.question && (
        <PlannerQuestionBanner
          question={swarm.question}
          busy={busy}
          onAnswer={(text) => actions.onAnswer(swarm.question?.id ?? "", text)}
        />
      )}

      <SwarmArtifacts
        artifacts={artifacts}
        deliverable={swarm.deliverable}
        onOpen={onOpenArtifact}
      />

      {detail.pullRequests.length > 0 && (
        <div className="swarm-prs">
          {/*
           * A chip is a link only when the row carried an address the
           * console would follow. `client.ts` nulls anything that is
           * not http or https, because an href is the one place a
           * string the agents' side of the world wrote could run as
           * the console. Drawn as text instead, with the reason in the
           * tooltip, so a pull request that exists is still visible.
           */}
          {detail.pullRequests.map((pr) =>
            pr.url ? (
              <a key={pr.id} className="chip chip-link" href={pr.url} target="_blank" rel="noreferrer">
                {pr.repoUrl} #{pr.number}
              </a>
            ) : (
              <span
                key={pr.id}
                className="chip"
                title="This pull request's address is not a web link, so it is shown without one."
              >
                {pr.repoUrl} #{pr.number}
              </span>
            ),
          )}
        </div>
      )}

      <div className="swarm-viewbar">
        <span className="swarm-section-title">Diagram</span>
        <div className="seg" role="group" aria-label="View">
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
        <SwarmTree model={model} selectedId={selectedId} onSelect={onSelect} onToggle={onToggleNode}
          plannerRun={detail.plannerRun} onRetryPlanner={actions.onRetryPlanner} onOpenPlannerOutput={onOpenPlannerOutput} canRetryPlanner={!planReady && swarm.status === "planning"} busy={busy} now={now} />
      ) : (
        <SwarmOutline model={model} selectedId={selectedId} onSelect={onSelect}
          plannerRun={detail.plannerRun} onRetryPlanner={actions.onRetryPlanner} onOpenPlannerOutput={onOpenPlannerOutput} canRetryPlanner={!planReady && swarm.status === "planning"} busy={busy} now={now} />
      )}

      {detail.landings.length > 0 && (
        <MergeQueue
          landings={detail.landings}
          summary={detail.landingSummary}
          destination={swarm.branchName}
          swarmDone={swarm.status === "done"}
          checkout={detail.branchCheckout}
          onReleaseBranch={actions.onReleaseBranch}
          busy={busy}
          tasks={detail.tasks}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

/**
 * What the swarm produced for people to read.
 *
 * On a document swarm this is the deliverable, so it is named as such
 * and sits first: the assembled file is what the swarm was for, and a
 * person opening the page after it finished is looking for it rather
 * than for the tree.
 *
 * Nothing here renders an artifact. Opening one hands it to the same
 * viewer a card's artifacts open in, which is where the rule lives
 * that keeps agent bytes off this origin: markdown through
 * react-markdown with raw HTML off, HTML only inside a sandboxed
 * iframe, everything else offered as a download. A second renderer
 * here would be a second place for that to be got wrong.
 */
export function SwarmArtifacts({
  artifacts,
  deliverable,
  onOpen,
}: {
  artifacts: SwarmArtifact[];
  deliverable: SwarmDetail["swarm"]["deliverable"];
  onOpen?: (artifact: SwarmArtifact) => void;
}) {
  if (artifacts.length === 0) return null;
  /*
   * The assembled document is found by what it is, not by where it
   * sits in the list. It was written last on a swarm's first pass, so
   * newest first happened to put it at the top; a swarm reopened and
   * worked again puts its workers' files above it, and the panel would
   * then caption one of those "assembled from the sections in the
   * plan".
   */
  const document =
    deliverable === "document" ? artifacts.find((artifact) => artifact.stageSlug === "document") : undefined;
  const rest = document ? artifacts.filter((artifact) => artifact.id !== document.id) : artifacts;

  return (
    <section className="swarm-artifacts">
      <span className="label">{deliverable === "document" ? "The document" : "Artifacts"}</span>
      {document && (
        <button
          type="button"
          className="swarm-artifact swarm-artifact-lead"
          disabled={!onOpen}
          onClick={() => onOpen?.(document)}
        >
          <span className="swarm-artifact-name">{document.path}</span>
          <span className="muted">
            Combined document, committed to the swarm branch.
          </span>
        </button>
      )}
      {rest.length > 0 && (
        <ul className="swarm-artifact-list">
          {rest.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                className="swarm-artifact"
                disabled={!onOpen}
                onClick={() => onOpen?.(artifact)}
              >
                <span className="swarm-artifact-name">{artifact.path}</span>
                <span className="muted">{artifact.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How many workers this swarm may run at once.
 *
 * A stepper rather than a field: the number is small, bounded by
 * MAX_SWARM_WORKERS, and changed by one more or one fewer far more
 * often than it is typed. What is already working is printed beside
 * it, because raising the ceiling while six workers are busy is a
 * different decision from raising it while none are.
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
    <div className="swarm-workers" title={`${active} of ${workers} working, maximum ${max} workers`}>
      <span className="swarm-worker-step" title={decreaseReason ?? `Decrease to ${workers - 1} workers`}>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="One fewer worker"
          disabled={Boolean(decreaseReason)}
          onClick={() => onChange(workers - 1)}
        >
          <StepMark direction="down" />
        </button>
      </span>
      <span className="swarm-workers-count">
        <span className="spend-figure">{active}</span>
        <span className="swarm-workers-of">of</span>
        <span className="spend-figure">{workers}</span>
      </span>
      <span className="swarm-worker-step" title={increaseReason ?? `Increase to ${workers + 1} workers`}>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="One more worker"
          disabled={Boolean(increaseReason)}
          onClick={() => onChange(workers + 1)}
        >
          <StepMark direction="up" />
        </button>
      </span>
    </div>
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
