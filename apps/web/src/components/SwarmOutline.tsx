import { CompletionBar } from "./CompletionRing.js";
import { formatCompletion, outlineRows, type SwarmModel } from "../swarm/layout.js";
import { attentionWords, isAttention, taskTone, taskWords } from "../swarm/status.js";
import { nodeSpendChip } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";

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
}: {
  model: SwarmModel;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const rows = outlineRows(model);
  if (rows.length === 0) {
    return (
      <div className="swarm-outline swarm-outline-empty">
        <p className="muted">The planner has not split this goal yet.</p>
      </div>
    );
  }
  return (
    <div className="swarm-outline">
      <ol className="swarm-rows">
        {rows.map((row) => {
          const attention = isAttention(row.attention);
          const spend = nodeSpendChip(row.cost);
          const note = attentionWords(row.attention);
          return (
            <li key={row.id}>
              <button
                type="button"
                className="swarm-row"
                // Indent is the tree, so the depth of a node is
                // readable without redrawing the edges.
                style={{ paddingLeft: `${8 + row.depth * 18}px` }}
                data-selected={row.id === selectedId ? "" : undefined}
                data-attention={attention ? "" : undefined}
                aria-pressed={row.id === selectedId}
                onClick={() => onSelect(row.id)}
              >
                <span className="swarm-row-title">{row.title}</span>
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
                  <span className="dot" data-state={taskTone(row.status)} />
                  {taskWords(row.status)}
                </span>
                {/* Attention is its own column, never folded into the
                    status: a worker running long is still working. */}
                <span className="swarm-row-attention">
                  {note ? (
                    <span className="chip swarm-attention-chip">
                      {note}
                      {row.attention === "long_running" ? ` ${formatElapsed(row.elapsedMs)}` : ""}
                    </span>
                  ) : null}
                </span>
                <span className="swarm-row-cost" title={spend.title}>
                  {spend.text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
