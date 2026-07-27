import { useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { AgentProfile, AgentRun, BentoClient } from "@bento/api-client";
import type { AgentEvent } from "@bento/core";
import type { LineQuote } from "./DiffReview.js";
import { LIVE_TOOLS } from "./ui.js";

/** Animation is decoration; a stilled frame carries the same meaning. */
const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which orb animation fits what the agent is doing right now. */
function orbStateFor(tool: string | null): OrbState {
  if (!tool) return "shaping";
  if (/read|grep|glob|search|fetch|ls|find/i.test(tool)) return "searching";
  if (/edit|write|patch|notebook/i.test(tool)) return "composing";
  if (/task|todo|plan|agent/i.test(tool)) return "solving";
  return "working";
}

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled"]);

/**
 * One conversation with a card's agents: the log, the run selector, and
 * the composer with its stop control. Shared by the card drawer and the
 * full-page session view, so the two cannot drift.
 */
export function AgentSession({
  client,
  featureId,
  runs,
  profiles,
  finished,
  onChanged,
  onEvent,
  expandHref,
  quote,
  onQuoteClear,
}: {
  client: BentoClient;
  featureId: string;
  runs: AgentRun[];
  profiles: AgentProfile[];
  /** A finished card takes no messages; reopen first. */
  finished: boolean;
  onChanged: () => void;
  onEvent?: (featureId: string, event: AgentEvent) => void;
  /** When set, the pane offers opening the session in its own tab. */
  expandHref?: string;
  /** A diff line the user picked to ask about; sent with the message. */
  quote?: LineQuote | null;
  onQuoteClear?: () => void;
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
  // preference, not a per-card state.
  const [showDetail, setShowDetail] = useState(() => localStorage.getItem("bento:logDetail") === "1");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The log pane can be pointed at any run; null follows the newest,
  // which is also where it snaps back when a new run starts.
  const [viewedRunId, setViewedRunId] = useState<string | null>(null);
  /**
   * What the agent is doing between spoken lines. Tool events used to
   * land in the log as "[tool Bash start] [tool tool_result end]" over
   * and over: room spent, nothing said. They feed this indicator now,
   * and collapse to one "[n tool steps]" line when the agent speaks.
   */
  const [activity, setActivity] = useState<{ tool: string | null; steps: number }>({ tool: null, steps: 0 });
  const stepsSinceMessage = useRef(0);
  const paneRef = useRef<HTMLPreElement>(null);

  // The server sends runs newest first.
  const latestRun = runs[0];
  const viewedRun = runs.find((r) => r.id === viewedRunId) ?? latestRun;
  const viewedAgent = profiles.find((p) => p.id === viewedRun?.agentProfileId);
  const latestAgent = profiles.find((p) => p.id === latestRun?.agentProfileId);
  const runActive = !!latestRun && !TERMINAL_RUN.has(latestRun.status);
  /** How the latest agent's tool treats a mid-task message, if at all. */
  const liveKind = latestAgent ? LIVE_TOOLS[latestAgent.cli] : undefined;

  useEffect(() => {
    setViewedRunId(null);
  }, [featureId, latestRun?.id]);

  // Finished runs come from one fetch; the live run streams below.
  const finishedCount = runs.filter((r) => TERMINAL_RUN.has(r.status)).length;
  useEffect(() => {
    void client
      .getConversation(featureId)
      .then((conv) => setBlocks(conv.blocks))
      .catch(() => setBlocks([]));
  }, [client, featureId, finishedCount]);

  // Follow the viewed run's transcript; finished runs replay in full.
  const streamedRun = viewedRunId ? viewedRun : runActive ? latestRun : null;
  useEffect(() => {
    setEvents([]);
    if (!streamedRun) return;
    stepsSinceMessage.current = 0;
    setActivity({ tool: null, steps: 0 });
    const stop = client.streamRun(streamedRun.id, {
      onEvent: (event) => {
        onEvent?.(featureId, event);
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
        // an ever-growing log on every event.
        setEvents((prev) => [...prev.slice(-1499), event]);
      },
      onDone: () => onChanged(),
    });
    return stop;
  }, [client, streamedRun?.id]);

  const lines = useMemo(() => {
    if (viewedRunId) return renderLines(events, viewedAgent?.name ?? "agent", showDetail);
    const out: string[] = [];
    for (const block of blocks) {
      out.push(separator(block.agentName, block.queuedAt, block.status));
      out.push(...renderLines(block.events, block.agentName, showDetail));
    }
    if (runActive && latestRun) {
      out.push(separator(latestAgent?.name ?? "agent", latestRun.queuedAt, "working"));
      out.push(...renderLines(events, latestAgent?.name ?? "agent", showDetail));
    } else if (blocks.length === 0) {
      out.push(...renderLines(events, latestAgent?.name ?? "agent", showDetail));
    }
    return out.slice(-1500);
  }, [events, blocks, viewedRunId, runActive, latestRun?.id, viewedAgent?.name, latestAgent?.name, showDetail]);

  useEffect(() => {
    // After paint: on the first render the pane has not been laid out
    // yet, so setting scrollTop immediately left a long conversation
    // parked at its oldest run.
    const frame = requestAnimationFrame(() => {
      const el = paneRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [lines.length]);

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
      // Live deliveries come back through the event stream, so adding
      // an optimistic line too would say it twice.
      if (!("live" in sent && sent.live)) {
        setEvents((prev) => [
          ...prev,
          {
            type: "message",
            role: "user",
            text: sent.queued ? `${prompt}  [queued until the agent finishes]` : prompt,
          } as AgentEvent,
        ]);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const workingName = latestAgent?.name ?? "the agent";
  const placeholder = !runActive
    ? "Tell the agent what to do next..."
    : liveKind === "steer"
      ? `Steer ${workingName} while it works...`
      : liveKind === "queue"
        ? `Message ${workingName}; it reads it after the current step...`
        : `Message ${workingName} (delivered when this run finishes)...`;

  return (
    <section className="section agent-session">
      <span className="label session-label">
        <span>
          Agent logs
          {viewedRun && viewedRun.id !== latestRun?.id ? ` (run from ${runTime(viewedRun.queuedAt)})` : ""}
        </span>
        <span className="session-tools">
          <button
            type="button"
            className="session-expand"
            aria-pressed={showDetail}
            onClick={() => {
              const next = !showDetail;
              setShowDetail(next);
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
      {latestRun ? (
        lines.length <= 1 && runActive && !viewedRunId ? (
          <div className="transcript orb-hero" aria-label="The agent is starting">
            <ThinkingOrb state="shaping" size={64} paused={REDUCED_MOTION} />
            <span className="muted">{workingName} is getting started...</span>
          </div>
        ) : (
          <pre className="transcript" ref={paneRef}>
            {lines.length > 0 ? lines.join("\n") : "Waiting for output..."}
          </pre>
        )
      ) : (
        <p className="muted">
          No agent has run on this card yet. Start it from the card's Actions, and the conversation
          appears here.
        </p>
      )}
      {runActive && !viewedRunId && lines.length > 1 && (
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
          <input
            className="input composer-input"
            value={say}
            onChange={(e) => setSay(e.target.value)}
            disabled={busy}
            placeholder={placeholder}
            aria-label="Message the agent"
          />
          {runActive && (
            <button
              type="button"
              className="btn composer-stop"
              disabled={busy}
              title="Stop the agent"
              aria-label="Stop the agent"
              onClick={() => {
                setBusy(true);
                void client
                  .cancelRun(latestRun.id)
                  .then(() => onChanged())
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }}
            >
              <span className="stop-square" aria-hidden="true" />
              Stop
            </button>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !say.trim()}>
            Send
          </button>
        </form>
      )}
      {latestRun && !finished && (
        <p className="muted composer-hint">
          {/* Nothing is running, so no delivery rule applies: saying one
              anyway ("delivered when the run ends") described a run that
              had already finished. */}
          {!runActive
            ? "Nothing is running. Your message starts a new run on this card, continuing the same conversation."
            : liveKind === "steer"
              ? `${latestAgent?.name ?? "This agent"} holds a live session: your message steers it while it works.`
              : liveKind === "queue"
                ? `${latestAgent?.name ?? "This agent"} holds a live session: your message is read after the current step, in the same conversation.`
                : "This tool takes messages between runs: yours is delivered the moment the current run ends."}
        </p>
      )}

      <div className="session-runs">
      <span className="label">Runs</span>
      {runs.length === 0 && <p className="muted">None yet.</p>}
      {runs.map((run) => (
        <button
          key={run.id}
          className="criterion run-row"
          data-viewing={run.id === viewedRun?.id || undefined}
          title="Show this run's log"
          onClick={() => setViewedRunId(run.id === latestRun?.id ? null : run.id)}
        >
          <span
            className="dot"
            data-state={run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "running"}
          />
          <span className="criterion-cmd">
            {profiles.find((p) => p.id === run.agentProfileId)?.name ?? "agent"} {runWords(run.status)}
          </span>
          <span className="muted">{runTime(run.queuedAt)}</span>
          {run.costUsd !== null && run.costUsd !== undefined && <span>${Number(run.costUsd).toFixed(2)}</span>}
        </button>
      ))}
      </div>
    </section>
  );
}

/** One line marking where a run begins inside the conversation. */
function separator(agentName: string, queuedAt: string, status: string): string {
  return `── ${agentName} · ${runTime(queuedAt)} · ${runWords(status)} ──`;
}

/**
 * A run's status as a phrase. The raw enum reads as debug output in a
 * log meant for people, and "queued" beside an agent's name told
 * nobody whether anything was happening.
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

/** "Jul 29, 11:42 PM": enough to tell runs apart without a full ISO stamp. */
export function runTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The log in either voice: collapsed (tool bursts fold into one
 * "[n tool steps]" marker) or detailed (every tool start and result,
 * for debugging a stuck agent). Pure, so the toggle replays history.
 */
function renderLines(events: AgentEvent[], agentName: string, showDetail: boolean): string[] {
  const lines: string[] = [];
  let steps = 0;
  for (const event of events) {
    if (event.type === "tool") {
      if (showDetail) {
        lines.push(`[tool ${event.name} ${event.phase}]`);
      } else if (event.phase === "start" && event.name !== "tool_result") {
        steps += 1;
      }
      continue;
    }
    if (steps > 0) {
      lines.push(`[${steps} tool step${steps === 1 ? "" : "s"}]`);
      steps = 0;
    }
    lines.push(renderEvent(event, agentName));
  }
  if (steps > 0) lines.push(`[${steps} tool step${steps === 1 ? "" : "s"} so far]`);
  return lines.slice(-500);
}

function renderEvent(event: AgentEvent, agentName: string): string {
  switch (event.type) {
    case "init":
      return "[session started]";
    case "message":
      // The profile's name, not the wire role: "Product Designer>"
      // reads as a colleague, "assistant>" reads as a protocol.
      return `${event.role === "assistant" ? agentName : event.role === "user" ? "you" : event.role}> ${event.text}`;
    case "tool":
      return `[tool ${event.name} ${event.phase}]`;
    case "result":
      return event.ok
        ? `[done${event.costUsd !== undefined ? ` cost $${event.costUsd}` : ""}]`
        : `[failed: ${event.error ?? "no reason reported"}]`;
  }
}
