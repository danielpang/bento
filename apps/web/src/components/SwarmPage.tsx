import { useEffect, useState } from "react";
import { CompletionRing } from "./CompletionRing.js";
import { MergeQueue } from "./MergeQueue.js";
import { OutOfCompute } from "./OutOfCompute.js";
import { SwarmOutline } from "./SwarmOutline.js";
import { SwarmTree } from "./SwarmTree.js";
import { canPause, canReopen, canResume, canStart, canStop, pausedWords, swarmTone, swarmWords } from "../swarm/status.js";
import { cappedUsd, formatUsd } from "../swarm/money.js";
import { formatCompletion, type SwarmModel } from "../swarm/layout.js";
import { formatElapsed } from "../swarm/time.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { SwarmArtifact, SwarmDetail } from "../swarm/types.js";
import type { SwarmView } from "../swarm/view-state.js";

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
  /**
   * Keeps this swarm's shape as a template to start the next one from.
   *
   * The ceilings a swarm ends up running under are the tuning nobody
   * writes down: workers raised once the plan turned out wider than
   * expected, a budget lifted. Saving copies the template it came from
   * with those numbers written over it, so the next swarm starts where
   * this one ended up rather than where it began.
   */
  onSaveAsTemplate: () => void;
  onAnswer: (questionId: string, text: string) => void;
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
  const swarm = detail.swarm;
  const live = canPause(swarm.status);
  const now = useNow(live);
  const stopped = pausedWords(swarm.status, swarm.pausedReason);
  const planReady = detail.tasks.length > 0;
  const waitingForPlan = swarm.status === "planning" && !planReady;
  const plannerFailed = waitingForPlan && detail.plannerRun?.status === "failed";
  const primaryAction = canStart(swarm.status) && planReady
    ? { label: "Start work", onClick: actions.onResume }
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
          {waitingForPlan && !plannerFailed && <span className="swarm-awaiting-plan">Planner at work</span>}
          <details className="swarm-more-actions">
            <summary className="btn" aria-label="More swarm actions">
              <span>Actions</span>
              <svg className="swarm-actions-chevron" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="swarm-more-menu">
              {swarm.status === "planning" && !plannerFailed && canPause(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onPause}>Pause planner</button>}
              {canStop(swarm.status) && <button className="btn" disabled={busy} onClick={actions.onStop}>Stop swarm</button>}
              {swarm.archivedAt ? (
                <button className="btn" disabled={busy} onClick={actions.onRestore}>Restore</button>
              ) : (
                canReopen(swarm.status) && (
                  <button className="btn" disabled={busy} onClick={actions.onArchive}>Archive</button>
                )
              )}
              <button className="btn" disabled={busy} onClick={actions.onSaveAsTemplate}>
                Save as template
              </button>
              {actions.onCreatePullRequest && <button className="btn" disabled={busy} onClick={actions.onCreatePullRequest}>Create PR</button>}
              <button className="btn btn-danger-quiet" disabled={busy} onClick={actions.onDelete}>
                Delete swarm
              </button>
            </div>
          </details>
        </div>

      </header>

      <section className="swarm-brief" aria-label="Swarm goal">
        <div className="swarm-brief-copy">
          <span className="label">Goal</span>
          <p>{swarm.goal}</p>
        </div>
        <div className="swarm-brief-side">
          {waitingForPlan && (
            <p className="swarm-next-step" role="status">
              {detail.plannerRun?.status === "failed"
                ? "Planner failed. Open its output below, then retry."
                : "Planner is building the task tree. Review the plan here before starting work."}
            </p>
          )}
          <div className="swarm-brief-metrics">
            <div className="swarm-spend-summary"><span>Spend estimate</span><strong className="spend-figure">{formatUsd(cappedUsd(swarm.spend))}</strong><small>{swarm.budgetUsd === null ? "No budget cap" : `${formatUsd(swarm.budgetUsd)} budget`}</small></div>
            <div className="swarm-worker-control"><span className="swarm-control-label">Workers</span><WorkerStepper workers={swarm.workers} active={swarm.workersActive} max={swarm.maxWorkers} disabledReason={busy ? "Wait for the current change to finish." : !canStop(swarm.status) ? "Worker count cannot change after the swarm ends." : null} onChange={actions.onWorkers} /></div>
          </div>
        </div>
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
 * A stepper rather than a field: the number is small, bounded by the
 * template, and changed by one more or one fewer far more often than
 * it is typed. What is already working is printed beside it, because
 * raising the ceiling while six workers are busy is a different
 * decision from raising it while none are.
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
