import { useEffect, useState } from "react";
import { CompletionRing } from "./CompletionRing.js";
import { MergeQueue } from "./MergeQueue.js";
import { OutOfCompute } from "./OutOfCompute.js";
import { SwarmOutline } from "./SwarmOutline.js";
import { SwarmTree } from "./SwarmTree.js";
import { SwarmCostPanel } from "./SwarmCostPanel.js";
import { canPause, canReopen, canResume, canStart, canStop, pausedWords, swarmTone, swarmWords } from "../swarm/status.js";
import { capUse, formatUsd, spendParts } from "../swarm/money.js";
import { formatCompletion, type SwarmModel } from "../swarm/layout.js";
import { elapsedSince, formatElapsed } from "../swarm/time.js";
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
  onStop: () => void;
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
  onWorkers: (workers: number) => void;
  onAnswer: (questionId: string, text: string) => void;
}

/**
 * One swarm's page: the header, and the plan under it.
 *
 * The header is the answer to "what is this doing and what is it
 * costing me", in that order: the ring is the headline, the spend
 * line is three figures rather than one, and the controls that can
 * change either sit at the end of the same row.
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
}) {
  const swarm = detail.swarm;
  const live = canPause(swarm.status);
  const now = useNow(live);
  const elapsed = swarm.endedAt
    ? Math.max(0, new Date(swarm.endedAt).getTime() - new Date(swarm.startedAt ?? swarm.createdAt).getTime())
    : elapsedSince(swarm.startedAt ?? swarm.createdAt, now);
  const cap = capUse(swarm.spend, swarm.budgetUsd);
  const stopped = pausedWords(swarm.status, swarm.pausedReason);

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
          <CompletionRing fraction={model.root.completion} size={44} stroke={4} showLabel />
          <div className="swarm-head-copy">
            <h1 className="swarm-name">{swarm.name}</h1>
            <div className="swarm-head-chips">
              <span className="status">
                <span className="dot" data-state={swarmTone(swarm.status)} />
                {swarmWords(swarm.status)}
              </span>
              {swarm.branchName && (
                <span className="chip chip-clip" title={swarm.branchName}>
                  {swarm.branchName}
                </span>
              )}
              <span className="chip" title="Since this swarm started">
                {formatElapsed(elapsed)}
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

        <div className="swarm-head-spend">
          <span className="label">Spend</span>
          {/*
           * Three figures, apart, always. A total would put a
           * measurement, an estimate and a guess behind one number,
           * next to a cap people set real limits with.
           */}
          <ul className="swarm-tiers swarm-tiers-inline">
            {spendParts(swarm.spend).map((part) => (
              <li key={part.tier} title={part.note}>
                <span className="swarm-tier-value spend-figure">{formatUsd(part.usd)}</span>
                <span className="swarm-tier-label">{part.label}</span>
              </li>
            ))}
          </ul>
          <div className="swarm-cap" title={cap.capLine}>
            <span className="swarm-cap-track">
              {cap.segments.map((segment) => (
                <span
                  key={segment.tier}
                  className="swarm-cap-fill"
                  data-tier={segment.tier}
                  style={{ width: `${segment.ratio * 100}%` }}
                />
              ))}
            </span>
            <span className="muted">{cap.capLine}</span>
          </div>
        </div>

        <div className="swarm-head-actions">
          <WorkerStepper
            workers={swarm.workers}
            active={swarm.workersActive}
            max={swarm.maxWorkers}
            disabled={busy || !canStop(swarm.status)}
            onChange={actions.onWorkers}
          />
          {/*
            * Start and Pause both, while a swarm is being planned: the
            * plan is the planner's to finish and the work is the
            * person's to begin, and either can be wanted first. Start
            * is the same route as Resume (one door decides when a
            * swarm may run), so it is the same action under the name
            * the state calls for.
            */}
          {canStart(swarm.status) && (
            <button className="btn btn-primary" disabled={busy} onClick={actions.onResume}>
              Start
            </button>
          )}
          {canResume(swarm.status) ? (
            <button className="btn" disabled={busy} onClick={actions.onResume}>
              Resume
            </button>
          ) : (
            <button className="btn" disabled={busy || !canPause(swarm.status)} onClick={actions.onPause}>
              Pause
            </button>
          )}
          <button className="btn" disabled={busy || !canStop(swarm.status)} onClick={actions.onStop}>
            Stop
          </button>
          {/*
            * Reopen, and only on a swarm that has finished. It sits
            * beside Stop rather than replacing it, for the reason
            * every other control here stays visible: a button that
            * disappears reads as a console that forgot the swarm.
            */}
          {canReopen(swarm.status) && (
            <button
              className="btn"
              disabled={busy}
              onClick={actions.onReopen}
              title="Add a follow up to this swarm, on the same branch and the same pull requests."
            >
              Reopen
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || !actions.onCreatePullRequest}
            title={
              actions.onCreatePullRequest
                ? undefined
                : "Opening a pull request from a swarm is not available yet. Its branch is in the repository, so it can be opened there."
            }
            onClick={actions.onCreatePullRequest}
          >
            Create PR
          </button>
        </div>
      </header>

      {swarm.question && (
        <PlannerQuestionBanner
          question={swarm.question}
          busy={busy}
          onAnswer={(text) => actions.onAnswer(swarm.question?.id ?? "", text)}
        />
      )}

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
        <span className="muted swarm-goal" title={swarm.goal}>
          {swarm.goal}
        </span>
      </div>

      {view === "tree" ? (
        <SwarmTree model={model} selectedId={selectedId} onSelect={onSelect} onToggle={onToggleNode} />
      ) : (
        <SwarmOutline model={model} selectedId={selectedId} onSelect={onSelect} />
      )}

      {/*
       * Under the plan rather than beside it. The tree is what a person
       * came for, and the queue is the answer to a question they only
       * ask once something has stopped moving: whose branch is in, and
       * what is holding the rest up. Drawn at all only once something
       * has been accepted, so a swarm that is still planning does not
       * carry an empty box it will never fill.
       */}
      {/*
       * The panel under the plan rather than in the header: the header
       * answers what this is costing, and this answers where it went,
       * which is a question somebody asks second and only sometimes.
       */}
      {/*
       * What the swarm produced for people to read, above the cost
       * panel: on a document swarm it is the whole point of the swarm,
       * and on a code swarm it is whatever its agents captured along
       * the way. Drawn only when there is something, so an ordinary
       * swarm carries no empty box.
       */}
      <SwarmArtifacts
        artifacts={artifacts}
        deliverable={swarm.deliverable}
        onOpen={onOpenArtifact}
      />

      <SwarmCostPanel spend={swarm.spend} tasks={detail.tasks} budgetUsd={swarm.budgetUsd} />

      {detail.landings.length > 0 && (
        <MergeQueue
          landings={detail.landings}
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
  const document = deliverable === "document" ? artifacts[0] : undefined;
  const rest = document ? artifacts.slice(1) : artifacts;

  return (
    <section className="swarm-artifacts">
      <span className="label">{deliverable === "document" ? "The document" : "What this swarm produced"}</span>
      {document && (
        <button
          type="button"
          className="swarm-artifact swarm-artifact-lead"
          disabled={!onOpen}
          onClick={() => onOpen?.(document)}
        >
          <span className="swarm-artifact-name">{document.path}</span>
          <span className="muted">
            Assembled from the sections in the plan, and committed on the swarm's branch.
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
  disabled,
  onChange,
}: {
  workers: number;
  active: number;
  max: number;
  disabled?: boolean;
  onChange: (workers: number) => void;
}) {
  return (
    <div className="swarm-workers" title={`${active} of ${workers} working, up to ${max} on this template`}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-label="One fewer worker"
        disabled={disabled || workers <= 1}
        onClick={() => onChange(workers - 1)}
      >
        <StepMark direction="down" />
      </button>
      <span className="swarm-workers-count">
        <span className="spend-figure">{active}</span>
        <span className="swarm-workers-of">of</span>
        <span className="spend-figure">{workers}</span>
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        aria-label="One more worker"
        disabled={disabled || workers >= max}
        onClick={() => onChange(workers + 1)}
      >
        <StepMark direction="up" />
      </button>
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
