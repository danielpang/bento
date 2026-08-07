import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentProfile, Feature, Stage } from "@bento/api-client";
import { ProviderMark } from "./ProviderMark.js";

/** Read once: a page is not re-rendered when the setting changes. */
const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Moves every card that changed position to where it used to be, then
 * lets it travel back.
 *
 * A card that advances a stage was previously removed from one lane and
 * mounted in another, which reads as a teleport: the thing this board
 * exists to show, work moving through a pipeline, was the one thing it
 * did not show. React has already committed the new layout by the time
 * this runs, so the card is put back with a transform and animated to
 * none, which costs no layout at any point.
 *
 * Positions are measured against the board's own content, not the
 * viewport, or scrolling a lane between renders would read as every
 * card in it having moved.
 */
function useCardTravel(board: React.RefObject<HTMLDivElement | null>, deps: unknown) {
  const previous = useRef(new Map<string, { x: number; y: number }>());

  useLayoutEffect(() => {
    const root = board.current;
    if (!root) return;
    const boardBox = root.getBoundingClientRect();
    const now = new Map<string, { x: number; y: number }>();

    for (const el of root.querySelectorAll<HTMLElement>("[data-feature]")) {
      const id = el.dataset.feature!;
      const box = el.getBoundingClientRect();
      const laneScroll = el.closest<HTMLElement>(".lane-cards")?.scrollTop ?? 0;
      const at = {
        x: box.left - boardBox.left + root.scrollLeft,
        y: box.top - boardBox.top + laneScroll,
      };
      now.set(id, at);

      const was = previous.current.get(id);
      if (!was || REDUCED_MOTION) continue;
      const dx = was.x - at.x;
      const dy = was.y - at.y;
      // Sub-pixel drift is not a move, and animating it would make the
      // board twitch on every unrelated re-render.
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) continue;

      // The mount fade would otherwise play on top of the travel.
      el.style.animation = "none";
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      ).finished.finally(() => {
        el.style.animation = "";
      });
    }

    previous.current = now;
  }, [board, deps]);
}

/**
 * Layout position rather than rendered position. offsetLeft and
 * offsetTop ignore transforms, and the travel animation starts a moved
 * card back at its old lane, so getBoundingClientRect would reveal
 * where the card used to be instead of where it is.
 */
