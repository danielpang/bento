import { SketchMascot } from "./SketchMascot.js";
import { sketchMascot } from "../mascot-sketch.js";
import { SANDBOX_CAPACITY_TITLE } from "@bento/core";

const ORANGE = sketchMascot("orange", 70, 76, 0.8, 1, "sitting");
const BLUE = sketchMascot("blue", 178, 76, 0.8, 2, "sitting");

/** A recoverable service limit, shown in the work that could not start. */
export function CapacityNotice({ onRetry, busy = false, context = "run" }: {
  onRetry?: (() => void) | undefined;
  busy?: boolean | undefined;
  context?: "run" | "planner" | "worker";
}) {
  const explanation = context === "planner"
    ? "Your swarm is saved. The planner couldn't start because all available workspaces are busy."
    : context === "worker"
      ? "This worker couldn't start because all available workspaces are busy. Its task is saved and ready to retry."
      : "This agent couldn't start because all available workspaces are busy.";
  const retryLabel = context === "planner" ? "Retry planner" : context === "worker" ? "Retry worker" : "Try again";
  return (
    <section className="capacity-notice" role="status" aria-label="Bento is at capacity">
      <div className="capacity-notice-art" aria-hidden="true">
        <svg viewBox="0 0 260 132" width="260" height="132" focusable="false">
          <path className="board-mascots-ground" d="M20 117q42 4 88 0m15 1q54 4 112-1" />
          <g transform="rotate(-7 70 110)"><SketchMascot m={ORANGE} dizzy /></g>
          <g transform="rotate(6 178 110)"><SketchMascot m={BLUE} dizzy /></g>
          <g className="capacity-notice-stars">
            <path d="m43 14 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" />
            <path d="m112 18 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" />
            <path d="M58 20q22-12 40 0M108 38l5 3M31 41l5-3" />
            <path d="m155 30 2 5 5 2-5 2-2 5-2-5-5-2 5-2Zm58 3 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" />
            <path d="M166 35q18-10 35 0M230 53l4 3M138 52l-4 3" />
          </g>
        </svg>
      </div>
      <span className="capacity-notice-kicker">Making room for more</span>
      <h3>{SANDBOX_CAPACITY_TITLE}</h3>
      <p>{explanation}</p>
      <p className="capacity-notice-team">We're a small team, and we're working to add more capacity so everyone has room to build.</p>
      <div className="capacity-notice-footer">
        <p>Please try again in a few minutes.<br /><span>This attempt won't use your agent hours.</span></p>
        {onRetry && <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}>{busy ? "Trying again…" : retryLabel}</button>}
      </div>
    </section>
  );
}
