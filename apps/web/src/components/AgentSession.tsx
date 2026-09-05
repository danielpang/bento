import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { AgentProfile, AgentRun, BentoClient, Stage } from "@bento/api-client";
import {
  forgetsBetweenRuns,
  hasNoLiveTranscript,
  modelGuidanceFor,
  withProviderOutageAdvice,
  type AgentEvent,
} from "@bento/core";
import { linkifiedError } from "../error-text.js";
import type { LineQuote } from "./DiffReview.js";
import { StopButton } from "./IconButtons.js";
import { LIVE_TOOLS } from "./ui.js";

/** Animation is decoration; a stilled frame carries the same meaning. */
const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which orb animation fits what the agent is doing right now. */
function orbStateFor(tool: string | null): OrbState {
  if (!tool) return "shaping";
  if (/read|grep|glob|search|fetch|ls|find/i.test(tool)) return "searching";
  if (/edit|write|patch|notebook/i.test(tool)) return "composing";
  if (/task|todo|plan|agent|think/i.test(tool)) return "solving";
  return "working";
}

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled"]);

/**
 * How close to the end still counts as reading the newest line, in
 * pixels. Inside it the pane keeps following the agent; outside it the
 * reader is somewhere further up and is offered the way back down.
 */
const AT_BOTTOM_SLACK = 120;

/**
 * How tall the composer may grow, in pixels, before it scrolls.
 * Long enough to read a wrapped paragraph, short enough that it
 * cannot eat the transcript above it.
 */
const COMPOSER_MAX_HEIGHT = 160;

/**
 * The conversation is rendered from these, never from raw events: a
 * run's event list is folded into rows first, so tool bursts collapse
 * and the pane reads as an exchange between people.
 */
export type ChatItem =
  | { key: string; kind: "message"; role: "assistant" | "user" | "system"; text: string; speaker: string }
  | { key: string; kind: "tools"; calls: ToolCall[] }
  | { key: string; kind: "result"; ok: boolean; costUsd?: number | undefined; error?: string | undefined };

interface ToolCall {
  name: string;
  phase: "start" | "end";
  /** A short reading of the call's input, when the adapter carried one. */
  summary: string | null;
}

/** A message the server accepted but has not echoed back yet. */
interface PendingMessage {
  id: number;
  text: string;
  queued: boolean;
}

/**
 * One conversation with a card's agents: the chat, the run selector,
 * and the composer with its stop control. Shared by the card drawer
 * and the full-page session view, so the two cannot drift.
 */
