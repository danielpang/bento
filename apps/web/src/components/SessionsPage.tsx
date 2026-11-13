import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { AgentProfile, BentoClient, ProjectSession } from "@bento/api-client";
import { MODEL_GUIDANCE } from "@bento/core";
import { runDot, runTime, runWords } from "./AgentSession.js";
import { useToast } from "./Toasts.js";
import { SessionPageSkeleton, SessionsListSkeleton } from "./Skeleton.js";
import { SessionComposer } from "./SessionComposer.js";
import {
  SESSIONS_LIST_DEFAULT,
  SESSIONS_LIST_MAX,
  SESSIONS_LIST_MIN,
  SESSIONS_LIST_STEP,
  clampListWidth,
  saveListWidth,
  savedListWidth,
} from "../sessions-split.js";

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
  /**
   * The composer for a new session, open in the pane where a
   * conversation would be. Exclusive with `selectedId`: the pane shows
   * one or the other.
   */
  const [composing, setComposing] = useState(false);
  /** The list's width beside an open pane, which the person drags. */
  const [listWidth, setListWidth] = useState(savedListWidth);
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
    const onPop = () => {
      setSelectedId(null);
      setComposing(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const paneOpen = selectedId !== null || composing;

  const openSession = (featureId: string) => {
    if (!paneOpen) window.history.pushState({ bentoSessionSplit: true }, "");
    setComposing(false);
    setSelectedId(featureId);
  };

  /** The composer takes the pane, on a phone as on a desktop: it is a page of its own there. */
  const openComposer = () => {
    if (!paneOpen) window.history.pushState({ bentoSessionSplit: true }, "");
    setSelectedId(null);
    setComposing(true);
  };

  const closePane = () => {
    // Through history when history is what opened it, so the entry
    // leaves with the pane instead of outliving it.
    if ((window.history.state as { bentoSessionSplit?: boolean } | null)?.bentoSessionSplit) {
      window.history.back();
      return;
    }
    setSelectedId(null);
    setComposing(false);
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

  /**
   * A session the composer just started: shown at once, in the pane the
   * composer held where there is room, and on its own page where there
   * is not, the same choice a click on its row makes. Replacing rather
   * than adding the page, so Back from it skips the spent composer.
   */
  const sessionStarted = (featureId: string) => {
    void refresh();
    if (!splitFits()) {
      window.location.replace(`/session/${featureId}`);
      return;
    }
    if (paneOpen) {
      setComposing(false);
      setSelectedId(featureId);
    } else {
      openSession(featureId);
    }
  };

  /** The agent behind the newest session, which the composer starts on. */
  const newest = sessions?.[0]?.latestRun;
  const recentProfile =
    newest?.agentCli && newest.agentModel
      ? { cli: newest.agentCli, model: newest.agentModel }
      : profiles.find((p) => p.id === newest?.agentProfileId);

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

  /*
   * No conversations yet: the composer is the screen, the way the
   * Swarms tab opens on its own, so the first thing a person sees is
   * the thing they came to do.
   */
  if (sessions?.length === 0 && projectId && selectedId === null) {
    return (
      <div className="sessions-screen sessions-screen-compose" ref={screenRef}>
        <SessionComposer
          client={client}
          projectId={projectId}
          onStarted={sessionStarted}
          footer={
            <>
              Or start an agent from a card on the <a href="/">board</a>.
            </>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="sessions-screen"
      data-split={paneOpen ? "" : undefined}
      ref={screenRef}
      style={{ "--sessions-list-width": `${listWidth}px` } as CSSProperties}
    >
      <div className="sessions-pane">
        <header className="surface-heading">
          <div>
            {/* The page header already says Sessions; the heading stays for a reader. */}
            <h1 className="visually-hidden">Sessions</h1>
            <p>Conversations behind the work.</p>
          </div>
          <div className="surface-heading-actions">
            {sessions && <span className="surface-count">{sessions.length} conversations</span>}
            {projectId && (
              <button
                className="btn btn-primary"
                aria-label="New session"
                aria-pressed={composing}
                onClick={openComposer}
              >
                New
              </button>
            )}
          </div>
        </header>
        {sessions === null && <SessionsListSkeleton />}
        {sessions && sessions.length > 0 && (
          <div className="sessions-list">
            <div className="sessions-list-head" aria-hidden="true">
              <span>Card</span>
              <span>Agent</span>
              <span>Status</span>
              <span>Runs</span>
              <span>Started</span>
              <span>Cost</span>
            </div>
            {sessions.map((session) => {
              const run = session.latestRun;
              const agent = run.agentName ?? profiles.find((p) => p.id === run.agentProfileId)?.name ?? "agent";
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
                  {/* One row of a quiet table: the card, its agent and tool,
                      the status word, then the figures in mono. Beside an
                      open conversation the row folds to two lines. */}
                  <span className="session-card-title">{session.title}</span>
                  <span className="session-card-agent">
                    {agent}
                    {run.agentCli && <span className="session-card-tool"> {toolLabel(run.agentCli)}</span>}
                  </span>
                  <span className="status-word session-card-status" data-tone={sessionTone(run.status)}>
                    {runWords(run.status)}
                  </span>
                  <span
                    className="session-card-runs"
                    // The topbar's spend chip counts every run including
                    // the gate evaluator's judges, and several tools
                    // report no cost at all, so this figure is neither
                    // that one nor exact. Say so where it is shown.
                    title="This conversation's agent runs. Judge runs are not counted, and runs that report no cost are missing from the total, so it is a floor, not a total."
                  >
                    {session.runCount === 1 ? "1 run" : `${session.runCount} runs`}
                  </span>
                  <span className="session-card-time">{runTime(run.queuedAt)}</span>
                  <span className="session-card-cost">
                    {session.totalCostUsd !== null ? `$${session.totalCostUsd.toFixed(2)}` : ""}
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>
      {paneOpen && (
        <ListResizeHandle
          width={listWidth}
          screen={screenRef}
          onWidth={setListWidth}
          onDone={(width) => saveListWidth(width)}
        />
      )}
      {selectedId !== null && (
        // Keyed so switching conversations starts the pane fresh
        // instead of showing the previous card's messages while the
        // next one loads.
        <div className="sessions-detail" key={selectedId}>
          <Suspense fallback={<SessionPageSkeleton />}>
            <SessionPage
              client={client}
              featureId={selectedId}
              onClose={closePane}
              refreshSignal={boardTick}
            />
          </Suspense>
        </div>
      )}
      {composing && projectId && (
        <div className="sessions-detail">
          <SessionComposer
            client={client}
            projectId={projectId}
            {...(recentProfile ? { recentProfile } : {})}
            onCancel={closePane}
            onStarted={sessionStarted}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The line between the list and the open pane, dragged to resize the
 * list. Also a keyboard control (arrows, Home, End), and a double
 * click puts the list back to its default width. The width is saved
 * when a drag or a key press ends, not on every move.
 */
function ListResizeHandle({
  width,
  screen,
  onWidth,
  onDone,
}: {
  width: number;
  screen: RefObject<HTMLDivElement | null>;
  onWidth: (width: number) => void;
  onDone: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  /** Where the list starts, measured when a drag begins. */
  const origin = useRef(0);
  const latest = useRef(width);
  latest.current = width;

  const screenWidth = () => screen.current?.getBoundingClientRect().width ?? window.innerWidth;
  const listLeft = () => {
    const pane = screen.current?.querySelector<HTMLElement>(".sessions-pane");
    return pane?.getBoundingClientRect().left ?? 0;
  };
  const set = (next: number) => {
    const clamped = clampListWidth(next, screenWidth());
    latest.current = clamped;
    onWidth(clamped);
    return clamped;
  };

  return (
    <div
      className="sessions-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the conversation list"
      aria-valuemin={SESSIONS_LIST_MIN}
      aria-valuemax={SESSIONS_LIST_MAX}
      aria-valuenow={width}
      title="Drag to resize. Double click to reset."
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        origin.current = listLeft();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        set(event.clientX - origin.current);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        onDone(latest.current);
      }}
      onPointerCancel={() => {
        if (!dragging) return;
        setDragging(false);
        onDone(latest.current);
      }}
      onDoubleClick={() => onDone(set(SESSIONS_LIST_DEFAULT))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? SESSIONS_LIST_STEP * 4 : SESSIONS_LIST_STEP;
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = width - step;
        else if (event.key === "ArrowRight") next = width + step;
        else if (event.key === "Home") next = SESSIONS_LIST_MIN;
        else if (event.key === "End") next = SESSIONS_LIST_MAX;
        if (next === null) return;
        event.preventDefault();
        onDone(set(next));
      }}
    />
  );
}

/** The tool by the name people know it by: "claude-code" is Claude Code. */
function toolLabel(cli: string): string {
  return MODEL_GUIDANCE.find((tool) => tool.cli === cli)?.label ?? cli;
}

/** A run's status as the console's status words colour it. */
function sessionTone(status: string): "running" | "succeeded" | "failed" | "idle" {
  const dot = runDot(status);
  return dot === "cancelled" ? "idle" : dot;
}
