import { SketchFrames, SketchMascot } from "./SketchMascot.js";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_DOCK_ABOVE_ID } from "./Toasts.js";
import { sketchBubble, sketchGround, sketchMascot, type SketchedBubble } from "../mascot-sketch.js";

/**
 * The orange square and the blue rectangle from the Bento mark, standing
 * in the bottom left of a quiet board and asking what comes next.
 *
 * Drawn the way the explainer videos draw them (mascot-sketch.ts): ink
 * outlines that wobble, hatched bodies, a scribbled ground, and lines
 * that boil a few times a second. They render into the toast dock, above
 * the stack, so a toast pushes them up instead of landing on top of
 * them; outside a toast host (a test) they render in place.
 *
 * They ask what to build, so clicking them answers: it opens the new
 * card dialog. Hovering shows a circled x that puts them away, which
 * the caller remembers on the person's account. While a card is being
 * dragged they let the pointer through, so a drop aimed at the lane
 * underneath still lands there.
 */
export function BoardMascots({ onNewCard, onDismiss }: { onNewCard: () => void; onDismiss: () => void }) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const dragging = useDocumentDrag();
  useEffect(() => setDock(document.getElementById(TOAST_DOCK_ABOVE_ID)), []);
  const mascots = <Mascots onNewCard={onNewCard} onDismiss={onDismiss} dragging={dragging} />;
  return dock ? createPortal(mascots, dock) : mascots;
}

/** True between a drag starting anywhere on the page and it ending. */
function useDocumentDrag(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = () => setDragging(true);
    const end = () => setDragging(false);
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  return dragging;
}

/* Computed once: the drawing never changes, only which frame shows. */
const ORANGE = sketchMascot("orange", 95, 140, 0.9, 1);
const BLUE = sketchMascot("blue", 213, 140, 0.9, 2);
const ASK = sketchBubble({ x: 2, y: 6, w: 234, h: 44 }, { x: 98, tipX: 100, tipY: 98 }, 3);
const ANSWER = sketchBubble({ x: 116, y: 56, w: 212, h: 44 }, { x: 215, tipX: 213, tipY: 120 }, 4);
const GROUND = sketchGround(20, 300, 194, 5);

function Bubble({ b, text, side }: { b: SketchedBubble; text: string; side: "ask" | "answer" }) {
  return (
    <g className={`board-mascots-bubble board-mascots-bubble-${side}`}>
      <path className="board-mascots-paper" d={b.box} />
      <SketchFrames frames={b.boxFrames} />
      <path className="board-mascots-paper" d={b.tail} />
      <SketchFrames frames={b.tailFrames} />
      <text x={b.textX} y={b.textY}>{text}</text>
    </g>
  );
}

function Mascots({ onNewCard, onDismiss, dragging }: { onNewCard: () => void; onDismiss: () => void; dragging: boolean }) {
  return (
    <div className="board-mascots" data-dragging={dragging || undefined}>
      <button type="button" className="board-mascots-art" onClick={onNewCard} aria-label="New card" title="New card">
        <svg viewBox="0 0 330 210" width="330" height="210" focusable="false" aria-hidden="true">
          {GROUND.map((d, i) => <path key={i} className="board-mascots-frame board-mascots-ground" data-frame={i} d={d} />)}
          <Bubble b={ASK} text="What are we working on?" side="ask" />
          <Bubble b={ANSWER} text="What should we build?" side="answer" />
          <SketchMascot m={ORANGE} />
          <SketchMascot m={BLUE} />
        </svg>
      </button>
      <button type="button" className="board-mascots-dismiss" onClick={onDismiss} aria-label="Hide the mascots" title="Hide the mascots">
        <svg viewBox="0 0 24 24" width="24" height="24" focusable="false" aria-hidden="true">
          <circle cx="12" cy="12" r="10.5" />
          <path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" />
        </svg>
      </button>
    </div>
  );
}
