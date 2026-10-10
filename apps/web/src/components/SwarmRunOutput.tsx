import { useEffect, useMemo, useRef, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import type { AgentEvent } from "@bento/core";
import type { SwarmApi, SwarmPlannerMessage } from "../swarm/client.js";
import type { SwarmStatus } from "../swarm/types.js";
import { plannerFailure } from "../swarm/failures.js";
import { ChatRow, toChatItems } from "./AgentSession.js";
import { AgentOrb } from "./AgentOrb.js";
import { ChatComposer } from "./ChatComposer.js";
import { useDismissable } from "./ui.js";

/** What the streamed run is doing right now, for the orb above the composer. */
export interface RunActivity {
  /** The stream is still open: the agent is in its sandbox. */
  running: boolean;
  /** The tool it is in, when known. */
  tool: string | null;
}

/**
 * The orb row the card conversation shows between the transcript and
 * the composer: the agent is still in its sandbox, and this is what it
 * is doing.
 */
export function WorkingRow({ activity, agentName }: { activity: RunActivity; agentName: string }) {
  if (!activity.running) return null;
  return (
    <div className="working-row" role="status">
      <AgentOrb tool={activity.tool} label={`${agentName} working`} />
      <span className="muted">{agentName} is working{activity.tool ? `: ${activity.tool}` : ""}</span>
    </div>
  );
}

/**
 * The same persisted run events as the board conversation, with no
 * composer. A caller that renders its own composer takes the activity
 * through onActivity and draws the orb row above it, the way the card
 * conversation does; one that does not gets the row at the foot of
 * the log.
 */
export function SwarmRunOutput({ client, runId, agentName, plannerMessages = [], onActivity }: {
  client: BentoClient;
  runId: string;
  agentName: string;
  plannerMessages?: SwarmPlannerMessage[];
  onActivity?: (activity: RunActivity) => void;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  /** The tool the agent is in, so the orb can say what kind of work it is. */
  const [tool, setTool] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const draftRef = useRef("");
  const chatRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const items = useMemo(() => toChatItems(events, agentName, runId, status === "running"), [events, agentName, runId, status]);
  const running = status === "running";
  useEffect(() => {
    onActivity?.({ running, tool });
  }, [onActivity, running, tool]);
  const earlierMessages = plannerMessages.filter((message) => message.runId && message.runId !== runId);
  const currentMessages = plannerMessages.filter((message) => message.runId === runId);
  const queuedMessages = plannerMessages.filter((message) => message.status === "queued");

  const readPosition = () => {
    const chat = chatRef.current;
    if (!chat || chat.clientHeight === 0) return;
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
    stickToBottom.current = atBottom;
    setScrolledUp(!atBottom);
  };

  const jumpToBottom = () => {
    const chat = chatRef.current;
    if (!chat) return;
    stickToBottom.current = true;
    setScrolledUp(false);
    chat.scrollTop = chat.scrollHeight;
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const chat = chatRef.current;
      if (!chat) return;
      if (stickToBottom.current) chat.scrollTop = chat.scrollHeight;
      readPosition();
    });
    return () => cancelAnimationFrame(frame);
  }, [items, draft, plannerMessages.length, error]);

  useEffect(() => {
    setEvents([]);
    setDraft("");
    setError("");
    setStatus("loading");
    setTool(null);
    lastSeq.current = 0;
    draftRef.current = "";
    stickToBottom.current = true;
    setScrolledUp(false);
    const stop = client.streamRun(runId, {
      onEvent: (event, seq) => {
        if (seq > 0 && seq <= lastSeq.current) return;
        if (seq > 0) lastSeq.current = seq;
        if (event.type === "result" || (event.type === "message" && event.role === "assistant")) {
          draftRef.current = "";
          setDraft("");
        }
        if (event.type === "tool") {
          if (event.phase === "start" && event.name !== "tool_result") setTool(event.name);
        } else {
          setTool(null);
        }
        setEvents((previous) => [...previous, event]);
        setStatus("running");
      },
      onDelta: (delta) => {
        if (delta.channel !== "text") return;
        if (delta.offset === 0) draftRef.current = delta.text;
        else if (delta.offset === draftRef.current.length) draftRef.current += delta.text;
        else return;
        setDraft(draftRef.current);
      },
      onDone: (next) => {
        setStatus(next);
        setDraft("");
      },
      onError: () => setError("Could not load this agent's output. Reopen it to try again."),
    });
    return stop;
  }, [client, runId]);

  return (
    <div className="swarm-run-output" aria-label={`${agentName} output`}>
      <div className="chat swarm-output-chat" ref={chatRef} onScroll={readPosition}>
        {earlierMessages.length > 0 && (
          <details className="swarm-planner-history">
            <summary>Earlier guidance ({earlierMessages.length})</summary>
            {earlierMessages.map((message) => <PlannerMessageRow key={message.id} message={message} />)}
          </details>
        )}
        {currentMessages.map((message) => <PlannerMessageRow key={message.id} message={message} />)}
        {error && <p className="error" role="alert">{error}</p>}
        {/* Nothing said yet and the agent is in its sandbox: the large
            orb, the way a card's conversation opens. */}
        {items.length === 0 && !draft && !error && running && (
          <div className="orb-hero" aria-label={`${agentName} is getting started`}>
            <AgentOrb hero label={`${agentName} working`} />
            <span className="muted">{agentName} is getting started...</span>
          </div>
        )}
        {items.length === 0 && !draft && !error && !running && <p className="muted">{status === "loading" ? "Waiting for agent output..." : "This run recorded no output."}</p>}
        {items.map((item) => <ChatRow key={item.key} item={item} showDetail={false} />)}
        {draft && <div className="chat-row chat-row-assistant"><div className="chat-bubble chat-bubble-assistant" data-draft><span className="chat-meta">{agentName}</span><span className="chat-text">{draft}</span></div></div>}
        {queuedMessages.map((message) => <PlannerMessageRow key={message.id} message={message} />)}
        {scrolledUp && (
          <div className="chat-jump-anchor">
            <button type="button" className="chat-jump" onClick={jumpToBottom}>Jump to latest ↓</button>
          </div>
        )}
      </div>
      {!onActivity && <WorkingRow activity={{ running, tool }} agentName={agentName} />}
    </div>
  );
}

