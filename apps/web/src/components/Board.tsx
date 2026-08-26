import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentProfile, Feature, FeatureSpend, Stage } from "@bento/api-client";
import { ProviderMark } from "./ProviderMark.js";
import { formatCardSpend } from "./spend-format.js";

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
  /** Called when a card is dropped on the Done lane, from any stage. */
  onFinish: (featureId: string) => void;
  /** Opens the new-card dialog; the empty backlog offers it inline. */
  onNewCard: () => void;
  /** The drawer covers the right edge; the board makes room for it. */
  drawerOpen: boolean;
  /**
   * Per-card spend from the same usage payload the topbar chip reads.
   * Finished cards print the figure in their existing meta row.
   */
  spendByFeature?: Record<string, FeatureSpend>;
  /**
   * What the topbar's search field holds. Empty shows every card.
   *
   * The board filters rather than the caller, so the unfiltered list
   * stays the one every other part of the console counts, spends
   * against, and refetches on.
   */
  query?: string;
}

/** A card whose work is over: finished or abandoned, either way not moving. */
function isFinished(feature: Feature): boolean {
  return feature.status === "done" || feature.status === "cancelled";
}

/**
 * Whether a card answers a search.
 *
 * Both fields, because a ticket id is written wherever the person
 * pasting it happened to be: "ENG-441" as a title prefix on one card
 * and buried in the description of the next.
 *
 * Every whitespace-separated term has to land somewhere, so "auth
 * ENG-441" narrows rather than widens. Each term is tried twice: once
 * against the text as written, and once against the text with its
 * punctuation removed, which is what makes "eng441" and "eng 441" find
 * a card titled "ENG-441" instead of quietly returning nothing. A
 * search that misses the id someone read off a Linear tab is worse
 * than no search, because it reads as "that card does not exist".
 */
export function matchesQuery(feature: Pick<Feature, "title" | "description">, query: string): boolean {
  /*
   * A term carrying no letters or digits is dropped rather than
   * searched. It is punctuation left over from typing an id, and both
   * ways of honouring it are wrong: matched literally, a stray "-"
   * filters the board down to the cards whose titles happen to be
   * hyphenated; squashed to nothing, it matches everything, because
   * "" is a substring of every string. Neither is what somebody
   * halfway through typing ENG-441 meant.
   */
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => /[a-z0-9]/.test(term));
  if (terms.length === 0) return true;
  const text = `${feature.title} ${feature.description ?? ""}`.toLowerCase();
  const squashed = text.replace(/[^a-z0-9]+/g, "");
  return terms.every((term) => text.includes(term) || squashed.includes(term.replace(/[^a-z0-9]+/g, "")));
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
      if (stage?.gateType !== "auto") continue;
      // Past the last stage there is nowhere further to go, so what is
      // pending is the card finishing: the Done lane is the one about
      // to receive it.
      arriving.push(next ? next.id : DONE_LANE);
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

/**
 * The Done lane's key. Not a stage id: "done" is one step past the last
 * stage rather than a stage of its own, which is why the server records
 * it as a status and leaves the card's stage where it finished.
 */
const DONE_LANE = "done";

/* Which lane a card is in, written once. The delete's focus rule walks
   the same order the board draws, and two copies of these predicates
   would be two orders the moment one of them changed. */
const inBacklog = (feature: Feature) => !feature.currentStageId && !isFinished(feature);
const inLane = (feature: Feature, stageId: string) => feature.currentStageId === stageId && !isFinished(feature);

/**
 * Where focus goes when a card is deleted: the card that took its
 * place in the board's order, or the one before it when it was last.
 * Null means the board has no cards left, and the caller falls back to
 * the lane's own control.
 *
 * Modal restores focus to whatever opened the dialog, and after a
 * delete that button no longer exists, so without this a keyboard user
 * lands on <body> and loses their place on the board.
 */
