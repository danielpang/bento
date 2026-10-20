import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_DOCK_ABOVE_ID } from "./Toasts.js";

/**
 * The orange square and the blue rectangle from the Bento mark, standing
 * in the bottom left of a quiet board and asking what comes next.
 *
 * The same two characters as the explainer videos. They render into the
 * toast dock, above the stack, so a toast pushes them up instead of
 * landing on top of them; outside a toast host (a test) they render in
 * place. Purely decorative: hidden from assistive technology and from
 * the pointer, so a drag that crosses them still lands in the lane
 * underneath. The bubbles are paper and ink in both themes, the way a
 * comic's are, rather than following the panel colours.
 */
export function BoardMascots() {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => setDock(document.getElementById(TOAST_DOCK_ABOVE_ID)), []);
  const mascots = <Mascots />;
  return dock ? createPortal(mascots, dock) : mascots;
}

function Mascots() {
  return (
    <div className="board-mascots" aria-hidden="true">
      <svg viewBox="0 0 330 210" width="330" height="210" focusable="false">
        <path className="board-mascots-ground" d="M18 199 Q90 196 150 199 T300 198" />

        <g className="board-mascots-bubble board-mascots-bubble-orange">
          <rect x="2" y="6" width="234" height="44" rx="20" />
          <path d="M88 48 L108 48 L100 100 Z" />
          <path className="board-mascots-bubble-seam" d="M90 49 L106 49" />
          <text x="119" y="34">What are we working on?</text>
        </g>
        <g className="board-mascots-bubble board-mascots-bubble-blue">
          <rect x="116" y="56" width="212" height="44" rx="20" />
          <path d="M206 98 L224 98 L214 126 Z" />
          <path className="board-mascots-bubble-seam" d="M208 99 L222 99" />
          <text x="222" y="84">What should we build?</text>
        </g>

        <g className="board-mascot board-mascot-orange">
          <rect className="board-mascot-limb" x="75" y="180" width="11" height="18" rx="5" />
          <rect className="board-mascot-limb" x="104" y="180" width="11" height="18" rx="5" />
          <rect className="board-mascot-limb" x="46" y="140" width="10" height="17" rx="4" />
          <rect className="board-mascot-limb" x="134" y="140" width="10" height="17" rx="4" />
          <rect className="board-mascot-body" x="55" y="104" width="80" height="80" rx="17" />
          <g className="board-mascot-eyes">
            <ellipse cx="82" cy="146" rx="3.2" ry="5.2" />
            <ellipse cx="108" cy="146" rx="3.2" ry="5.2" />
          </g>
        </g>
        <g className="board-mascot board-mascot-blue">
          <rect className="board-mascot-limb" x="180" y="180" width="11" height="18" rx="5" />
          <rect className="board-mascot-limb" x="236" y="180" width="11" height="18" rx="5" />
          <rect className="board-mascot-limb" x="149" y="150" width="10" height="17" rx="4" />
          <rect className="board-mascot-limb" x="268" y="150" width="10" height="17" rx="4" />
          <rect className="board-mascot-body" x="157" y="128" width="113" height="58" rx="15" />
          <g className="board-mascot-eyes">
            <ellipse cx="195" cy="157" rx="3.2" ry="5.2" />
            <ellipse cx="231" cy="157" rx="3.2" ry="5.2" />
          </g>
        </g>
      </svg>
    </div>
  );
}