function PlannerMessageRow({ message }: { message: SwarmPlannerMessage }) {
  const status = message.status === "queued" ? "Queued for the next turn" : message.status === "sent" ? "Sent to planner" : "Delivered";
  return (
    <div className="chat-row chat-row-user">
      <div className="chat-bubble chat-bubble-user" data-pending={message.status === "queued" || undefined}>
        <span className="chat-meta">You · {status}</span>
        <span className="chat-text">{message.text}</span>
      </div>
    </div>
  );
}

export function SwarmRunOutputDrawer({ client, api, swarmId, swarmStatus, runId, runStatus, runError, agentName, onMessageSent, onRetry, onStop, canRetry, busy, onClose }: {
  client: BentoClient;
  api: Pick<SwarmApi, "listPlannerMessages" | "messagePlanner">;
  swarmId: string;
  swarmStatus: SwarmStatus;
  runId: string;
  runStatus: string;
  runError?: string | null;
  agentName: string;
  onMessageSent: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  canRetry?: boolean;
  busy?: boolean;
  onClose: () => void;
}) {
  const panel = useDismissable<HTMLElement>(onClose);
  const [messages, setMessages] = useState<SwarmPlannerMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [activity, setActivity] = useState<RunActivity>({ running: false, tool: null });
  const failure = plannerFailure(runError ?? null);
  const canMessage = swarmStatus !== "done" && !(runStatus === "failed" && failure.beforeAgent);
  const plannerActive = ["queued", "starting", "running"].includes(runStatus);

  useEffect(() => {
    let cancelled = false;
    void api.listPlannerMessages(swarmId)
      .then((rows) => { if (!cancelled) setMessages(rows); })
      .catch(() => { if (!cancelled) setMessageError("Could not load planner messages. Reopen this panel to try again."); });
    return () => { cancelled = true; };
  }, [api, swarmId, runId]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setMessageError("");
    try {
      const message = await api.messagePlanner(swarmId, body);
      setMessages((current) => current.some((row) => row.id === message.id) ? current : [...current, message]);
      setText("");
      onMessageSent();
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  }

  const helper = swarmStatus === "paused"
    ? "Your message waits until the swarm resumes."
    : runStatus === "running"
      ? "Your message reaches the planner when its current turn ends."
      : runStatus === "queued" || runStatus === "starting"
        ? "Your message waits for this planner run to start."
        : "Your message starts another planner turn.";
  return (
    <aside className="drawer swarm-output-drawer" role="dialog" aria-label={`${agentName} conversation`} ref={panel}>
      <header className="drawer-head">
        <div className="feature-topline">
          <span className="feature-kicker">Planner conversation</span>
          <button className="btn btn-ghost swarm-output-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><span aria-hidden="true">×</span></button>
        </div>
        <h2 className="drawer-title">{agentName}</h2>
      </header>
      <div className="drawer-body">
        {runStatus === "failed" && (
          <section className="swarm-failure-detail" role="status">
            <strong>{failure.title}</strong>
            <p>{failure.summary} {failure.beforeAgent ? "The agent did not start." : "Review its output before retrying."}</p>
            {canRetry && onRetry && <button className="btn btn-primary" type="button" disabled={busy} onClick={onRetry}>Retry planner</button>}
            {runError && <details><summary>Technical details</summary><pre>{runError}</pre></details>}
          </section>
        )}
        <SwarmRunOutput client={client} runId={runId} agentName={agentName} plannerMessages={messages} onActivity={setActivity} />
      </div>
      {canMessage && (
        <div className="swarm-planner-compose composer-dock">
          <WorkingRow activity={activity} agentName={agentName} />
          {messageError && <p className="error" role="alert">{messageError}</p>}
          <ChatComposer
            id="swarm-planner-message"
            value={text}
            onChange={setText}
            onSend={() => void send()}
            onStop={plannerActive && onStop && !busy ? onStop : undefined}
            busy={sending}
            maxLength={20_000}
            placeholder="Give feedback or ask for a change to the plan"
            ariaLabel="Message the planner"
          />
          <p className="muted composer-hint">{helper}</p>
        </div>
      )}
    </aside>
  );
}

export function SwarmWorkerOutputDrawer({ client, runId, taskTitle, onClose }: {
  client: BentoClient;
  runId: string;
  taskTitle: string;
  onClose: () => void;
}) {
  const panel = useDismissable<HTMLElement>(onClose);
  return (
    <aside className="drawer swarm-output-drawer" role="dialog" aria-label="Worker logs" ref={panel}>
      <header className="drawer-head">
        <div className="feature-topline">
          <span className="feature-kicker">Worker logs</span>
          <button className="btn btn-ghost swarm-output-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><span aria-hidden="true">×</span></button>
        </div>
        <h2 className="drawer-title">Worker agent</h2>
        <p className="swarm-output-task-title">{taskTitle}</p>
      </header>
      <div className="drawer-body"><SwarmRunOutput client={client} runId={runId} agentName="Worker agent" /></div>
    </aside>
  );
}