export function neighbourCardId(features: Feature[], stages: Stage[], deletedId: string): string | null {
  const order = [
    ...features.filter(inBacklog),
    ...stages.flatMap((stage) => features.filter((f) => inLane(f, stage.id))),
    ...features.filter(isFinished),
  ].map((f) => f.id);
  const index = order.indexOf(deletedId);
  if (index < 0) return null;
  return order[index + 1] ?? order[index - 1] ?? null;
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
  onFinish,
  onNewCard,
  drawerOpen,
  spendByFeature = {},
  query = "",
}: BoardProps) {
  const searching = query.trim().length > 0;
  const shown = useMemo(
    () => (searching ? features.filter((f) => matchesQuery(f, query)) : features),
    [features, query, searching],
  );
  /**
   * Finished cards leave their stage lane for the Done lane.
   *
   * They keep the stage they finished in, because reopening one puts it
   * back there, but a shipped card sitting in Review alongside work
   * still being reviewed made the lane counts lie about the load: a
   * five-card Review lane where four were finished read as a queue.
   */
  const finished = shown.filter(isFinished);
  const backlog = shown.filter(inBacklog);
  /**
   * The lane a drag is hovering, so it can say it accepts the drop.
   * Board state rather than lane state: the highlight has to move OFF
   * a lane when the drag moves to the next one, and dragleave alone
   * fires unreliably when the pointer crosses child elements.
   */
  const [dropLane, setDropLane] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  /*
   * Re-measured whenever a card's lane could have changed, which
   * includes finishing: a card marked done leaves for the Done lane
   * without its stage changing, so the status has to be part of the key
   * or that one move is the only one that does not travel.
   */
  useCardTravel(
    boardRef,
    features.map((f) => `${f.id}:${f.currentStageId ?? ""}:${isFinished(f) ? "done" : ""}`).join(","),
  );
  const expecting = useExpectedArrivals(stages, features, runStatusByFeature);

  /**
   * A lane's drop behaviour. The lane's key and what a drop does are
   * separate arguments because the Done lane is not a stage: it takes
   * drops like any other lane, but what it calls is finishing rather
   * than moving.
   */
  const laneDropProps = (laneKey: string, drop: (featureId: string) => void) => ({
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
      if (featureId) drop(featureId);
    },
  });

  const card = (feature: Feature) => (
    <Card
      key={feature.id}
      feature={feature}
      state={cardState(feature, runStatusByFeature[feature.id])}
      runStatus={runStatusByFeature[feature.id]}
      lastOutput={lastOutputByFeature[feature.id]}
      pulse={pulses[feature.id]}
      spend={spendByFeature[feature.id]}
      selected={feature.id === selectedId}
      onSelect={onSelect}
    />
  );

  /* An empty lane means two different things, and saying the wrong one
     sends someone looking for a card that is simply filtered out. */
  const nothingFound = <p className="lane-empty">No matches</p>;

  return (
    <div className="board" ref={boardRef} data-drawer-open={drawerOpen || undefined}>
      <Lane
        name="Backlog"
        ordinal="00"
        count={backlog.length}
        empty={
          searching ? (
            nothingFound
          ) : (
            /* "Add your first card" to somebody who has made five and
               deleted one is a lie. It is true again on a board with
               nothing in any lane, which is a screen indistinguishable
               from a fresh install. */
            <button className="lane-cta" onClick={onNewCard}>
              {features.length === 0 ? "Add your first card" : "Add a card"}
            </button>
          )
        }
        {...laneDropProps("backlog", (featureId) => onMove(featureId, null))}
      >
        {backlog.map(card)}
      </Lane>

      {stages.map((stage, i) => {
        const inStage = shown.filter((f) => inLane(f, stage.id));
        const agent = profiles.find((p) => p.id === stage.defaultAgentProfileId);
        return (
          <Lane
            key={stage.id}
            name={stage.name}
            ordinal={String(i + 1).padStart(2, "0")}
            count={inStage.length}
            agent={agent}
            expecting={expecting.has(stage.id)}
            {...(searching ? { empty: nothingFound } : {})}
            {...laneDropProps(stage.id, (featureId) => onMove(featureId, stage.id))}
          >
            {inStage.map(card)}
          </Lane>
        );
      })}

      {/*
        Where the work ends up.

        It takes drops from any lane, because plenty of cards are
        finished before the pipeline says so and approving through four
        stages to record that was four decisions nobody was making. The
        card keeps the stage it was dropped from, so reopening it from
        the drawer puts it back there. Cards are not draggable out
        again: leaving is reopening, which is a decision with a
        consequence (the stage's verdicts are discarded) rather than a
        rearrangement.
      */}
      <Lane
        name="Completed"
        ordinal={String(stages.length + 1).padStart(2, "0")}
        count={finished.length}
        note="finished work"
        expecting={expecting.has(DONE_LANE)}
        empty={searching ? nothingFound : <p className="lane-empty">Nothing finished yet</p>}
        {...laneDropProps(DONE_LANE, onFinish)}
      >
        {finished.map(card)}
      </Lane>
    </div>
  );
}

