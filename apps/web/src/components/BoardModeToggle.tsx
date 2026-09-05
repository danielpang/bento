import { useState } from "react";
import { BetaOnly } from "../beta.js";
import { Modal } from "./Modal.js";
import { BILLING_HREF, type SwarmAccess } from "../swarm/plan.js";
import type { BoardMode } from "../swarm/view-state.js";

/**
 * Which board of this project you are looking at.
 *
 * Beside the project picker rather than in the nav row, because the
 * project and the board are one question asked in two halves: pick
 * the project once, then say whether you want its pipeline or its
 * swarms. Two segments, no menu, because there are two answers and a
 * menu would hide one of them behind a click.
 *
 * Pipeline is the default and stays the default. Somebody who has
 * never opened a swarm sees the board they have always seen, with one
 * more word beside it.
 */
export function BoardModeToggle({
  mode,
  access,
  onSelect,
  hrefFor,
}: {
  mode: BoardMode;
  access: SwarmAccess;
  onSelect: (mode: BoardMode) => void;
  /** The address each segment points at, so the choice is in the URL. */
  hrefFor?: (mode: BoardMode) => string;
}) {
  const [prompt, setPrompt] = useState(false);
  if (!access.show) return null;

  return (
    <BetaOnly>
      <div className="seg" role="group" aria-label="Board">
        <Segment
          id="pipeline"
          label="Pipeline"
          mode={mode}
          onSelect={onSelect}
          hrefFor={hrefFor}
        />
        <Segment
          id="swarms"
          label="Swarms"
          mode={mode}
          locked={!access.included}
          onSelect={access.included ? onSelect : () => setPrompt(true)}
          hrefFor={access.included ? hrefFor : undefined}
        />
      </div>

      {prompt && access.prompt && (
        <Modal
          title="Swarms are not on this plan"
          description={access.prompt}
          onClose={() => setPrompt(false)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setPrompt(false)}>
                Not now
              </button>
              <a className="btn btn-primary" href={BILLING_HREF}>
                See plans
              </a>
            </>
          }
        >
          <p className="muted">
            A swarm takes one goal, splits it into a tree of tasks, and works them in parallel. The
            pipeline board is unaffected either way.
          </p>
        </Modal>
      )}
    </BetaOnly>
  );
}

function Segment({
  id,
  label,
  mode,
  locked,
  onSelect,
  hrefFor,
}: {
  id: BoardMode;
  label: string;
  mode: BoardMode;
  locked?: boolean;
  onSelect: (mode: BoardMode) => void;
  hrefFor?: (mode: BoardMode) => string;
}) {
  const current = mode === id;
  const href = hrefFor?.(id);
  /*
   * An anchor when there is an address to give it, so the choice can
   * be copied, opened in a second tab, and returned to by the back
   * button. The click is still handled here: navigation in this
   * console is a full page load, and the board does not need one to
   * change which slab it draws.
   */
  if (href) {
    return (
      <a
        className="seg-item"
        href={href}
        aria-current={current ? "page" : undefined}
        data-on={current ? "" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onSelect(id);
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <button
      className="seg-item"
      type="button"
      aria-current={current ? "page" : undefined}
      data-on={current ? "" : undefined}
      data-locked={locked ? "" : undefined}
      onClick={() => onSelect(id)}
    >
      {label}
      {locked && (
        <span className="seg-lock" aria-hidden="true" title="Not on this plan">
          <LockMark />
        </span>
      )}
    </button>
  );
}

/** A padlock at label size. Decorative: the prompt behind it says the rest. */
function LockMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.25" y="7" width="9.5" height="7" rx="1.6" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
