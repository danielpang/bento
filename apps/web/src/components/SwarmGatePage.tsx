import { BILLING_HREF } from "../swarm/plan.js";

const DOWNLOAD_URL = "https://usebento.ai/download";

export type WaitlistState = "idle" | "sending" | "joined" | "failed";

function RunLocally({ lead }: { lead: string }) {
  return (
    <p className="muted">
      {lead}{" "}
      <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
        run Bento swarms locally in Docker
      </a>
      .
    </p>
  );
}

/**
 * What the Swarms tab shows on hosted Bento to somebody PostHog has not
 * let in yet. Swarms there run on Bento's sandboxes; the Mac app runs
 * them on the person's own machine, so it never shows this.
 */
export function SwarmWaitlist({ state, onJoin }: { state: WaitlistState; onJoin: () => void }) {
  return (
    <div className="empty-state empty-project">
      <h1>Join the waitlist for Bento swarms.</h1>
      <RunLocally lead="Can't wait? You can" />
      {state === "joined" ? (
        <p role="status">Added to waitlist, in the meantime you can still run Bento swarms locally.</p>
      ) : (
        <button className="btn btn-primary" onClick={onJoin} disabled={state === "sending"}>
          Join waitlist
        </button>
      )}
      {state === "failed" && <p role="alert">Could not join the waitlist. Try again.</p>}
    </div>
  );
}

/** A team whose plan does not include swarms. */
export function SwarmSubscribe({ canUpgrade }: { canUpgrade: boolean }) {
  return (
    <div className="empty-state empty-project">
      <h1>Bento swarms require a subscription.</h1>
      <p className="muted">
        {canUpgrade
          ? "Upgrade this team's plan to start swarms."
          : "Ask an owner or admin of this team to upgrade its plan."}
      </p>
      <RunLocally lead="In the meantime, you can" />
      {canUpgrade && (
        <a className="btn btn-primary" href={BILLING_HREF}>
          See plans
        </a>
      )}
    </div>
  );
}

/** The flags never answered, so access could not be checked. */
export function SwarmUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty-state empty-project">
      <h1>Could not check access to Bento swarms.</h1>
      <button className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