function Lane({
  name,
  ordinal,
  count,
  agent,
  note,
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
  /** Said in the agent's place, for a lane no agent works. */
  note?: string;
  /** Shown in place of the default empty slot when the lane has no cards. */
  empty?: React.ReactNode;
  /** True while a card is being dragged over this lane. */
  over?: boolean;
  /** A run upstream just succeeded and this lane is next in line. */
  expecting?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
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
          // "no agent assigned" is a gap worth naming on a stage, which
          // is a lane an agent is meant to work. On the Done lane it
          // would be an instruction to fix something that is not broken.
          <span className="lane-agent lane-agent-empty">{note ?? "no agent assigned"}</span>
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
  runStatus,
  lastOutput,
  pulse,
  spend,
  selected,
  onSelect,
}: {
  feature: Feature;
  state: CardState;
  /** The newest run's status, which the card reads for itself. */
  runStatus: string | undefined;
  lastOutput: string | undefined;
  pulse: CardPulse | undefined;
  spend: FeatureSpend | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const finished = feature.status === "done" || feature.status === "cancelled";
  const spendLabel = finished ? formatCardSpend(spend) : null;
  const runActive = RUN_ACTIVE.has(runStatus ?? "");
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
    /*
     * The run's own outcome, not the card's state. A run that ends on a
     * card its gate is still holding leaves the card reading "gated",
     * and the sweep is a gesture about the run that just stopped.
     */
    if (runStatus !== "succeeded" && runStatus !== "failed") return;
    setFinishing(runStatus);
    const timer = setTimeout(() => setFinishing(null), 900);
    /*
     * The sweep is dropped here as well as on the timer, because a run
     * starting inside those 900ms cancels the timer and leaves nothing
     * to drop it: the card would wear data-finish from then on, and the
     * finish rule sits after the running one at equal weight and ends
     * at opacity 0, so the next agent would work behind a dead card.
     * The card an agent is working glows; the closing gesture gives way
     * to it.
     */
    return () => {
      clearTimeout(timer);
      setFinishing(null);
    };
  }, [runActive, runStatus]);

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
        {/* Spend sits with the PR chip in the existing meta row, not
            in a section of its own. Only a finished card prints it,
            and only when a CLI actually reported a figure. */}
        {(spendLabel || feature.prNumber) && (
          <span className="card-meta-end">
            {spendLabel && (
              <span
                className="card-spend"
                title={
                  spend && spend.runsWithoutCost > 0
                    ? "Some runs reported no cost, so this is a floor."
                    : undefined
                }
              >
                {spendLabel}
              </span>
            )}
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
          </span>
        )}
      </span>
      {/*
        The agent's own words while it works, and its last words when it
        fails, which is why the run ended where it did. Keyed on the run
        rather than the card state: a run that fails under a gate still
        holding the card leaves the card reading "gated", and the reason
        it failed is exactly what a person needs at that point. Hidden
        once everything settles: yesterday's sentence on an idle card
        reads as though something is still happening.
      */}
      {lastOutput && (runActive || runStatus === "failed") && (
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
  /*
   * An agent at work outranks the gate holding the card. A card sits at
   * "gated" for as long as its requirements are unmet, and plenty of
   * work happens in that time: an agent_judge gate starts its judge
   * while the card is gated, and re-running a held card (or sending it
   * a message) starts an agent without clearing the gate. The card
   * reported "waiting at gate" through all of it, with no halo, so a
   * live agent read as a card nobody was touching. The gate is not
   * forgotten: it comes back the moment the run stops.
   */
  if (RUN_ACTIVE.has(runStatus ?? "")) return "running";
  if (feature.status === "gated") return "gated";
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
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "not started";
  }
}
