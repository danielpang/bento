import { isSandboxCapacityError } from "@bento/core";
import { CapacityNotice } from "./CapacityNotice.js";
import { useEffect, useRef, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import type { RecordedRunEvent } from "@bento/core";
import type { SwarmApi, SwarmPlannerMessage } from "../swarm/client.js";
import type { SwarmPlannerHistoryRun, SwarmStatus } from "../swarm/types.js";
import { plannerConversationEvents, plannerMessageRun } from "../swarm/planner-conversation.js";
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
export function SwarmRunOutput({ client, runId, agentName, plannerMessages, plannerRuns, onActivity, onPlannerInput }: {
  client: BentoClient;
  runId: string;
  agentName: string;
  plannerMessages?: SwarmPlannerMessage[];
  plannerRuns?: SwarmPlannerHistoryRun[];
  onActivity?: (activity: RunActivity) => void;
  onPlannerInput?: () => void;
}) {
  const [events, setEvents] = useState<RecordedRunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  /** The tool the agent is in, so the orb can say what kind of work it is. */
  const [tool, setTool] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const draftRef = useRef("");
  const onPlannerInputRef = useRef(onPlannerInput);
  onPlannerInputRef.current = onPlannerInput;
  const chatRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const hasOutput = events.some((event) => event.type !== "init");
  const running = status === "running";
  useEffect(() => {
    onActivity?.({ running, tool });
  }, [onActivity, running, tool]);
  // Older servers have no run list. Message bindings still recover the
  // runs people spoke to, without putting their guidance in a separate UI.
  const historyRunIds = [...new Set(plannerRuns?.map((run) => run.id) ?? plannerMessages?.flatMap((message) => message.runId ? [message.runId] : []) ?? [])]
    .filter((id) => id !== runId);
  const messagesFor = (id: string) => plannerMessages?.filter((message) => plannerMessageRun(message, plannerRuns, runId) === id);

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
  }, [events, draft, plannerMessages, error]);

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
        if (event.type === "message" && event.role === "user") onPlannerInputRef.current?.();
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
        {historyRunIds.map((id) => (
          <PlannerRunHistory key={id} client={client} runId={id} agentName={agentName}
            messages={messagesFor(id) ?? []}
            onLoaded={() => {
              const chat = chatRef.current;
              if (chat && stickToBottom.current) chat.scrollTop = chat.scrollHeight;
            }} />
        ))}
        <RunConversationRows events={events} runId={runId} agentName={agentName} messages={messagesFor(runId)} running={running} />
        {error && <p className="error" role="alert">{error}</p>}
        {/* Nothing said yet and the agent is in its sandbox: the large
            orb, the way a card's conversation opens. */}
        {!hasOutput && !draft && !error && running && (
          <div className="orb-hero" aria-label={`${agentName} is getting started`}>
            <AgentOrb hero label={`${agentName} working`} />
            <span className="muted">{agentName} is getting started...</span>
          </div>
        )}
        {!hasOutput && !draft && !error && !running && <p className="muted">{status === "loading" ? "Waiting for agent output..." : "This run recorded no output."}</p>}
        {draft && <div className="chat-row chat-row-assistant"><div className="chat-bubble chat-bubble-assistant" data-draft><span className="chat-meta">{agentName}</span><span className="chat-text">{draft}</span></div></div>}
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

/** Guidance and replies share the same transcript, including across runs. */
export function RunConversationRows({ events, runId, agentName, messages, running = false }: {
  events: RecordedRunEvent[];
  runId: string;
  agentName: string;
  messages?: SwarmPlannerMessage[];
  running?: boolean;
}) {
  const conversation = messages ? plannerConversationEvents(events, messages) : null;
  let nextMessage = 0;
  return <>{toChatItems(conversation?.events ?? events, agentName, runId, running).map((item) => {
    const message = conversation && item.kind === "message" && item.role === "user" ? conversation.messages[nextMessage++] : null;
    return message
      ? <PlannerMessageRow key={message.id} message={message} />
      : <ChatRow key={item.key} item={item} showDetail={false} />;
  })}</>;
}

/** Finished runs use paged reads, never another live stream. */
function PlannerRunHistory({ client, runId, agentName, messages, onLoaded }: {
  client: BentoClient;
  runId: string;
  agentName: string;
  messages: SwarmPlannerMessage[];
  onLoaded: () => void;
}) {
  const [page, setPage] = useState<{ events: RecordedRunEvent[]; firstSeq: number | null; earlier: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  useEffect(() => {
    let cancelled = false;
    setError(false);
    void client.getEventsBefore(runId, 2_147_483_647).then((result) => {
      if (!cancelled) {
        setPage(result);
        requestAnimationFrame(() => { if (!cancelled) onLoadedRef.current(); });
      }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [client, runId, attempt]);

  async function loadEarlier() {
    if (!page?.firstSeq || loading) return;
    setLoading(true);
    setError(false);
    try {
      const earlier = await client.getEventsBefore(runId, page.firstSeq);
      setPage({ ...earlier, events: [...earlier.events, ...page.events] });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  return <>
    {error && <p className="error" role="alert">Could not load earlier planner output. <button type="button" className="btn btn-ghost" onClick={() => page ? void loadEarlier() : setAttempt((value) => value + 1)}>Try again</button></p>}
    {!page && !error && <p className="muted">Loading earlier planner output...</p>}
    {page && page.earlier > 0 && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void loadEarlier()}>{loading ? "Loading..." : "Load earlier output"}</button>}
    <RunConversationRows events={page?.events ?? []} runId={runId} agentName={agentName} messages={messages} />
  </>;
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

export function SwarmRunOutputDrawer({ client, api, swarmId, swarmStatus, runId, plannerRuns, runStatus, runError, agentName, onMessageSent, onRetry, onStop, canRetry, busy, onClose }: {
  client: BentoClient;
  api: Pick<SwarmApi, "listPlannerMessages" | "messagePlanner">;
  swarmId: string;
  swarmStatus: SwarmStatus;
  runId: string;
  plannerRuns?: SwarmPlannerHistoryRun[];
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
  const [messageVersion, setMessageVersion] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A held planner can receive guidance from another viewer without a
  // new run. Refresh on its recorded input, coalescing a replay's burst.
  const refreshMessages = () => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setMessageVersion((value) => value + 1);
    }, 100);
  };
  useEffect(() => () => { if (refreshTimer.current !== null) clearTimeout(refreshTimer.current); }, []);
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
      .then((rows) => {
        if (!cancelled) setMessages((current) => [...rows, ...current.filter((message) => !rows.some((row) => row.id === message.id))]);
      })
      .catch(() => { if (!cancelled) setMessageError("Could not load planner messages. Reopen this panel to try again."); });
    return () => { cancelled = true; };
  }, [api, swarmId, runId, messageVersion]);

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
        {runStatus === "failed" && (isSandboxCapacityError(runError) ? (
          <CapacityNotice context="planner" busy={busy} onRetry={canRetry ? onRetry : undefined} />
        ) : (
          <section className="swarm-failure-detail" role="status">
            <strong>{failure.title}</strong>
            <p>{failure.summary} {failure.beforeAgent ? "The agent did not start." : "Review its output before retrying."}</p>
            {canRetry && onRetry && <button className="btn btn-primary" type="button" disabled={busy} onClick={onRetry}>Retry planner</button>}
            {runError && <details><summary>Technical details</summary><pre>{runError}</pre></details>}
          </section>
        ))}
        <SwarmRunOutput client={client} runId={runId} agentName={agentName} plannerMessages={messages} plannerRuns={plannerRuns} onActivity={setActivity} onPlannerInput={refreshMessages} />
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
