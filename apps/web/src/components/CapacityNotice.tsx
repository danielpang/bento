import { SANDBOX_CAPACITY_TITLE } from "@bento/core";

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
        <span /><span /><span /><span /><span /><span className="capacity-notice-new">+</span>
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
