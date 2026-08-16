import { useCallback, useEffect, useState } from "react";
import type { AgentProfile, AgentRun, BentoClient, Feature, FeatureChanges } from "@bento/api-client";
import { AgentSession } from "./AgentSession.js";
import { DiffReview, type LineQuote } from "./DiffReview.js";
import { useToast } from "./Toasts.js";

/**
 * A card's agent conversation in its own tab, for when the drawer's
 * pane is too small a window on the work. Same component as the
 * drawer's session, with room to breathe.
 */
export function SessionPage({ client, featureId }: { client: BentoClient; featureId: string }) {
  const toast = useToast();
  const [feature, setFeature] = useState<(Feature & { runs: AgentRun[] }) | null>(null);
  /** Whether the load failed, so the page says so instead of sitting blank. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [changes, setChanges] = useState<FeatureChanges | null>(null);
  const [quote, setQuote] = useState<LineQuote | null>(null);
  /** Which pane a one-column screen shows; side by side ignores it. */
  const [pane, setPane] = useState<"chat" | "changes">("chat");

  const refresh = useCallback(async () => {
    try {
      const [detail, profileRows, committed] = await Promise.all([
        client.getFeature(featureId),
        client.listProfiles(),
        client.getChanges(featureId).catch(() => null),
      ]);
      setFeature(detail);
      setProfiles(profileRows);
      setChanges(committed);
      setLoadFailed(false);
    } catch (err) {
      // Both: the toast carries what went wrong, and the flag keeps the
      // page from rendering as a blank screen that explains nothing.
      toast.fail(err);
      setLoadFailed(true);
    }
  }, [client, featureId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Run state changes arrive on the project's board stream, which is
  // what keeps the run list and the stop button honest in this tab too.
  // A reconnect means events fired while the stream was down are gone
  // (they are not persisted), so resync instead of trusting the gap.
  useEffect(() => {
    if (!feature?.projectId) return;
    let timer: number | null = null;
    const schedule = () => {
      timer ??= window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 250);
    };
    const stop = client.streamBoard(feature.projectId, schedule, schedule);
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, feature?.projectId, refresh]);

  if (loadFailed) {
    return (
      <div className="session-page">
        <p className="error">Could not load this card.</p>
        <p className="muted">
          Check that the server is reachable and that you are signed in, then reload.
        </p>
      </div>
    );
  }
  if (!feature) return <div className="center" />;

  const finished = feature.status === "done" || feature.status === "cancelled";
  const hasDiff = !!changes && changes.repositories.some((r) => r.diff.trim().length > 0);

  return (
    <div className={hasDiff ? "session-page session-page-review" : "session-page"}>
      <header className="session-head">
        <h1 title={feature.title}>{feature.title}</h1>
        <span className="chip" data-status={feature.status}>
          {feature.status}
        </span>
        <a className="btn btn-ghost" href="/">
          Back to the board
        </a>
      </header>
      {hasDiff && (
        <div className="pane-toggle" role="group" aria-label="Pane">
          <button type="button" aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>
            Conversation
          </button>
          <button type="button" aria-pressed={pane === "changes"} onClick={() => setPane("changes")}>
            Changes
          </button>
        </div>
      )}
      {/*
        With committed changes this page reads like a pull request:
        the diff on the left, the agent on the right, and any line can
        be quoted straight into the conversation. On one column the
        toggle above picks which of the two is on screen.
      */}
      <div className={hasDiff ? "session-body review-grid" : "session-body"} data-pane={hasDiff ? pane : undefined}>
        {hasDiff && changes && (
          <div className="review-diff">
            <span className="label">Changes</span>
            <DiffReview changes={changes} onQuote={setQuote} />
          </div>
        )}
        <AgentSession
          client={client}
          featureId={feature.id}
          runs={feature.runs}
          profiles={profiles}
          finished={finished}
          onChanged={() => void refresh()}
          quote={quote}
          onQuoteClear={() => setQuote(null)}
        />
      </div>
    </div>
  );
}
