import { SketchMascot } from "./SketchMascot.js";
import { sketchMascot } from "../mascot-sketch.js";
import { SANDBOX_CAPACITY_TITLE } from "@bento/core";

const MASCOT = sketchMascot("orange", 80, 76, 0.8, 1);

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
        <svg viewBox="0 0 160 132" width="160" height="132" focusable="false">
          <g transform="rotate(-8 80 110)"><SketchMascot m={MASCOT} dizzy /></g>
          <g className="capacity-notice-stars">
            <path d="m43 14 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" />
            <path d="m112 18 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" />
            <path d="M58 20q22-12 40 0M108 38l5 3M31 41l5-3" />
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
