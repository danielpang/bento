import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AgentProfile, BentoClient, ProjectSession } from "@bento/api-client";
import { runDot, runTime, runWords } from "./AgentSession.js";
import { useToast } from "./Toasts.js";
import { SessionPageSkeleton, SessionsListSkeleton } from "./Skeleton.js";

// The same lazy chunk the /session route loads, so the split's right
// pane and the standalone tab stay one piece of code arriving once.
const SessionPage = lazy(() => import("./SessionPage.js").then((m) => ({ default: m.SessionPage })));

/**
 * The sessions tab: every conversation in the active project, one row
 * per card, newest activity first, shaped like a messaging app's
 * conversation list. Lives inside the board's chrome.
 *
 * On screens with room for two panes (a desktop window, an iPad) a row
 * opens the conversation beside the list, so switching sessions is one
 * click rather than a round trip through the back button. On a phone a
 * row navigates to the session's own page, which is also what the
 * drawer's expand button opens, so the chat itself stays one component.
 */
export function SessionsPage({
  client,
  projectId,
  profiles,
}: {
  client: BentoClient;
  projectId: string | null;
  profiles: AgentProfile[];
}) {
  const toast = useToast();
  const [sessions, setSessions] = useState<ProjectSession[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The conversation open beside the list, on screens wide enough for
   * two panes. Deliberately not in the address: a reload or a shared
   * link lands on the list alone, the first-load state, and the
   * full-page /session route stays what deep links open.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Bumped whenever the board stream below says something moved, and
   * handed to the open conversation so it can refetch off this one
   * subscription instead of opening a second one on the same project.
   */
  const [boardTick, setBoardTick] = useState(0);
  const screenRef = useRef<HTMLDivElement>(null);
  // Through a ref, because useToast without a ToastHost above it hands
  // back a fresh object per render, and that identity in refresh's
  // dependencies would turn the load effect into a fetch loop.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /**
   * The newest request wins. A slow response for the previously picked
   * project must not land on top of the current one's rows, so every
   * refresh takes a number and only the latest is allowed to write.
   */
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    // No project yet means still resolving, not "no sessions": leave
    // the list in its loading state rather than announcing an empty one.
    if (!projectId) return;
    const seq = ++requestSeq.current;
    try {
      const list = await client.listSessions(projectId);
      if (seq !== requestSeq.current) return;
      setSessions(list.sessions);
      setLoadFailed(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      toastRef.current.fail(err);
      setLoadFailed(true);
    }
  }, [client, projectId]);

  // A project switch starts the list over; stale rows from the old
  // project must not sit under the new project's name while it loads,
  // and neither may the old project's open conversation.
  useEffect(() => {
    setSessions(null);
    setLoadFailed(false);
    setSelectedId(null);
    void refresh();
  }, [refresh]);

  // Run state changes arrive on the project's board stream. run_output
  // is the agent's per-line chatter and moves nothing this list shows,
  // so it must not refetch; the board's own handler skips it for the
  // same reason. A reconnect means missed events are gone, so resync.
  useEffect(() => {
    if (!projectId) return;
    let timer: number | null = null;
    const schedule = () => {
      timer ??= window.setTimeout(() => {
        timer = null;
        void refresh();
        // The open conversation rides this too, so one stream serves
        // both panes. run_output is already filtered out below, which
        // means the pane also stops refetching on the agent's
        // per-line chatter the way it did on a stream of its own.
        setBoardTick((n) => n + 1);
      }, 250);
    };
    const stop = client.streamBoard(
      projectId,
      (event) => {
        if ((event as { type?: string }).type === "run_output") return;
        schedule();
      },
      schedule,
    );
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, projectId, refresh]);

  /**
   * Back closes the pane instead of leaving the tab.
   *
   * The address deliberately does not carry the selection, so without
   * an entry of its own Back went wherever the person was before
   * /sessions, losing the list and its scroll. Opening pushes one
   * entry; switching between conversations pushes none, because Back
   * should return to the list rather than walk everything visited on
   * the way there.
   */
  useEffect(() => {
    const onPop = () => setSelectedId(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openSession = (featureId: string) => {
    if (selectedId === null) window.history.pushState({ bentoSessionSplit: true }, "");
    setSelectedId(featureId);
  };

  const closeSession = () => {
    // Through history when history is what opened it, so the entry
    // leaves with the pane instead of outliving it.
    if ((window.history.state as { bentoSessionSplit?: boolean } | null)?.bentoSessionSplit) {
      window.history.back();
      return;
    }
    setSelectedId(null);
  };

  /**
   * Whether there is room for two panes, asked of CSS rather than
   * answered again here.
   *
   * styles.css sets --split on .sessions-screen and clears it in the
   * same media query that hides the list, so the breakpoint has one
   * home. A matchMedia copy of the number was the hand written
   * complement of the CSS one: retuning the layout in CSS alone left a
   * band of widths where a click opened a pane whose list CSS had
   * already hidden, and nothing in either file pointed at the other.
   */
  const splitFits = (): boolean => {
    const el = screenRef.current;
    if (!el) return false;
    return getComputedStyle(el).getPropertyValue("--split").trim() === "1";
  };

  // Only a first load with nothing to show becomes an error screen; a
  // failed background resync keeps the rows already on screen, because
  // a stale list beats an empty one with advice on it.
  if (loadFailed && sessions === null) {
    return (
      <div className="sessions-screen">
        <p className="error">Could not load sessions.</p>
        <p className="muted">Check that the server is reachable and that you are signed in.</p>
        <button className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="sessions-screen"
      data-split={selectedId !== null ? "" : undefined}
      ref={screenRef}
    >
      <div className="sessions-pane">
        <header className="surface-heading">
          <div>
            <h1>Sessions</h1>
            <p>Conversations behind the work.</p>
          </div>
          {sessions && <span className="surface-count">{sessions.length} conversations</span>}
        </header>
        {sessions === null && <SessionsListSkeleton />}
        {sessions?.length === 0 && (
          <div className="surface-empty">
            <h2>Your first conversation starts with a card.</h2>
            <p className="muted">Start an agent from the board. Its progress and conversation will appear here.</p>
            <a className="btn" href="/">Go to board</a>
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <div className="sessions-list">
            {sessions.map((session) => {
              const run = session.latestRun;
              const agent = profiles.find((p) => p.id === run.agentProfileId)?.name ?? "agent";
              return (
                <a
                  key={session.featureId}
                  className="session-card"
                  href={`/session/${session.featureId}`}
                  title="Open this conversation"
                  aria-current={selectedId === session.featureId ? "true" : undefined}
                  data-selected={selectedId === session.featureId ? "" : undefined}
                  onClick={(e) => {
                    // Modified clicks keep their browser meaning (new
                    // tab, new window); only a plain click is ours.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    // The split needs the width for two panes. A phone
                    // keeps the navigation the href already describes.
                    if (!splitFits()) return;
                    e.preventDefault();
                    openSession(session.featureId);
                  }}
                >
                  <span className="session-avatar" aria-hidden="true">
                    {initialsOf(agent)}
                  </span>
                  <span className="session-card-main">
                    <span className="session-card-top">
                      <span className="session-card-title">{session.title}</span>
                      <span className="session-card-time">{runTime(run.queuedAt)}</span>
                    </span>
                    <span className="session-card-sub">
                      <span className="dot" data-state={runDot(run.status)} />
                      <span className="session-card-status">
                        {agent} {runWords(run.status)}
                      </span>
                      <span
                        className="session-card-tail"
                        // The topbar's spend chip counts every run including
                        // the gate evaluator's judges, and several tools
                        // report no cost at all, so this figure is neither
                        // that one nor exact. Say so where it is shown.
                        title="This conversation's agent runs. Judge runs are not counted, and runs that report no cost are missing from the total, so it is a floor, not a total."
                      >
                        {session.runCount === 1 ? "1 run" : `${session.runCount} runs`}
                        {session.totalCostUsd !== null ? ` · $${session.totalCostUsd.toFixed(2)}` : ""}
                      </span>
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>
      {selectedId !== null && (
        // Keyed so switching conversations starts the pane fresh
        // instead of showing the previous card's messages while the
        // next one loads.
        <div className="sessions-detail" key={selectedId}>
          <Suspense fallback={<SessionPageSkeleton />}>
            <SessionPage
              client={client}
              featureId={selectedId}
              onClose={closeSession}
              refreshSignal={boardTick}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/** "Code Reviewer" wears CR, the way a chat list draws its contacts. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((word) => word[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "A"
  );
}
