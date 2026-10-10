import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CompletionRing } from "./CompletionRing.js";
import { NODE_HEIGHT, NODE_WIDTH, visibleNodes, type SwarmModel, type SwarmNode } from "../swarm/layout.js";
import { diagramAttentionWords, diagramTaskTone, diagramTaskWords, isAttention } from "../swarm/status.js";
import { cappedUsd, formatUsd, hasReportedSpend } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";
import type { SwarmPlannerRun } from "../swarm/types.js";
import { SwarmPlannerStep } from "./SwarmPlannerStep.js";

type Viewport = { x: number; y: number; scale: number };

function zoomAt(view: Viewport, scale: number, x: number, y: number): Viewport {
  const next = Math.max(0.4, Math.min(2.4, scale));
  const ratio = next / view.scale;
  return {
    x: x - (x - view.x) * ratio,
    y: y - (y - view.y) * ratio,
    scale: next,
  };
}

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
  /** Opening a folded subtree by hand, and folding it away again. */
  onToggle: (taskId: string) => void;
  plannerRun?: SwarmPlannerRun | null;
  onRetryPlanner?: () => void;
  onOpenPlannerOutput?: () => void;
  busy?: boolean;
  now?: number;
  canRetryPlanner?: boolean;
}) {
  const nodes = visibleNodes(model);
  const pad = 24;
  const width = Math.max(model.width, 340);
  const shift = (width - model.width) / 2;
  const roots = nodes.filter((node) => node.parentId === null);
  const contentWidth = width + pad * 2;
  const stageRef = useRef<HTMLDivElement>(null);
  const autoCenter = useRef(true);
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 16, scale: 1 });
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // The diagram can widen after its first render. Keep the planner
    // centered until the person pans or zooms it by hand.
    const center = () => {
      if (!autoCenter.current || stage.clientWidth === 0) return;
      setView((current) => {
        const x = (stage.clientWidth - contentWidth * current.scale) / 2;
        return current.x === x ? current : { ...current, x };
      });
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [contentWidth]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      autoCenter.current = false;
      const rect = stage.getBoundingClientRect();
      setView((current) => zoomAt(
        current,
        current.scale * Math.exp(-event.deltaY * 0.001),
        event.clientX - rect.left,
        event.clientY - rect.top,
      ));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    autoCenter.current = false;
    setView((current) => zoomAt(current, current.scale * factor, stage.clientWidth / 2, stage.clientHeight / 2));
  };
  const resetView = () => {
    const stage = stageRef.current;
    if (!stage) return;
    autoCenter.current = true;
    setView({ x: (stage.clientWidth - contentWidth) / 2, y: 16, scale: 1 });
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, a")) return;
    autoCenter.current = false;
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: start.x + event.clientX - start.clientX,
      y: start.y + event.clientY - start.clientY,
    }));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={stageRef}
      className="swarm-stage"
      data-empty={nodes.length === 0 ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {nodes.length > 0 && <div className="swarm-edge-legend" aria-label="Diagram line meanings">
        <span className="swarm-edge-legend-item"><i className="swarm-edge-legend-line" aria-hidden="true" />Child task</span>
        <span className="swarm-edge-legend-item"><i className="swarm-edge-legend-line" data-live="" aria-hidden="true" />Active or needs attention</span>
        <span className="swarm-edge-legend-item"><i className="swarm-edge-legend-line" data-relation="depends_on" aria-hidden="true" />Depends on task above</span>
      </div>}
      {nodes.length > 0 && <div className="swarm-viewport-controls" role="group" aria-label="Tree view controls">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span aria-live="off">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        <button type="button" className="swarm-viewport-reset" onClick={resetView}>Reset view</button>
      </div>}
      <div className="swarm-tree-content" style={{ width: `${contentWidth}px`, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {plannerRun && (
          <>
            <div className="swarm-planner-tree-position">
              <SwarmPlannerStep run={plannerRun} now={now} busy={busy} onRetry={onRetryPlanner ?? (() => {})} onOpenOutput={onOpenPlannerOutput} canRetry={canRetryPlanner} variant="tree" />
            </div>
            {nodes.length > 0 && (
              <svg className="swarm-planner-edges" width={width + pad * 2} height="48" aria-hidden="true">
                {roots.map((root) => (
                  <path
                    key={root.id}
                    d={`M ${pad + width / 2} 0 C ${pad + width / 2} 24, ${pad + shift + root.x + NODE_WIDTH / 2} 24, ${pad + shift + root.x + NODE_WIDTH / 2} 48`}
                    className="swarm-edge"
                    fill="none"
                  />
                ))}
              </svg>
            )}
          </>
        )}
        {nodes.length === 0 ? (
          <p className="swarm-plan-pending">
            {plannerRun?.status === "failed" ? "The plan will appear here after the planner succeeds." : "The plan will appear here as the planner works."}
          </p>
        ) : (
        <div
          className="swarm-canvas"
          style={{ width: `${width + pad * 2}px`, height: `${model.height + pad * 2}px` }}
        >
        <svg
          className="swarm-edges"
          width={width + pad * 2}
          height={model.height + pad * 2}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`translate(${pad + shift} ${pad})`}>
            {model.edges.map((edge) => (
              <path
                key={edge.id}
                d={edge.path}
                fill="none"
                className="swarm-edge"
                data-relation={edge.relation}
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
            parentTitle={node.parentId ? model.byId.get(node.parentId)?.title : undefined}
            offsetX={pad + shift}
            offsetY={pad}
            selected={node.id === selectedId}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
        </div>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  parentTitle,
  offsetX,
  offsetY,
  selected,
  onSelect,
  onToggle,
}: {
  node: SwarmNode;
  parentTitle?: string;
  offsetX: number;
  offsetY: number;
  selected: boolean;
  onSelect: (taskId: string) => void;
  onToggle: (taskId: string) => void;
}) {
  const attention = isAttention(node.attention);
  const spend = hasReportedSpend(node.cost) ? formatUsd(cappedUsd(node.cost)) : null;
  const words = diagramTaskWords(node.status, node.nodeType, node.agentActive, node.landing);
  const note = diagramAttentionWords(node.status, node.nodeType, node.attention, node.agentActive);
  const tone = diagramTaskTone(node.status, node.nodeType, node.agentActive, node.landing);
  return (
    <div
      className="swarm-node"
      style={{
        left: `${node.x + offsetX}px`,
        top: `${node.y + offsetY}px`,
        width: `${NODE_WIDTH}px`,
        height: `${NODE_HEIGHT}px`,
      }}
      data-node-type={node.nodeType}
      data-state={tone}
      data-agent-active={node.agentActive ? "" : undefined}
      data-attention={attention ? "" : undefined}
      data-collapsed={node.collapsed ? "" : undefined}
      data-selected={selected ? "" : undefined}
      /* Everything a reopen asked for, marked as such, so the first
         pass and the follow ups are told apart at a glance rather
         than by reading the titles. */
      data-follow-up={node.followUp ? "" : undefined}
    >
      <button
        type="button"
        className="swarm-node-face"
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
        title={`${node.title}. ${node.parentRelation === "depends_on" && parentTitle ? `Depends on ${parentTitle}. ` : ""}${words}${note ? `, ${note}` : ""}${spend ? `. Spend estimate ${spend}` : "."}`}
      >
        <span className="swarm-node-head">
          <CompletionRing
            fraction={node.completion}
            size={node.nodeType === "plan" ? 18 : 15}
            stroke={2.5}
            tone={attention ? "muted" : "brand"}
          />
          <span className="swarm-node-title">{node.title}</span>
        </span>
        {/* The instruction, on the node the reopen made and nowhere
            else. Repeating it on every descendant would be the same
            sentence twenty times; the tint above is what says the rest
            of the subtree belongs to it. A person's own words, so it
            renders as text. */}
        {node.followUp?.rootId === node.id && (
          <span className="swarm-node-followup" title={node.followUp.instruction}>
            {node.followUp.instruction}
          </span>
        )}
        <span className="swarm-node-foot">
          <span className="status">
            <span className="dot" data-state={tone} />
            {node.collapsed && !node.frontierPath ? `${node.doneLeaves} done` : words}
          </span>
          {spend && (
            <span className="swarm-node-cost" title={`Spend estimate ${spend}`}>
              {spend}
            </span>
          )}
        </span>
        {/* The long run warning, and only then. A working leaf that is
            inside its window says nothing, because a timer on every
            card is a timer nobody reads. */}
        {attention && note && (
          <span className="swarm-node-flag">
            {note}
            {node.attention === "long_running" ? ` ${formatElapsed(node.runningForMs ?? node.elapsedMs)}` : ""}
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
