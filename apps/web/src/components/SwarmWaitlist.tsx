const DOWNLOAD_URL = "https://usebento.ai/download";

export type WaitlistState = "idle" | "sending" | "joined" | "failed";

/**
 * What the Swarms tab shows on hosted Bento to somebody PostHog has not
 * let in yet. Swarms there run on Bento's sandboxes; the Mac app runs
 * them on the person's own machine, so it never shows this.
 */
export function SwarmWaitlist({ state, onJoin }: { state: WaitlistState; onJoin: () => void }) {
  return (
    <div className="empty-state empty-project">
      <h1>Join the waitlist for Bento swarms.</h1>
      <p className="muted">
        Can't wait? You can{" "}
        <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
          run Bento swarms locally in Docker
        </a>
        .
      </p>
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