function layoutOffset(el: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/** How much of the board's right edge the open drawer covers. */
function drawerReserve(board: HTMLElement): number {
  if (!board.hasAttribute("data-drawer-open")) return 0;
  // The CSS declares it; older WebKit has returned the unresolved
  // calc() for a computed scroll-padding, and right after the
  // attribute lands the recalc has not happened yet, so the docked
  // panel itself is the cross-check.
  const declared = parseFloat(getComputedStyle(board).scrollPaddingRight);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const drawer = document.querySelector<HTMLElement>(".drawer");
  if (drawer) {
    const box = drawer.getBoundingClientRect();
    // Docked on the right only: on small screens it is a bottom sheet,
    // which covers nothing horizontally.
    return box.top === 0 ? box.width + 24 : 0;
  }
  // The panel's code is still arriving: fall back to the rule the CSS
  // declares for the side-panel layout rather than read a style that
  // has not settled.
  return window.innerWidth > 720 ? Math.min(560, window.innerWidth) + 24 : 0;
}

/** Time constant of the reveal's approach. */
const REVEAL_EASE_MS = 55;
/** The drawer's runway padding can lag the attribute that asks for it
    (and the drawer chunk can lag further), so the reveal retries for a
    short while rather than trusting the first layout it reads. */
const REVEAL_GIVE_UP_MS = 800;

/** Latest reveal per card wins, so a retarget never fights itself. */
const revealRuns = new WeakMap<HTMLElement, number>();

/** Move a scroll position a fraction of the way to its target.
    Returns true once there is nothing left to do. */
function approach(scroller: HTMLElement, prop: "scrollLeft" | "scrollTop", target: number, step: number): boolean {
  const gap = target - scroller[prop];
  if (Math.abs(gap) < 0.5) return true;
  const next = step === 1 ? target : scroller[prop] + gap * step;
  scroller[prop] = Math.abs(target - next) < 0.5 ? target : next;
  return false;
}

/**
 * Bring a freshly selected card out from under the drawer.
 *
 * No one-shot variant of this survives contact with the engines:
 * scrollIntoView ignores the board's scroll-padding in WebKit, smooth
 * scrollBy is not applied to overflow containers on the iPad at all,
 * and the drawer's runway padding reaches layout a beat after the
 * attribute that asks for it, so an early scroll clamps to nothing.
 * Instead the target is recomputed from live layout and the scroll
 * rewritten every frame until it holds, which each engine gets right.
 */
function revealCard(card: HTMLElement) {
  const run = (revealRuns.get(card) ?? 0) + 1;
  revealRuns.set(card, run);
  const t0 = performance.now();

  const board = card.closest<HTMLElement>(".board");
  // A gesture means the person has taken over the scroll; stop driving.
  const yieldToGesture = () => revealRuns.set(card, run + 1);
  board?.addEventListener("wheel", yieldToGesture, { passive: true, once: true });
  board?.addEventListener("touchstart", yieldToGesture, { passive: true, once: true });

  let prev = t0;
  const tick = (now: number) => {
    if (revealRuns.get(card) !== run) return;
    const step = REDUCED_MOTION ? 1 : 1 - Math.exp(-(now - prev) / REVEAL_EASE_MS);
    prev = now;
    let settled = true;

    // Sideways: the board is the only horizontal scroller.
    if (board) {
      const reserve = drawerReserve(board);
      const cardX = layoutOffset(card).x - layoutOffset(board).x;
      const visible = board.clientWidth - reserve;
      let target = board.scrollLeft;
      if (cardX + card.offsetWidth - target > visible) target = cardX + card.offsetWidth - visible;
      else if (cardX - target < 0) target = cardX;
      target = Math.max(0, Math.min(target, board.scrollWidth - board.clientWidth));
      settled = approach(board, "scrollLeft", target, step) && settled;
    }

    // Up and down: each lane scrolls its own cards; the page itself
    // does not scroll.
    const laneCards = card.closest<HTMLElement>(".lane-cards");
    if (laneCards) {
      const cardY = layoutOffset(card).y - layoutOffset(laneCards).y;
      let target = laneCards.scrollTop;
      if (cardY + card.offsetHeight - target > laneCards.clientHeight)
        target = cardY + card.offsetHeight - laneCards.clientHeight;
      else if (cardY - target < 0) target = cardY;
      target = Math.max(0, Math.min(target, laneCards.scrollHeight - laneCards.clientHeight));
      settled = approach(laneCards, "scrollTop", target, step) && settled;
    }

    if (!settled && now - t0 < REVEAL_GIVE_UP_MS) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The visual state a card reports: its run, or its gate if it is held. */
export type CardState = "idle" | "running" | "succeeded" | "failed" | "gated" | "done" | "cancelled";

export interface CardPulse {
  /** Recent event kinds, oldest first. */
  ticks: string[];
}

interface BoardProps {
  stages: Stage[];
  features: Feature[];
  profiles: AgentProfile[];
  runStatusByFeature: Record<string, string | undefined>;
  /** The agent's latest spoken line per card, while it runs. */
  lastOutputByFeature: Record<string, string | undefined>;
  pulses: Record<string, CardPulse | undefined>;
  selectedId: string | null;
  onSelect: (featureId: string) => void;
  /** Called when a card is dropped on a lane. Null means the backlog. */
  onMove: (featureId: string, stageId: string | null) => void;
  /** Opens the new-card dialog; the empty backlog offers it inline. */
  onNewCard: () => void;
  /** The drawer covers the right edge; the board makes room for it. */
  drawerOpen: boolean;
}

/**
 * Which lane is about to receive something.
 *
 * A run finishing on an automatic stage queues the evaluation that
 * moves the card, so for a moment the board knows where to look before
 * there is anything to see. The next lane's header breathes in the gate
 * hue, which is the honest colour: the requirements have not passed
 * yet, and if they fail the card stays put and the cue simply fades.
 */
function useExpectedArrivals(
  stages: Stage[],
  features: Feature[],
  runStatusByFeature: Record<string, string | undefined>,
): Set<string> {
  const [expecting, setExpecting] = useState<Set<string>>(new Set());
  const seen = useRef(new Map<string, string | undefined>());

  useEffect(() => {
    if (REDUCED_MOTION) return;
    const arriving: string[] = [];
    for (const feature of features) {
      const status = runStatusByFeature[feature.id];
      const before = seen.current.get(feature.id);
      seen.current.set(feature.id, status);
      if (before === status || status !== "succeeded") continue;
      const index = stages.findIndex((s) => s.id === feature.currentStageId);
      const stage = stages[index];
      const next = stages[index + 1];
      if (stage?.gateType === "auto" && next) arriving.push(next.id);
    }
    if (arriving.length === 0) return;
    setExpecting((current) => new Set([...current, ...arriving]));
    const timer = setTimeout(
      () => setExpecting((current) => new Set([...current].filter((id) => !arriving.includes(id)))),
      1400,
    );
    return () => clearTimeout(timer);
  }, [stages, features, runStatusByFeature]);

  return expecting;
}

export function Board({
  stages,
  features,
  profiles,
  runStatusByFeature,
  lastOutputByFeature,
  pulses,
  selectedId,
  onSelect,
  onMove,
  onNewCard,
  drawerOpen,
}: BoardProps) {
  const backlog = features.filter((f) => !f.currentStageId);
  /**
   * The lane a drag is hovering, so it can say it accepts the drop.
   * Board state rather than lane state: the highlight has to move OFF
   * a lane when the drag moves to the next one, and dragleave alone
   * fires unreliably when the pointer crosses child elements.
   */
  const [dropLane, setDropLane] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // Re-measured whenever a card's lane could have changed.
  useCardTravel(boardRef, features.map((f) => `${f.id}:${f.currentStageId ?? ""}`).join(","));
  const expecting = useExpectedArrivals(stages, features, runStatusByFeature);

  const laneDropProps = (laneKey: string, stageId: string | null) => ({
    over: dropLane === laneKey,
    onDragOver: (e: React.DragEvent) => {
      // Only card drags are welcome; without this the browser refuses
      // the drop and animates the card flying back.
      if (!e.dataTransfer.types.includes("application/x-bento-feature")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropLane(laneKey);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Ignore leave events fired by moving over the lane's children.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropLane((current) => (current === laneKey ? null : current));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropLane(null);
      const featureId = e.dataTransfer.getData("application/x-bento-feature");
      if (featureId) onMove(featureId, stageId);
    },
  });

  return (
    <div className="board" ref={boardRef} data-drawer-open={drawerOpen || undefined}>
      <Lane
        name="Backlog"
        ordinal="00"
        count={backlog.length}
        empty={
          <button className="lane-cta" onClick={onNewCard}>
            Add your first card
          </button>
        }
        {...laneDropProps("backlog", null)}
      >
        {backlog.map((feature) => (
          <Card
            key={feature.id}
            feature={feature}
            state={cardState(feature, runStatusByFeature[feature.id])}
            runActive={RUN_ACTIVE.has(runStatusByFeature[feature.id] ?? "")}
            lastOutput={lastOutputByFeature[feature.id]}
            pulse={pulses[feature.id]}
            selected={feature.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </Lane>

      {stages.map((stage, i) => {
        const inStage = features.filter((f) => f.currentStageId === stage.id);
        const agent = profiles.find((p) => p.id === stage.defaultAgentProfileId);
        return (
          <Lane
            key={stage.id}
            name={stage.name}
            ordinal={String(i + 1).padStart(2, "0")}
            count={inStage.length}
            agent={agent}
            expecting={expecting.has(stage.id)}
            {...laneDropProps(stage.id, stage.id)}
          >
            {inStage.map((feature) => (
              <Card
                key={feature.id}
                feature={feature}
                state={cardState(feature, runStatusByFeature[feature.id])}
                runActive={RUN_ACTIVE.has(runStatusByFeature[feature.id] ?? "")}
                lastOutput={lastOutputByFeature[feature.id]}
                pulse={pulses[feature.id]}
                selected={feature.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </Lane>
        );
      })}
    </div>
  );
}

function Lane({
  name,
  ordinal,
  count,
  agent,
  empty,
  over,
  expecting,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  name: string;
  /** The stage's position in the pipeline; the backlog is 00. */
  ordinal: string;
  count: number;
  agent?: AgentProfile | undefined;
  /** Shown in place of the default empty slot when the lane has no cards. */
  empty?: React.ReactNode;
  over: boolean;
  /** A run upstream just succeeded and this lane is next in line. */
  expecting?: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="lane"
      data-drop={over || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="lane-head" data-expecting={expecting || undefined}>
        <div className="lane-title">
          <span className="lane-title-text" title={name}>
            <span className="lane-ord">{ordinal}</span>
            <span className="lane-name">{name}</span>
          </span>
          <span className="lane-count">{count}</span>
        </div>
        {agent ? (
          // The agent's own name, the way the pipeline editor names it.
          // The tool is what it runs on, not what it is called, and a
          // lane reading "claude-code" beside a stage card reading
          // "Senior Product Manager" made them look unrelated.
          <span className="lane-agent" title={`${agent.cli} · ${agent.model}`}>
            <ProviderMark cli={agent.cli} model={agent.model} decorative />
            <span className="lane-agent-name">{agent.name}</span>
          </span>
        ) : (
          <span className="lane-agent lane-agent-empty">no agent assigned</span>
        )}
      </header>
      <div className="lane-cards">
        {count === 0 && (empty ?? <p className="lane-empty">No cards</p>)}
        {children}
      </div>
    </section>
  );
}

/**
 * Memoized: a pulse tick on one card re-renders that card alone, not
 * every card on the board. Live boards emit several events a second.
 */
/** Run statuses with an agent actively at work. */
const RUN_ACTIVE = new Set(["queued", "starting", "running"]);

const Card = memo(function Card({
  feature,
  state,
  runActive,
  lastOutput,
  pulse,
  selected,
  onSelect,
}: {
  feature: Feature;
  state: CardState;
  runActive: boolean;
  lastOutput: string | undefined;
  pulse: CardPulse | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const finished = feature.status === "done" || feature.status === "cancelled";
  const self = useRef<HTMLButtonElement>(null);
  // A card in a right lane opens under the drawer; bring it out.
  useEffect(() => {
    if (selected && self.current) revealCard(self.current);
  }, [selected]);

  /*
   * The moment the agent stops.
   *
   * The running halo used to simply cease, so the effect that says
   * "working" had no counterpart saying "done". Held for as long as the
   * closing sweep runs, then dropped: this is a gesture about a moment,
   * not a state the card should keep wearing.
   */
  const [finishing, setFinishing] = useState<"succeeded" | "failed" | null>(null);
  const wasActive = useRef(runActive);
  useEffect(() => {
    const stopped = wasActive.current && !runActive;
    wasActive.current = runActive;
    if (!stopped || REDUCED_MOTION) return;
    if (state !== "succeeded" && state !== "failed") return;
    setFinishing(state);
    const timer = setTimeout(() => setFinishing(null), 900);
    return () => clearTimeout(timer);
  }, [runActive, state]);

  return (
    <button
      ref={self}
      className="card"
      data-feature={feature.id}
      data-state={state}
      data-finish={finishing ?? undefined}
      aria-pressed={selected}
      onClick={() => onSelect(feature.id)}
      /*
       * Cards drag between lanes. A finished card does not: the server
       * refuses to move one until it is reopened, so offering the drag
       * would end in a refusal toast rather than a move.
       */
      draggable={!finished}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-bento-feature", feature.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="card-title">{feature.title}</span>
      <span className="card-meta">
        <span className="status">
          <span className="dot" data-state={state} />
          {stateLabel(state)}
        </span>
        {/* A pull request is worth reaching, not just counting. The
            number alone left people with an identifier and no route to
            it once the run's notes scrolled away. */}
        {feature.prNumber &&
          (feature.prUrl ? (
            <a
              className="chip chip-link"
              href={feature.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              PR #{feature.prNumber}
            </a>
          ) : (
            <span className="chip">PR #{feature.prNumber}</span>
          ))}
        {/* Said rather than merely enforced: the card simply refusing to
            lift reads as a broken drag. */}
        {finished && <span className="muted">reopen to move</span>}
      </span>
      {/*
        The agent's own words while it works, and its last words when it
        fails, which is the reason the card went red. Keyed on the run
        rather than the card state: a gated card can be re-run, and its
        gate outranks "running" in the colour scheme, which must not
        also silence the narration. Hidden once everything settles:
        yesterday's sentence on an idle card reads as though something
        is still happening.
      */}
      {lastOutput && (runActive || state === "failed") && (
        <span className="card-line" title={lastOutput}>
          {lastOutput}
        </span>
      )}
      <Pulse pulse={pulse} />
    </button>
  );
});

/**
 * One tick per recent agent event. A card that is "running" but emitting
 * nothing looks different from one actively working, which is the thing
 * a status label alone cannot tell you.
 */
function Pulse({ pulse }: { pulse: CardPulse | undefined }) {
  // Ticks only accumulate while this page is open, so their absence
  // means "quiet now", not "nothing has ever happened". A card that
  // finished five runs yesterday was claiming "no activity yet".
  if (!pulse || pulse.ticks.length === 0) return null;
  // Keys track each tick's position in the full history, so an arriving
  // tick mounts (and animates) alone instead of re-keying the row.
  const start = Math.max(0, pulse.ticks.length - 28);
  return (
    <span className="pulse" aria-hidden="true">
      {pulse.ticks.slice(-28).map((kind, i) => (
        <span key={start + i} className="pulse-tick" data-kind={kind} />
      ))}
    </span>
  );
}

export function cardState(feature: Feature, runStatus: string | undefined): CardState {
  // A card's own status outranks its last run: work that is over is over,
  // and reporting a shipped card by the run that finished it made "done"
  // and "never started" the same word.
  if (feature.status === "done") return "done";
  if (feature.status === "cancelled") return "cancelled";
  if (feature.status === "gated") return "gated";
  if (runStatus === "running" || runStatus === "starting" || runStatus === "queued") return "running";
  if (runStatus === "succeeded") return "succeeded";
  if (runStatus === "failed") return "failed";
  return "idle";
}

function stateLabel(state: CardState): string {
  switch (state) {
    case "running":
      return "agent working";
    case "succeeded":
      return "agent finished";
    case "failed":
      return "agent failed";
    case "gated":
      return "waiting at gate";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "not started";
  }
}
