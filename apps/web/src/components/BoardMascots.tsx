/**
 * The orange square and the blue rectangle from the Bento mark, standing
 * in the bottom right of a quiet board and asking what comes next.
 *
 * The same two characters as the explainer videos. Purely decorative:
 * hidden from assistive technology and from the pointer, so a drag that
 * crosses them still lands in the lane underneath. The bubbles are
 * drawn as paper with dark ink in both themes, the way a comic's are,
 * rather than following the panel colours.
 */
export function BoardMascots() {
  return (
    <div className="board-mascots" aria-hidden="true">
      <svg viewBox="0 0 300 210" width="300" height="210" focusable="false">
        <path className="board-mascots-ground" d="M18 199 Q90 196 150 199 T286 198" />

        <g className="board-mascots-bubble board-mascots-bubble-orange">
          <rect x="4" y="8" width="176" height="40" rx="18" />
          <path d="M74 46 L94 46 L90 94 Z" />
          <path className="board-mascots-bubble-seam" d="M76 47 L92 47" />
          <text x="92" y="33">What are we working on?</text>
        </g>
        <g className="board-mascots-bubble board-mascots-bubble-blue">
          <rect x="124" y="58" width="168" height="40" rx="18" />
          <path d="M196 96 L216 96 L210 124 Z" />
          <path className="board-mascots-bubble-seam" d="M198 97 L214 97" />
          <text x="208" y="83">What should we build?</text>
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
