import { useEffect, useState } from "react";
import { CompletionRing } from "./CompletionRing.js";
import { OutOfCompute } from "./OutOfCompute.js";
import { SwarmOutline } from "./SwarmOutline.js";
import { SwarmTree } from "./SwarmTree.js";
import { canPause, canResume, canStop, swarmTone, swarmWords } from "../swarm/status.js";
import { capUse, formatUsd, spendParts } from "../swarm/money.js";
import { formatCompletion, type SwarmModel } from "../swarm/layout.js";
import { elapsedSince, formatElapsed } from "../swarm/time.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { SwarmDetail } from "../swarm/types.js";
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
 */
export function ComputeBanner({ surfaces }: { surfaces: ModeSurfaces }) {
  if (!surfaces.outOfComputeBanner) return null;
  return <OutOfCompute />;
}

export interface SwarmActions {
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCreatePullRequest: () => void;
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
}) {
  const swarm = detail.swarm;
  const live = canPause(swarm.status);
  const now = useNow(live);
  const elapsed = swarm.endedAt
    ? Math.max(0, new Date(swarm.endedAt).getTime() - new Date(swarm.startedAt ?? swarm.createdAt).getTime())
    : elapsedSince(swarm.startedAt ?? swarm.createdAt, now);
  const cap = capUse(swarm.spend, swarm.budgetUsd);

  return (
    <div className="swarm-page">
      <ComputeBanner surfaces={surfaces} />

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
          <button className="btn btn-primary" disabled={busy} onClick={actions.onCreatePullRequest}>
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
          {detail.pullRequests.map((pr) => (
            <a key={pr.id} className="chip chip-link" href={pr.url} target="_blank" rel="noreferrer">
              {pr.repoUrl} #{pr.number}
            </a>
          ))}
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
    </div>
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
