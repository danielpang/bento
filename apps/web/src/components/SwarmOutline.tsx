import { CompletionBar } from "./CompletionRing.js";
import { formatCompletion, outlineRows, type SwarmModel } from "../swarm/layout.js";
import { diagramAttentionWords, diagramTaskTone, diagramTaskWords, isAttention } from "../swarm/status.js";
import { cappedUsd, formatUsd } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";
import type { SwarmPlannerRun } from "../swarm/types.js";
import { SwarmPlannerStep } from "./SwarmPlannerStep.js";

/**
 * The same plan, as a list.
 *
 * Tree order, indented by depth, one row each. Every figure comes
 * from the same model the tree drew, through `outlineRows`, so the
 * two views cannot disagree about a completion, a status, a cost, or
 * whether something is yellow: switching view changes the shape of
 * the page and nothing else.
 *
 * A folded subtree is still listed here. A list indents rather than
 * hides, and somebody who switched to the outline did so to see
 * everything at once.
 */
export function SwarmOutline({
  model,
  selectedId,
  onSelect,
  plannerRun,
  onRetryPlanner,
  onOpenPlannerOutput,
  busy,
  now = Date.now(),
  canRetryPlanner = false,
}: {
  model: SwarmModel;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  plannerRun?: SwarmPlannerRun | null;
  onRetryPlanner?: () => void;
  onOpenPlannerOutput?: () => void;
  busy?: boolean;
  now?: number;
  canRetryPlanner?: boolean;
}) {
  const rows = outlineRows(model);
  if (rows.length === 0 && !plannerRun) {
    return (
      <div className="swarm-outline swarm-outline-empty">
        <p className="muted">The planner has not split this goal yet.</p>
      </div>
    );
  }
  return (
    <div className="swarm-outline" data-empty={rows.length === 0 ? "" : undefined}>
      <ol className="swarm-rows">
        {plannerRun && (
          <li className="swarm-planner-outline-row">
            <SwarmPlannerStep run={plannerRun} now={now} busy={busy} onRetry={onRetryPlanner ?? (() => {})} onOpenOutput={onOpenPlannerOutput} canRetry={canRetryPlanner} variant="outline" />
          </li>
        )}
        {rows.length === 0 && (
          <li className="swarm-plan-pending">
            {plannerRun?.status === "failed" ? "The plan will appear here after the planner succeeds." : "The plan will appear here as the planner works."}
          </li>
        )}
        {rows.map((row) => {
          const attention = isAttention(row.attention);
          const spend = formatUsd(cappedUsd(row.cost));
          const note = diagramAttentionWords(row.status, row.nodeType, row.attention, row.agentActive);
          return (
            <li key={row.id}>
              <button
                type="button"
                className="swarm-row"
                // Each level keeps its own gutter for the child arrow.
                style={{ paddingLeft: `${12 + row.depth * 24}px` }}
                data-relation={row.parentRelation}
                data-selected={row.id === selectedId ? "" : undefined}
                data-agent-active={row.agentActive ? "" : undefined}
                data-attention={attention ? "" : undefined}
                /* The same mark the tree puts on a follow up, so
                   switching view changes the shape of the page and
                   nothing about what it says. */
                data-follow-up={row.followUp ? "" : undefined}
                aria-pressed={row.id === selectedId}
                onClick={() => onSelect(row.id)}
              >
                <span className="swarm-row-title">
                  {row.depth > 0 && <span className="swarm-row-arrow" aria-hidden="true">↳</span>}
                  {row.title}
                  {row.parentRelation === "depends_on" && <span className="swarm-row-dependency">after parent</span>}
                  {/* On the node the reopen made, in its own words,
                      and not repeated down the subtree. */}
                  {row.followUp?.rootId === row.id && (
                    <span className="swarm-row-followup" title={row.followUp.instruction}>
                      {row.followUp.instruction}
                    </span>
                  )}
                </span>
                <span className="swarm-row-bar">
                  <CompletionBar
                    fraction={row.completion}
                    title={
                      row.rolled
                        ? `${formatCompletion(row.completion)} done, ${row.doneLeaves} of ${row.totalLeaves} tasks`
                        : `${formatCompletion(row.completion)} done`
                    }
                  />
                </span>
                <span className="swarm-row-pct">{formatCompletion(row.completion)}</span>
                <span className="status swarm-row-status">
                  <span className="dot" data-state={diagramTaskTone(row.status, row.nodeType, row.agentActive)} />
                  {diagramTaskWords(row.status, row.nodeType, row.agentActive)}
                </span>
                {/* Attention is its own column, never folded into the
                    status: a worker running long is still working. */}
                <span className="swarm-row-attention">
                  {note ? (
                    <span className="chip swarm-attention-chip">
                      {note}
                      {row.attention === "long_running" ? ` ${formatElapsed(row.runningForMs ?? row.elapsedMs)}` : ""}
                    </span>
                  ) : null}
                </span>
                <span className="swarm-row-cost" title={`Spend estimate ${spend}`}>
                  {spend}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
