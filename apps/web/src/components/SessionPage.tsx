import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@bento/api-client";
import type { AgentProfile, AgentRun, BentoClient, Feature, FeatureChanges, Stage } from "@bento/api-client";
import { AgentSession } from "./AgentSession.js";
import { ChatSkeleton } from "./Skeleton.js";
import { DiffReview, type LineQuote } from "./DiffReview.js";
import { useToast } from "./Toasts.js";

/**
 * A card's agent conversation in its own tab, for when the drawer's
 * pane is too small a window on the work. Same component as the
 * drawer's session, with room to breathe. The sessions tab's split
 * view seats this same page in its right pane.
 */
export function SessionPage({
  client,
  featureId,
  onClose,
  refreshSignal,
}: {
  client: BentoClient;
  featureId: string;
  /**
   * Present when the page is a pane inside the sessions split rather
   * than a tab of its own: closing hands control back to the list
   * without a navigation, so the list keeps its scroll and its rows.
   */
  onClose?: () => void;
  /**
   * Bumped by a parent that already holds this project's board stream.
   * Its presence is what says "do not open a second one": in the split
   * the list and this pane were both subscribed to the same project,
   * which is two connections and two refetch storms for one viewer,
   * the pair the board itself dropped for the same reason.
   */
  refreshSignal?: number;
}) {
  const toast = useToast();
  const [feature, setFeature] = useState<(Feature & { runs: AgentRun[] }) | null>(null);
  /** Whether the load failed, so the page says so instead of sitting blank. */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The card is gone rather than unreachable. Its own state, because
   * "check that the server is reachable" sends somebody to check a
   * connection that is fine, and this tab is often the last thing left
   * open on a card deleted from the board behind it.
   */
  const [deleted, setDeleted] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
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
      // After the feature, not alongside it: the pipeline is keyed by
      // project, which is only known once the card has loaded. Absent
      // stages degrade the run picker's labels, not the page.
      const pipeline = await client.getPipeline(detail.projectId).catch(() => null);
      setFeature(detail);
      setProfiles(profileRows);
      setChanges(committed);
      setStages(pipeline?.stages ?? []);
      setLoadFailed(false);
    } catch (err) {
      // A 404 is the card being gone, or never this tenant's; the
      // server answers both the same way on purpose, and so does this.
      if (err instanceof ApiError && err.status === 404) {
        setDeleted(true);
        return;
      }
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
  // Only when nobody above is already listening, or the split would
  // hold two streams on one project for one viewer.
  useEffect(() => {
    if (refreshSignal !== undefined) return;
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
  }, [client, feature?.projectId, refresh, refreshSignal]);

  // The parent's stream, relayed. The value it starts on is the one
  // the load above already answered, so only changes to it refetch.
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined) return;
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    void refresh();
  }, [refreshSignal, refresh]);

  /**
   * The way out, which every state needs including the ones that never
   * loaded. The two branches below used to return above the header, so
   * a card that failed to load left the split pane with no Close; on a
   * narrow window, where the list is hidden behind that pane, it took
   * the whole tab with it and only a reload got out.
   */
  const exit = onClose ? (
    <button type="button" className="btn btn-ghost" onClick={onClose}>
      Close
    </button>
  ) : (
    <a className="btn btn-ghost" href="/sessions">
      Back
    </a>
  );

  if (deleted) {
    return (
      <div className="session-page">
        <header className="session-head">
          <h1>Conversation</h1>
          {exit}
        </header>
        <p className="error">This card was deleted.</p>
        <p className="muted">It is no longer on the board, and its transcript went with it.</p>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="session-page">
        <header className="session-head">
          <h1>Conversation</h1>
          {exit}
        </header>
        <p className="error">Could not load this card.</p>
        <p className="muted">Check that the server is reachable and that you are signed in.</p>
        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setLoadFailed(false);
              void refresh();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!feature) {
    return (
      <div className="session-page" aria-busy="true">
        <header className="session-head">
          <h1>Conversation</h1>
          {exit}
        </header>
        <ChatSkeleton tall />
      </div>
    );
  }

  const finished = feature.status === "done" || feature.status === "cancelled";
  const hasDiff = !!changes && changes.repositories.some((r) => r.diff.trim().length > 0);

  return (
    <div className={hasDiff ? "session-page session-page-review" : "session-page"}>
      <header className="session-head">
        <h1 title={feature.title}>{feature.title}</h1>
        <span className="chip" data-status={feature.status}>
          {feature.status === "done" ? "completed" : feature.status}
        </span>
        {exit}
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
            <DiffReview
              changes={changes}
              // The chip and composer live in the conversation pane, so
              // on one column a quote must also bring that pane back;
              // otherwise the tap lands in a pane CSS has hidden.
              onQuote={(q) => {
                setQuote(q);
                setPane("chat");
              }}
            />
          </div>
        )}
        <AgentSession
          client={client}
          featureId={feature.id}
          runs={feature.runs}
          profiles={profiles}
          stages={stages}
          finished={finished}
          onChanged={() => void refresh()}
          quote={quote}
          onQuoteClear={() => setQuote(null)}
        />
      </div>
    </div>
  );
}
