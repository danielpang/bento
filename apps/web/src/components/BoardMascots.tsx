import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_DOCK_ABOVE_ID } from "./Toasts.js";
import { sketchBubble, sketchGround, sketchMascot, type SketchFrame, type SketchedBubble, type SketchedMascot } from "../mascot-sketch.js";

/**
 * The orange square and the blue rectangle from the Bento mark, standing
 * in the bottom left of a quiet board and asking what comes next.
 *
 * Drawn the way the explainer videos draw them (mascot-sketch.ts): ink
 * outlines that wobble, hatched bodies, a scribbled ground, and lines
 * that boil a few times a second. They render into the toast dock, above
 * the stack, so a toast pushes them up instead of landing on top of
 * them; outside a toast host (a test) they render in place. Purely
 * decorative: hidden from assistive technology and from the pointer, so
 * a drag that crosses them still lands in the lane underneath.
 */
export function BoardMascots() {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => setDock(document.getElementById(TOAST_DOCK_ABOVE_ID)), []);
  const mascots = <Mascots />;
  return dock ? createPortal(mascots, dock) : mascots;
}

/* Computed once: the drawing never changes, only which frame shows. */
const ORANGE = sketchMascot("orange", 95, 140, 0.9, 1);
const BLUE = sketchMascot("blue", 213, 140, 0.9, 2);
const ASK = sketchBubble({ x: 2, y: 6, w: 234, h: 44 }, { x: 98, tipX: 100, tipY: 98 }, 3);
const ANSWER = sketchBubble({ x: 116, y: 56, w: 212, h: 44 }, { x: 215, tipX: 213, tipY: 120 }, 4);
const GROUND = sketchGround(20, 300, 194, 5);

function Frames({ frames, clip }: { frames: SketchFrame[]; clip?: string }) {
  return frames.map((frame, i) => (
    <g key={i} className="board-mascots-frame" data-frame={i}>
      {frame.hatch && <path className="board-mascot-hatch" d={frame.hatch} clipPath={clip ? `url(#${clip})` : undefined} />}
      {frame.ink.map((stroke, j) => <path key={j} className="board-mascots-ink" d={stroke.d} strokeWidth={stroke.width} />)}
    </g>
  ));
}

function Mascot({ m }: { m: SketchedMascot }) {
  const clip = `board-mascot-clip-${m.kind}`;
  return (
    <g className={`board-mascot board-mascot-${m.kind}`}>
      <clipPath id={clip}><path d={m.clip} /></clipPath>
      {m.limbFills.map((d, i) => <path key={i} className="board-mascot-fill" d={d} />)}
      <Frames frames={m.limbFrames} />
      <path className="board-mascot-fill" d={m.bodyFill} />
      <Frames frames={m.frames} clip={clip} />
      <g className="board-mascot-eyes">
        {m.eyes.map((e, i) => <ellipse key={i} cx={e.cx} cy={e.cy} rx="3" ry="5" />)}
      </g>
    </g>
  );
}

function Bubble({ b, text, side }: { b: SketchedBubble; text: string; side: "ask" | "answer" }) {
  return (
    <g className={`board-mascots-bubble board-mascots-bubble-${side}`}>
      <path className="board-mascots-paper" d={b.box} />
      <Frames frames={b.boxFrames} />
      <path className="board-mascots-paper" d={b.tail} />
      <Frames frames={b.tailFrames} />
      <text x={b.textX} y={b.textY}>{text}</text>
    </g>
  );
}

function Mascots() {
  return (
    <div className="board-mascots" aria-hidden="true">
      <svg viewBox="0 0 330 210" width="330" height="210" focusable="false">
        {GROUND.map((d, i) => <path key={i} className="board-mascots-frame board-mascots-ground" data-frame={i} d={d} />)}
        <Bubble b={ASK} text="What are we working on?" side="ask" />
        <Bubble b={ANSWER} text="What should we build?" side="answer" />
        <Mascot m={ORANGE} />
        <Mascot m={BLUE} />
      </svg>
    </div>
  );
}
