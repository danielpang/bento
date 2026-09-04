import { CompletionRing } from "./CompletionRing.js";
import { NODE_HEIGHT, NODE_WIDTH, visibleNodes, type SwarmModel, type SwarmNode } from "../swarm/layout.js";
import { attentionWords, isAttention, taskTone, taskWords } from "../swarm/status.js";
import { nodeSpendChip } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";

/**
 * The plan, drawn.
 *
 * Top down from the root, one card per node, bezier edges between a
 * parent and its children. Every position, every edge path, and every
 * number on every card comes from `layout.ts`: this file places what
 * that module worked out and adds no arithmetic of its own, which is
 * why the Outline can render the same figures and why the maths is
 * testable without a browser.
 *
 * Three things are readable at a glance and nothing else competes
 * with them: how far along a node is (the ring), whether anybody
 * needs to look at it (yellow), and what it has cost.
 *
 * Every title here was written by a planner agent. It renders as
 * text. Nothing in this tree interprets markup.
 */
export function SwarmTree({
  model,
  selectedId,
  onSelect,
  onToggle,
}: {
  model: SwarmModel;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  /** Opening a folded subtree by hand, and folding it away again. */
  onToggle: (taskId: string) => void;
}) {
  const nodes = visibleNodes(model);
  if (nodes.length === 0) {
    return (
      <div className="swarm-stage swarm-stage-empty">
        <p className="muted">The planner has not split this goal yet.</p>
      </div>
    );
  }

  // Room for the shadow and the focus ring at the edges of the stage.
  const pad = 24;
  return (
    <div className="swarm-stage">
      <div
        className="swarm-canvas"
        style={{ width: `${model.width + pad * 2}px`, height: `${model.height + pad * 2}px` }}
      >
        <svg
          className="swarm-edges"
          width={model.width + pad * 2}
          height={model.height + pad * 2}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`translate(${pad} ${pad})`}>
            {model.edges.map((edge) => (
              <path
                key={edge.id}
                d={edge.path}
                fill="none"
                className="swarm-edge"
                data-live={
                  model.byId.get(edge.childId)?.frontierPath ? "" : undefined
                }
              />
            ))}
          </g>
        </svg>
        {nodes.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            offset={pad}
            selected={node.id === selectedId}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  offset,
  selected,
  onSelect,
  onToggle,
}: {
  node: SwarmNode;
  offset: number;
  selected: boolean;
  onSelect: (taskId: string) => void;
  onToggle: (taskId: string) => void;
}) {
  const attention = isAttention(node.attention);
  const spend = nodeSpendChip(node.cost);
  const words = taskWords(node.status);
  const note = attentionWords(node.attention);
  return (
    <div
      className="swarm-node"
      style={{
        left: `${node.x + offset}px`,
        top: `${node.y + offset}px`,
        width: `${NODE_WIDTH}px`,
        height: `${NODE_HEIGHT}px`,
      }}
      data-kind={node.kind}
      data-state={taskTone(node.status)}
      data-attention={attention ? "" : undefined}
      data-collapsed={node.collapsed ? "" : undefined}
      data-selected={selected ? "" : undefined}
    >
      <button
        type="button"
        className="swarm-node-face"
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
        title={`${node.title}. ${words}${note ? `, ${note}` : ""}. ${spend.title}`}
      >
        <span className="swarm-node-head">
          <CompletionRing
            fraction={node.completion}
            size={node.kind === "plan" ? 18 : 15}
            stroke={2.5}
            tone={attention ? "muted" : "brand"}
          />
          <span className="swarm-node-title">{node.title}</span>
        </span>
        <span className="swarm-node-foot">
          <span className="status">
            <span className="dot" data-state={taskTone(node.status)} />
            {node.collapsed ? `${node.doneLeaves} done` : words}
          </span>
          <span className="swarm-node-cost" title={spend.title}>
            {spend.text}
          </span>
        </span>
        {/* The long run warning, and only then. A working leaf that is
            inside its window says nothing, because a timer on every
            card is a timer nobody reads. */}
        {attention && (
          <span className="swarm-node-flag">
            {note}
            {node.attention === "long_running" ? ` ${formatElapsed(node.elapsedMs)}` : ""}
          </span>
        )}
      </button>
      {node.childIds.length > 0 && (
        <button
          type="button"
          className="swarm-node-fold"
          onClick={() => onToggle(node.id)}
          aria-label={node.collapsed ? `Open ${node.title}` : `Fold ${node.title}`}
          title={node.collapsed ? "Open this subtree" : "Fold this subtree"}
        >
          {node.collapsed ? `+${node.totalLeaves}` : <FoldMark />}
        </button>
      )}
    </div>
  );
}

/**
 * The fold control when the subtree is open. Drawn rather than typed:
 * the obvious glyph for "collapse" is a dash, and this console does
 * not put dashes in front of people.
 */
function FoldMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 10.5 8 6.5l4 4" />
    </svg>
  );
}
