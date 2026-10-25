import { useId } from "react";
import type { SketchFrame, SketchedMascot } from "../mascot-sketch.js";

export function SketchFrames({ frames, clip }: { frames: SketchFrame[]; clip?: string }) {
  return frames.map((frame, i) => (
    <g key={i} className="board-mascots-frame" data-frame={i}>
      {frame.hatch && <path className="board-mascot-hatch" d={frame.hatch} clipPath={clip ? `url(#${clip})` : undefined} />}
      {frame.ink.map((stroke, j) => <path key={j} className="board-mascots-ink" d={stroke.d} strokeWidth={stroke.width} />)}
    </g>
  ));
}

export function SketchMascot({ m, dizzy = false }: { m: SketchedMascot; dizzy?: boolean }) {
  const clip = useId();
  return (
    <g className={`board-mascot board-mascot-${m.kind}`}>
      <clipPath id={clip}><path d={m.clip} /></clipPath>
      {m.limbFills.map((d, i) => <path key={i} className="board-mascot-fill" d={d} />)}
      <SketchFrames frames={m.limbFrames} />
      <path className="board-mascot-fill" d={m.bodyFill} />
      <SketchFrames frames={m.frames} clip={clip} />
      <g className="board-mascot-eyes">
        {m.eyes.map((e, i) => dizzy
          ? <path key={i} transform={`translate(${e.cx} ${e.cy})`} d="M-4-4 4 4M4-4-4 4" fill="none" stroke="#2a1d15" strokeWidth="2.5" strokeLinecap="round" />
          : <ellipse key={i} cx={e.cx} cy={e.cy} rx="3" ry="5" />)}
      </g>
    </g>
  );
}