export function AgentSession({
  client,
  featureId,
  runs,
  profiles,
  stages,
  finished,
  onChanged,
  onEvent,
  expandHref,
  quote,
  onQuoteClear,
  defaultShowDetail,
  showDetail: controlledShowDetail,
}: {
  client: BentoClient;
  featureId: string;
  runs: AgentRun[];
  profiles: AgentProfile[];
  /** Names the stage each run belongs to in the run picker, when known. */
  stages?: Stage[];
  /** A finished card takes no messages; reopen first. */
  finished: boolean;
  onChanged: () => void;
  onEvent?: (featureId: string, event: AgentEvent) => void;
  /** When set, the pane offers opening the session in its own tab. */
  expandHref?: string;
  /** A diff line the user picked to ask about; sent with the message. */
  quote?: LineQuote | null;
  onQuoteClear?: () => void;
  /** Falls back to this when localStorage has no saved detail preference yet. */
  defaultShowDetail?: boolean;
  /**
   * Fully controlled detail mode for durable previews. When set, it
   * wins over both the saved preference and defaultShowDetail.
   */
  showDetail?: boolean;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  /**
   * The finished part of the conversation, every prior run in order.
   * Without it, each follow-up run reset the pane and the exchange
   * looked lost, even though the agent kept its session context.
   */
  const [blocks, setBlocks] = useState<
    { runId: string; agentName: string; queuedAt: string; status: string; events: AgentEvent[] }[]
  >([]);
  // Remembered across cards and sessions: detail is a reading
  // preference, not a per-card state. Only an absent preference falls
  // back to defaultShowDetail; a saved "0" still means hidden.
  const [showDetailState, setShowDetailState] = useState(() => {
    const saved = localStorage.getItem("bento:logDetail");
    return saved === null ? (defaultShowDetail ?? false) : saved === "1";
  });
  const showDetail = controlledShowDetail ?? showDetailState;
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The pane can be pointed at any run; null follows the newest, which
  // is also where it snaps back when a new run starts.
  const [viewedRunId, setViewedRunId] = useState<string | null>(null);
  /**
   * Sent messages the transcript has not echoed yet. Shown immediately
   * so the composer never appears to swallow one, and reconciled
   * against the persisted record the moment it streams in or lands in
   * a finished block, so nothing shows twice.
   */
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const pendingId = useRef(0);
  /**
   * What the agent is doing between spoken lines. Tool events used to
   * land in the log as "[tool Bash start] [tool tool_result end]" over
   * and over: room spent, nothing said. They feed this indicator now,
   * and collapse into one row in the conversation.
   */
  const [activity, setActivity] = useState<{ tool: string | null; steps: number }>({ tool: null, steps: 0 });
  const stepsSinceMessage = useRef(0);
  /**
   * Highest event seq applied for the viewed stream. The server
   * resumes a reconnect from Last-Event-ID, and this guard is the
   * other half: an event that somehow arrives twice renders once.
   */
  const lastSeq = useRef(0);
  /**
   * The message being typed, built from streamed fragments. Fragments
   * arrive per token, so they accumulate in a ref and reach state once
   * a frame; per token setState would render hundreds of times a
   * second. Cleared whenever a finished message or result lands: the
   * transcript's copy is authoritative and showing both says it twice.
   */
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const draftFrame = useRef<number | null>(null);
  const clearDraft = () => {
    draftRef.current = "";
    if (draftFrame.current !== null) {
      cancelAnimationFrame(draftFrame.current);
      draftFrame.current = null;
    }
    setDraft("");
  };
  const paneRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Whether the pane is pinned to the newest row; reading history unpins it. */
  const stickToBottom = useRef(true);
  /**
   * Whether the way back down is offered. A ref cannot drive it: the
   * pin above is read during scroll and paint, while this decides what
   * renders, so it has to be state.
   */
  const [scrolledUp, setScrolledUp] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  /**
   * Read the pane's position once and let both halves follow from it,
   * so the pin and the button can never disagree about where the
   * reader is.
   */
  const readPosition = () => {
    const el = paneRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK;
    stickToBottom.current = atBottom;
    setScrolledUp(!atBottom);
  };

  /**
   * Straight to the newest line, and pinned there again. Not a smooth
   * scroll: a long history is thousands of pixels of somebody else's
   * conversation to sit through, and every frame on the way down reads
   * as scrolled up, which flickers this very button back into view.
   */
  const jumpToBottom = () => {
    const el = paneRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setScrolledUp(false);
    el.scrollTop = el.scrollHeight;
  };

  // The server sends runs newest first.
  const latestRun = runs[0];
  const viewedRun = runs.find((r) => r.id === viewedRunId) ?? latestRun;
  const viewedAgent = profiles.find((p) => p.id === viewedRun?.agentProfileId);
  const latestAgent = profiles.find((p) => p.id === latestRun?.agentProfileId);
  const runActive = !!latestRun && !TERMINAL_RUN.has(latestRun.status);
  /** How the latest agent's tool treats a mid-task message, if at all. */
  const liveKind = latestAgent ? LIVE_TOOLS[latestAgent.cli] : undefined;
  /** Whether a new run can pick the conversation up where this left it. */
  const resumes = !latestAgent || !forgetsBetweenRuns(latestAgent.cli);
  const quietTool = Boolean(latestAgent && hasNoLiveTranscript(latestAgent.cli));
  const quietLabel = latestAgent ? (modelGuidanceFor(latestAgent.cli)?.label ?? latestAgent.cli) : "";

  useEffect(() => {
    if (!runActive || !quietTool) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [latestRun?.id, quietTool, runActive]);

  useEffect(() => {
    setViewedRunId(null);
  }, [featureId, latestRun?.id]);

  // A different card has a different conversation waiting for it.
  useEffect(() => {
    setPending([]);
  }, [featureId]);

  // Finished runs come from one fetch; the live run streams below.
  const finishedCount = runs.filter((r) => TERMINAL_RUN.has(r.status)).length;
  useEffect(() => {
    void client
      .getConversation(featureId)
      .then((conv) => {
        setBlocks(conv.blocks);
        /**
         * Messages parked on the server outlive this tab: after a
         * reload the optimistic entries are gone, and without this a
         * waiting message looked like it never existed. Server rows
         * merge behind whatever is already showing; the transcript
         * reconciliation above retires them once a run echoes them.
         */
        setPending((prev) => {
          const showing = new Set(prev.map((p) => p.text));
          const parked = (conv.pending ?? [])
            .filter((m) => !showing.has(m.text))
            .map((m) => ({ id: ++pendingId.current, text: m.text, queued: true }));
          return parked.length > 0 ? [...parked, ...prev] : prev;
        });
      })
      .catch(() => setBlocks([]));
  }, [client, featureId, finishedCount]);

  // Follow the viewed run's transcript; finished runs replay in full.
  const streamedRun = viewedRunId ? viewedRun : runActive ? latestRun : null;
  useEffect(() => {
    setEvents([]);
    clearDraft();
    lastSeq.current = 0;
    if (!streamedRun) return;
    stepsSinceMessage.current = 0;
    setActivity({ tool: null, steps: 0 });
    const stop = client.streamRun(streamedRun.id, {
      onEvent: (event, seq) => {
        // Replays and reconnects both re-deliver; seq is the
        // exactly-once cursor the pane renders by.
        if (seq > 0 && seq <= lastSeq.current) return;
        if (seq > lastSeq.current) lastSeq.current = seq;
        onEvent?.(featureId, event);
        // The persisted line supersedes the fragments that previewed
        // it. Assistant lines and results only: a steer the user sends
        // mid turn says nothing about the message still being typed,
        // and clearing on it left the draft permanently behind the
        // stream's offsets, frozen mid sentence.
        if (event.type === "result" || (event.type === "message" && event.role === "assistant")) {
          clearDraft();
        }
        if (event.type === "tool") {
          if (event.phase === "start" && event.name !== "tool_result") {
            stepsSinceMessage.current += 1;
            setActivity({ tool: event.name, steps: stepsSinceMessage.current });
          }
        } else {
          stepsSinceMessage.current = 0;
          setActivity({ tool: null, steps: 0 });
        }
        // The pane shows the tail; a long run would otherwise re-render
        // an ever-growing conversation on every event. Whatever the cap
        // drops returns when the finished run's block is refetched.
        setEvents((prev) => [...prev.slice(-1999), event]);
      },
      onDelta: (delta) => {
        // Thinking has no text worth previewing; it only proves life.
        if (delta.channel === "thinking") {
          setActivity((prev) => (prev.tool === "thinking" ? prev : { tool: "thinking", steps: prev.steps }));
          return;
        }
        setActivity((prev) => (prev.tool === "thinking" ? { tool: null, steps: prev.steps } : prev));
        /**
         * Offset zero starts a draft (a new message, or the server's
         * catch-up snapshot of one already in flight); anything else
         * must continue exactly where this draft ends. A fragment from
         * the middle of a sentence renders as text that starts
         * nowhere, so it is dropped; the finished message arrives
         * whole regardless.
         */
        if (delta.offset === 0) draftRef.current = delta.text;
        else if (delta.offset === draftRef.current.length) draftRef.current += delta.text;
        else return;
        if (draftFrame.current === null) {
          draftFrame.current = requestAnimationFrame(() => {
            draftFrame.current = null;
            setDraft(draftRef.current);
          });
        }
      },
      onDone: () => {
        // A cancelled run ends with no result event, so this is the
        // only thing standing between a stopped run and a half typed
        // sentence pinned to the transcript.
        clearDraft();
        onChanged();
      },
    });
    return () => {
      stop();
      if (draftFrame.current !== null) {
        cancelAnimationFrame(draftFrame.current);
        draftFrame.current = null;
      }
    };
  }, [client, streamedRun?.id]);

  /**
   * The conversation as sections, one per run, newest last. Default
   * view: every finished run's block in order, then the latest run's
   * live events (or a just-finished run's, until its block arrives:
   * clearing them there blanked the exchange that had only moments
   * left to read). A run picked from the list shows alone.
   */
  const sections = useMemo(() => {
    const out: { key: string; runId: string; agentName: string; when: string; status: string; items: ChatItem[] }[] = [];
    const itemsFor = (runId: string, runEvents: AgentEvent[], agentName: string, prefix: string): ChatItem[] => {
      const sourceRun = runs.find((run) => run.id === runId);
      const sourceAgent = profiles.find((profile) => profile.id === sourceRun?.agentProfileId);
      const items = withProviderOutageErrors(toChatItems(runEvents, agentName, prefix), sourceAgent);
      if (
        sourceRun &&
        TERMINAL_RUN.has(sourceRun.status) &&
        sourceAgent &&
        hasNoLiveTranscript(sourceAgent.cli) &&
        items.some((item) => item.kind === "message" && item.role === "assistant")
      ) {
        return withNoLiveTranscriptNote(
          items,
          prefix,
          modelGuidanceFor(sourceAgent.cli)?.label ?? sourceAgent.cli,
        );
      }
      return items;
    };
    if (viewedRunId) {
      if (viewedRun) {
        out.push({
          key: viewedRun.id,
          runId: viewedRun.id,
          agentName: viewedAgent?.name ?? "agent",
          when: runTime(viewedRun.queuedAt),
          status: runWords(viewedRun.status),
          items: itemsFor(viewedRun.id, events, viewedAgent?.name ?? "agent", `v-${viewedRun.id}`),
        });
      }
      return out;
    }
    const inBlocks = new Set(blocks.map((b) => b.runId));
    for (const block of blocks) {
      out.push({
        key: block.runId,
        runId: block.runId,
        agentName: block.agentName,
        when: runTime(block.queuedAt),
        status: runWords(block.status),
        items: itemsFor(block.runId, block.events, block.agentName, block.runId),
      });
    }
    if (latestRun && !inBlocks.has(latestRun.id)) {
      out.push({
        key: latestRun.id,
        runId: latestRun.id,
        agentName: latestAgent?.name ?? "agent",
        when: runTime(latestRun.queuedAt),
        status: runActive ? "working" : runWords(latestRun.status),
        items: itemsFor(latestRun.id, events, latestAgent?.name ?? "agent", latestRun.id),
      });
    }
    return out;
  }, [events, blocks, viewedRunId, viewedRun, latestRun, runActive, viewedAgent?.name, latestAgent?.name, profiles, runs]);

  /**
   * Pendings that have not been echoed by the transcript, counting
   * occurrences so sending the same words twice still reconciles one
   * at a time.
   */
  const visiblePending = useMemo(() => {
    const echoed = new Map<string, number>();
    const count = (text: string) => echoed.set(text, (echoed.get(text) ?? 0) + 1);
    if (!viewedRunId) {
      for (const block of blocks) {
        for (const event of block.events) {
          if (event.type === "message" && event.role === "user") count(event.text);
        }
      }
      for (const event of events) {
        if (event.type === "message" && event.role === "user") count(event.text);
      }
    }
    return pending.filter((p) => {
      const left = echoed.get(p.text) ?? 0;
      if (left > 0) {
        echoed.set(p.text, left - 1);
        return false;
      }
      return true;
    });
  }, [pending, blocks, events, viewedRunId]);

  const hasMessages = sections.some((s) => s.items.length > 0) || visiblePending.length > 0;

  useEffect(() => {
    // After paint: on the first render the pane has not been laid out
    // yet, so setting scrollTop immediately left a long conversation
    // parked at its oldest run. And only when pinned: reading history
    // must not be yanked back to the newest line on every event, and
    // the draft updates once per animation frame while text streams.
    const frame = requestAnimationFrame(() => {
      const el = paneRef.current;
      if (!el) return;
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      // Output that arrives while the reader is up in the history
      // pushes the newest line further away, so the offer to jump has
      // to be reconsidered whenever the transcript grows, not only
      // when the reader scrolls.
      readPosition();
    });
    return () => cancelAnimationFrame(frame);
  }, [sections, visiblePending.length, draft]);

  /**
   * Fit the composer to what is typed, including a long line that
   * wrapped rather than a newline. Resetting height first is what
   * lets it shrink again after send.
   */
  useLayoutEffect(() => {
    growComposer(composerRef.current);
  }, [say]);

  async function send() {
    const question = say.trim();
    if (!question) return;
    // A picked diff line travels with the question, so the agent knows
    // exactly which change is being asked about.
    const prompt = quote
      ? `In ${quote.repo}/${quote.file} at line ${quote.line}:\n> ${quote.text.trim()}\n\n${question}`
      : question;
    setBusy(true);
    setError("");
    try {
      const sent = await client.messageFeature(featureId, prompt);
      onQuoteClear?.();
      setSay("");
      // Watch the answer, not the historical run that happened to be open.
      setViewedRunId(null);
      stickToBottom.current = true;
      // Live deliveries echo back through the event stream on their
      // own; anything else would be invisible until then, so it is
      // shown now and reconciled when the persisted line arrives.
      if (!("live" in sent && sent.live)) {
        setPending((prev) => [...prev, { id: ++pendingId.current, text: prompt, queued: sent.queued }]);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const workingName = latestAgent?.name ?? "the agent";
  const composer = composerPrompt(runActive, liveKind);

  return (
    <section className="section agent-session">
      <span className="label session-label">
        <span>
          Conversation
          {viewedRun && viewedRun.id !== latestRun?.id ? ` (run from ${runTime(viewedRun.queuedAt)})` : ""}
        </span>
        <span className="session-tools">
          <button
            type="button"
            className="session-expand"
            aria-pressed={showDetail}
            onClick={() => {
              // Controlled previews pin the mode; only the uncontrolled
              // path remembers a preference across cards and sessions.
              if (controlledShowDetail !== undefined) return;
              const next = !showDetailState;
              setShowDetailState(next);
              localStorage.setItem("bento:logDetail", next ? "1" : "0");
            }}
          >
            {showDetail ? "Hide detail" : "Show detail"}
          </button>
          {expandHref && (
            <a className="session-expand" href={expandHref} target="_blank" rel="noreferrer">
              Open full view ↗
            </a>
          )}
        </span>
      </span>
      {/*
        The latest run is what the pane follows by default; earlier
        runs stay reachable through this picker rather than a list, so
        a long card's history does not stack rows in the pane. At the
        top, because it says what the pane below is showing. Picking
        the newest entry hands the pane back to "follow the latest",
        which is also where it snaps when a new run starts.
      */}
      {runs.length > 0 && viewedRun && (
        <div className="session-runs">
          <RunPicker
            runs={runs}
            profiles={profiles}
            stages={stages}
            value={viewedRun.id}
            onValueChange={(id) => setViewedRunId(id === latestRun?.id ? null : id)}
          />
        </div>
      )}
      {latestRun ? (
        !quietTool && !hasMessages && !draft && runActive && !viewedRunId ? (
          <div className="chat orb-hero" aria-label="The agent is starting">
            <ThinkingOrb state="shaping" size={64} paused={REDUCED_MOTION} />
            <span className="muted">{workingName} is getting started...</span>
          </div>
        ) : (
          <div className="chat" ref={paneRef} onScroll={readPosition}>
            {sections.length === 0 && !hasMessages && !draft && !quietTool && <p className="muted">Waiting for output...</p>}
            {sections.map((section) => (
              <div className="chat-section" key={section.key}>
                <div className="chat-run">
                  <span>
                    {section.agentName} · {section.when} · {section.status}
                  </span>
                </div>
                {section.items.map((item) => (
                  <ChatRow key={item.key} item={item} showDetail={showDetail} />
                ))}
              </div>
            ))}
            {quietTool && runActive && !viewedRunId && (
              <div className="chat-row chat-row-system" role="status" aria-label="No live output from this tool">
                <ThinkingOrb state="shaping" size={20} paused={REDUCED_MOTION} />
                <div className="quiet-run-copy">
                  <strong>No live output from this tool</strong>
                  <span className="muted">
                    {quietLabel} prints one final message when the run ends and nothing before it, so this card stays
                    quiet until then. That is the tool, not a stall. The work still lands on the branch, and Stop ends the run now.
                  </span>
                  <span className="muted">Working for {runDuration(latestRun.startedAt, clock)}.</span>
                  {isLongQuietRun(latestRun.startedAt, clock) && (
                    <span className="warn">
                      Still working after 30 minutes, with nothing printed. Nothing on this card can tell whether it is
                      progressing, because the tool prints nothing until it ends. Stop it if this looks wrong.
                    </span>
                  )}
                </div>
              </div>
            )}
            {/*
              The message being typed, in the agent's own bubble: the
              fragments preview what the finished message will say, and
              its arrival replaces them. Only the live run produces
              fragments, so the latest agent is always the one talking.
            */}
            {!viewedRunId && draft && (
              <MessageBubble role="assistant" speaker={workingName} text={draft} state="draft" />
            )}
            {!viewedRunId &&
              visiblePending.map((p) => (
                <MessageBubble
                  key={`pending-${p.id}`}
                  role="user"
                  speaker={`you${p.queued ? " · queued until the agent finishes" : ""}`}
                  text={p.text}
                  state="pending"
                />
              ))}
            {/*
              The way back down, offered only while the reader is far
              enough up that the newest line is out of sight. It rides
              the bottom of the pane rather than the end of the
              transcript, so it stays reachable from anywhere in a long
              history.
            */}
            {scrolledUp && (
              <div className="chat-jump-anchor">
                <button type="button" className="chat-jump" onClick={jumpToBottom}>
                  Jump to latest ↓
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        <p className="muted">
          No agent has run on this card yet. Start it from the card's Actions, and the conversation
          appears here.
        </p>
      )}
      {runActive && !viewedRunId && hasMessages && (
        <div className="working-row" role="status">
          <ThinkingOrb state={orbStateFor(activity.tool)} size={20} paused={REDUCED_MOTION} aria-label="Agent working" />
          <span className="muted">
            {workingName} is working
            {activity.tool ? `: ${activity.tool}` : ""}
            {activity.steps > 1 ? ` · step ${activity.steps}` : ""}
          </span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {/*
        Talking never demands a stop: live tools (pi, Claude Code) hear
        the message while working; the rest receive it when the run
        ends. Stop sits beside the field, where the conversation is.
      */}
      {quote && (
        <div className="quote-chip">
          <span className="quote-chip-text" title={quote.text}>
            {quote.file}:{quote.line} · {quote.text.trim().slice(0, 80) || "(blank line)"}
          </span>
          <button type="button" className="btn btn-ghost" aria-label="Remove the quoted line" onClick={() => onQuoteClear?.()}>
            ✕
          </button>
        </div>
      )}
      {latestRun && !finished && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={composerRef}
            className="input composer-input"
            rows={1}
            value={say}
            onChange={(e) => setSay(e.target.value)}
            disabled={busy}
            placeholder={composer.placeholder}
            aria-label={composer.ariaLabel}
            // Enter sends, as it did when this was a single-line
            // field. Shift+Enter is the newline; wrapping a long
            // line grows the box on its own.
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {runActive && (
            <StopButton
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void client
                  .cancelRun(latestRun.id)
                  .then(() => onChanged())
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }}
            />
          )}
          <button
            className="btn btn-primary composer-send"
            type="submit"
            disabled={busy || !say.trim()}
            aria-label={composer.ariaLabel}
            title={composer.ariaLabel}
          >
            <SendMark />
          </button>
        </form>
      )}
      {latestRun && !finished && (
        <p className="muted composer-hint">
          {/* Nothing is running, so no delivery rule applies: saying one
              anyway ("delivered when the run ends") described a run that
              had already finished. */}
          {!runActive
            ? resumes
              ? "Nothing is running. Your message starts a new run on this card, continuing the same conversation."
              : "Nothing is running. Your message starts a new run on this card, with a compacted transcript of this conversation."
            : liveKind === "steer"
              ? `${latestAgent?.name ?? "This agent"} holds a live session: your message steers it while it works.`
              : liveKind === "queue"
                ? `${latestAgent?.name ?? "This agent"} holds a live session: your message is read after the current step, in the same conversation.`
                : resumes
                  ? "This tool takes messages between runs: yours is delivered the moment the current run ends."
                  : "This tool takes messages between runs: yours is delivered the moment the current run ends, as a new run with a compacted transcript of this conversation."}
        </p>
      )}

    </section>
  );
}

export function MessageBubble({
  role,
  speaker,
  text,
  state,
}: {
  role: "assistant" | "user";
  speaker: string;
  text: string;
  state?: "pending" | "draft";
}) {
  return (
    <div className={`chat-row chat-row-${role}`}>
      <div
        className={`chat-bubble chat-bubble-${role}`}
        data-pending={state === "pending" || undefined}
        data-draft={state === "draft" || undefined}
      >
        <span className="chat-meta">{speaker}</span>
        <span className="chat-text">{text}</span>
      </div>
    </div>
  );
}

/** One row of the conversation, whatever it carries. */
function ChatRow({ item, showDetail }: { item: ChatItem; showDetail: boolean }) {
  if (item.kind === "message") {
    if (item.role === "user") {
      return <MessageBubble role="user" speaker="you" text={item.text} />;
    }
    if (item.role === "system") {
      return (
        <div className="chat-row chat-row-system">
          <span className="chat-note">{item.text}</span>
        </div>
      );
    }
    return <MessageBubble role="assistant" speaker={item.speaker} text={item.text} />;
  }
  if (item.kind === "tools") {
    return <ToolRow calls={item.calls} showDetail={showDetail} />;
  }
  return (
    <div className="chat-row chat-row-system">
      <span className="chat-result" data-ok={item.ok}>
        {item.ok
          ? `finished${item.costUsd !== undefined ? ` · $${item.costUsd.toFixed(2)}` : ""}`
          : <>failed: {linkifiedError(item.error ?? "no reason reported")}</>}
      </span>
    </div>
  );
}

/**
 * A run's tool activity as one subdued row. Collapsed it counts steps
 * and names the tools; the detail toggle lists each call with a short
 * reading of its input, for debugging a stuck agent.
 */
function ToolRow({ calls, showDetail }: { calls: ToolCall[]; showDetail: boolean }) {
  if (showDetail) {
    return (
      <div className="chat-row chat-row-tools">
        <div className="chat-tools-detail">
          {calls.map((call, i) => (
            <span key={i} className="chat-tool-line">
              {call.name}
              {call.summary ? `: ${call.summary}` : ""} {call.phase}
            </span>
          ))}
        </div>
      </div>
    );
  }
  const starts = calls.filter((c) => c.phase === "start");
  const names = [...new Set(starts.map((c) => c.name))];
  const label =
    starts.length === 0
      ? "tool activity"
      : `${starts.length} tool step${starts.length === 1 ? "" : "s"}${names.length > 0 ? ` · ${names.join(", ")}` : ""}`;
  return (
    <div className="chat-row chat-row-tools">
      <span className="chat-tools">{label}</span>
    </div>
  );
}

/**
 * Folds a run's events into conversation rows. Consecutive tool events
 * gather into one row so a burst of file reads is a line, not a
 * screen; everything else keeps its order. Pure, so history and the
 * live stream render identically.
 */
function toChatItems(events: AgentEvent[], agentName: string, keyPrefix: string): ChatItem[] {
  const items: ChatItem[] = [];
  let calls: ToolCall[] = [];
  let n = 0;
  const flush = () => {
    if (calls.length === 0) return;
    items.push({ key: `${keyPrefix}-tools-${n}`, kind: "tools", calls });
    n += 1;
    calls = [];
  };
  for (const event of events) {
    if (event.type === "tool") {
      calls.push({ name: event.name, phase: event.phase, summary: toolSummary(event) });
      continue;
    }
    flush();
    if (event.type === "init") continue; // the run divider already says a session began
    if (event.type === "message") {
      items.push({
        key: `${keyPrefix}-${n}`,
        kind: "message",
        role: event.role,
        text: event.text,
        speaker: event.role === "assistant" ? agentName : event.role === "user" ? "you" : "bento",
      });
      n += 1;
      continue;
    }
    items.push({
      key: `${keyPrefix}-${n}`,
      kind: "result",
      ok: event.ok,
      costUsd: event.costUsd,
      error: event.error,
    });
    n += 1;
  }
  flush();
  return items;
}

/**
 * A short reading of a tool call's input, when the adapter carried it:
 * the command for a shell, the path for a file edit, the pattern for a
 * search. Null when there is nothing honest to say.
 */
function toolSummary(event: Extract<AgentEvent, { type: "tool" }>): string | null {
  if (event.phase !== "start" || !event.detail || typeof event.detail !== "object") return null;
  const input = event.detail as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.replaceAll(/\s+/g, " ").trim();
    }
    return null;
  };
  const text = pick("command", "file_path", "path", "pattern", "url", "query", "description", "prompt");
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Grows the conversation composer to fit what has been typed.
 *
 * A long line used to vanish into a one-line field. Height is reset
 * before it is measured, or the box could only ever grow; past the
 * cap it scrolls rather than pushing the transcript off the screen.
 */
function growComposer(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const content = el.scrollHeight;
  el.style.height = `${Math.min(content, COMPOSER_MAX_HEIGHT)}px`;
  el.style.overflowY = content > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

/**
 * What the composer field says. Naming the agent ("Message Claude")
 * made the box look like a DM, and hid whether the words go now or
 * wait. Send vs queue is the distinction the box needs to make: idle
 * and live-steer deliver immediately; a live queue and tools that only
 * take messages between runs wait.
 */
export function composerPrompt(
  runActive: boolean,
  liveKind: "steer" | "queue" | undefined,
): { placeholder: string; ariaLabel: string } {
  if (!runActive || liveKind === "steer") {
    return { placeholder: "Send a message...", ariaLabel: "Send a message" };
  }
  return { placeholder: "Queue a message...", ariaLabel: "Queue a message" };
}

/**
 * A run's status as a phrase. The raw enum reads as debug output in a
 * conversation meant for people, and "queued" beside an agent's name
 * told nobody whether anything was happening.
 */
export function runWords(status: string): string {
  switch (status) {
    case "queued":
      return "waiting to start";
    case "starting":
      return "starting";
    case "running":
      return "working";
    case "succeeded":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return status;
  }
}

/**
 * The send arrow. Drawn on the same stroke weight as the console's
 * other marks, and used instead of a worded button so the composer's
 * width goes to the input.
 */
function SendMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 13.25V3.25" />
      <path d="M3.75 7.5 8 3.25 12.25 7.5" />
    </svg>
  );
}

/** "Jul 29, 11:42 PM": enough to tell runs apart without a full ISO stamp. */
export function runTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function elapsedMs(startedAt: string | null, now: number): number {
  return startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : 0;
}

export function runDuration(startedAt: string | null, now: number): string {
  const seconds = Math.floor(elapsedMs(startedAt, now) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function isLongQuietRun(startedAt: string | null, now: number): boolean {
  return elapsedMs(startedAt, now) >= 30 * 60 * 1000;
}

/**
 * When a result is a model-provider outage, the status page rides on
 * the same line the transcript already shows. Applied at display time
 * so a result event that predates the server-side sentence still
 * names the page.
 */
export function withProviderOutageErrors(
  items: ChatItem[],
  agent?: { cli: string; model: string } | undefined,
): ChatItem[] {
  return items.map((item) => {
    if (item.kind !== "result" || item.ok || !item.error) return item;
    return { ...item, error: withProviderOutageAdvice(item.error, agent) };
  });
}

export function withNoLiveTranscriptNote(items: ChatItem[], prefix: string, toolLabel = "This tool"): ChatItem[] {
  const assistantIndex = items.findIndex((item) => item.kind === "message" && item.role === "assistant");
  if (assistantIndex < 0) return items;
  const noted = [...items];
  noted.splice(assistantIndex, 0, {
    key: `${prefix}-quiet-note`,
    kind: "message",
    role: "system",
    speaker: "system",
    text: `${toolLabel} printed its final message. There are no tool steps or thinking to show, because this tool does not print them while it works.`,
  });
  return noted;
}

/**
 * A run's status as a dot state. One mapping for every run list, so a
 * stopped run cannot pulse as live in one place while reading as
 * stopped in another: cancelled gets its own grey, and only the
 * statuses that are actually in motion get the breathing dot.
 */
export function runDot(status: string): "succeeded" | "failed" | "cancelled" | "running" {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/**
 * Which run the conversation is showing.
 *
 * A native select cannot carry a CSS dot, which is why this used to be
 * a coloured emoji in each option. The menu is the same control the
 * project picker uses, so each row can wear the same 6px status dot
 * the sessions list already uses: colour still carries the outcome,
 * the stage names the work, and the timestamp tells three red
 * "Code review" attempts apart.
 */
function RunPicker({
  runs,
  profiles,
  stages,
  value,
  onValueChange,
}: {
  runs: AgentRun[];
  profiles: AgentProfile[];
  stages?: Stage[];
  value: string;
  onValueChange: (id: string) => void;
}) {
  const selected = runs.find((run) => run.id === value) ?? runs[0];
  const selectedCaption = selected ? runCaption(selected, profiles, stages) : "";
  const selectedStatus = selected ? runWords(selected.status) : "";

  return (
    <Menu.Root>
      <Menu.Trigger
        className="select run-picker"
        aria-label={
          selected
            ? `Run shown in the conversation: ${selectedStatus}, ${selectedCaption}`
            : "Run shown in the conversation"
        }
      >
        {selected && <RunStatusDot status={selected.status} />}
        {selected && <span className="run-picker-label">{selectedCaption}</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="picker-menu run-picker-menu" align="start" sideOffset={4} data-portal-layer="">
          <Menu.RadioGroup className="picker-group" value={value} onValueChange={onValueChange}>
            {runs.map((run) => (
              <Menu.RadioItem key={run.id} value={run.id} className="picker-item">
                <RunStatusDot status={run.status} />
                <span className="visually-hidden">{runWords(run.status)}. </span>
                <span className="picker-item-name">{runCaption(run, profiles, stages)}</span>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function runCaption(run: AgentRun, profiles: AgentProfile[], stages: Stage[] | undefined): string {
  const stage = stages?.find((s) => s.id === run.stageId)?.name;
  const agent = profiles.find((p) => p.id === run.agentProfileId)?.name ?? "agent";
  return `${stage ?? agent} · ${runTime(run.queuedAt)}`;
}

function RunStatusDot({ status }: { status: string }) {
  return <span className="dot" data-state={runDot(status)} aria-hidden="true" />;
}
