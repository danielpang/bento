import type { SwarmPlannerRun } from "../swarm/types.js";
import { elapsedSince, formatElapsed } from "../swarm/time.js";
import { plannerFailure } from "../swarm/failures.js";
import { AgentOrb } from "./AgentOrb.js";

const STATUS: Record<SwarmPlannerRun["status"], string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Planning",
  succeeded: "Plan written",
  failed: "Stopped",
  cancelled: "Stopped",
};

export function SwarmPlannerStep({
  run,
  now,
  busy,
  onRetry,
  onOpenOutput,
  canRetry,
  variant,
}: {
  run: SwarmPlannerRun;
  now: number;
  busy?: boolean;
  onRetry: () => void;
  onOpenOutput?: () => void;
  canRetry: boolean;
  variant: "tree" | "outline";
}) {
  const active = run.status === "queued" || run.status === "starting" || run.status === "running";
  const agent = run.agent;
  const failure = plannerFailure(run.error);
  return (
    <section className="swarm-planner-step" data-state={run.status} data-variant={variant} aria-label="Planner agent">
      <div className="swarm-planner-step-head">
        <span className="swarm-planner-step-kicker">Planner agent</span>
        <span className="status">
          {/* The orb while the agent is in its sandbox; a dot for every
              other state, including the wait for a run slot. */}
          {run.status === "running"
            ? <AgentOrb label="Planner working" />
            : <span className="dot" data-state={run.status === "failed" ? "failed" : active ? "running" : run.status === "cancelled" ? "idle" : "succeeded"} />}
          {run.status === "failed" ? failure.title : STATUS[run.status]}
        </span>
      </div>
      <div className="swarm-planner-step-main">
        <div>
          <h3>{agent?.name ?? "Planner"}</h3>
          <p>{agent ? `${agent.cli} · ${agent.model}` : "Preparing the plan"}</p>
        </div>
        {active && (
          <span className="swarm-planner-step-time">
            {run.status === "queued" ? "Waiting for a run slot" : formatElapsed(elapsedSince(run.startedAt ?? run.queuedAt, now))}
          </span>
        )}
      </div>
      {run.status === "failed" && <p className="swarm-planner-step-summary" role="status">{failure.summary}</p>}
      {onOpenOutput
        ? <button type="button" className="swarm-output-link" onClick={onOpenOutput}>{run.status === "failed" ? "Open details" : "Message planner"} <span aria-hidden="true">↗</span></button>
        : run.status === "failed" && canRetry && <button className="btn btn-primary" disabled={busy} onClick={onRetry}>Retry planner</button>}
    </section>
  );
}
