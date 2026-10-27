import { isSandboxCapacityError } from "@bento/core";
import { CapacityNotice } from "./CapacityNotice.js";
import { Fragment, useEffect, useRef, useState } from "react";
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
        <PlannerHistory client={client} runIds={historyRunIds} agentName={agentName}
          messagesFor={(id) => messagesFor(id) ?? []}
          onLoaded={() => {
            const chat = chatRef.current;
            if (chat && stickToBottom.current) chat.scrollTop = chat.scrollHeight;
          }} />
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

const EARLIEST_SEQ = 2_147_483_647;

type HistoryPage = { events: RecordedRunEvent[]; firstSeq: number | null; earlier: number };
type HistorySlot =
  | { status: "loading" }
  | { status: "error"; page: HistoryPage | null }
  | { status: "ready"; page: HistoryPage; loadingEarlier: boolean };

/**
 * One loading line and one failure line for the whole earlier history.
 * Each run used to announce its own, so a long history was a stack of
 * the same sentence. A run that already failed keeps its Try again
 * while another read is still in flight: that read can stall, and the
 * failure would otherwise have no retry.
 */
export function EarlierPlannerNotice({ pending, failed, onRetry }: {
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  if (!pending && !failed) return null;
  return <>
    {failed && (
      <p className="error" role="alert">
        Could not load earlier planner output. <button type="button" className="btn btn-ghost" onClick={onRetry}>Try again</button>
      </p>
    )}
    {pending && <p className="muted">Loading earlier planner output...</p>}
  </>;
}

/** Finished runs use paged reads, never another live stream. */
function PlannerHistory({ client, runIds, agentName, messagesFor, onLoaded }: {
  client: BentoClient;
  runIds: string[];
  agentName: string;
  messagesFor: (id: string) => SwarmPlannerMessage[];
  onLoaded: () => void;
}) {
  const [slots, setSlots] = useState<Record<string, HistorySlot>>({});
  const [attempt, setAttempt] = useState(0);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const idsKey = runIds.join("\0");
  // Every in-flight read. Aborted when the drawer goes away, so a late
  // answer cannot land on an unmounted history.
  const liveReads = useRef(new Set<AbortController>());
  // A second click before the next paint still sees the old slot. The
  // set closes that gap, or the same page is prepended twice.
  const earlierReads = useRef(new Set<string>());
  useEffect(() => () => {
    for (const controller of liveReads.current) controller.abort();
    liveReads.current.clear();
  }, []);

  useEffect(() => {
    const ids = idsKey ? idsKey.split("\0") : [];
    // A run that already has a page keeps it. Retrying the first page
    // would drop lines the reader had already pulled in.
    const todo = ids.filter((id) => {
      const slot = slotsRef.current[id];
      return !slot || slot.status === "loading" || (slot.status === "error" && !slot.page);
    });
    if (todo.length === 0) return;
    const controller = new AbortController();
    liveReads.current.add(controller);
    setSlots((current) => {
      const next = { ...current };
      for (const id of todo) next[id] = { status: "loading" };
      return next;
    });
    for (const id of todo) {
      void client.getEventsBefore(id, EARLIEST_SEQ, 200, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setSlots((current) => ({ ...current, [id]: { status: "ready", page: result, loadingEarlier: false } }));
        requestAnimationFrame(() => { if (!controller.signal.aborted) onLoadedRef.current(); });
      }).catch(() => {
        if (controller.signal.aborted) return;
        setSlots((current) => ({ ...current, [id]: { status: "error", page: null } }));
      });
    }
    return () => {
      controller.abort();
      liveReads.current.delete(controller);
    };
  }, [client, idsKey, attempt]);

  async function loadEarlier(id: string) {
    const slot = slotsRef.current[id];
    const page = pageOf(slot);
    if (!page?.firstSeq || earlierReads.current.has(id) || (slot?.status === "ready" && slot.loadingEarlier)) return;
    const cursor = page.firstSeq;
    earlierReads.current.add(id);
    const controller = new AbortController();
    liveReads.current.add(controller);
    setSlots((current) => {
      const base = pageOf(current[id]);
      if (!base || base.firstSeq !== cursor) return current;
      return { ...current, [id]: { status: "ready", page: base, loadingEarlier: true } };
    });
    try {
      const earlier = await client.getEventsBefore(id, cursor, 200, controller.signal);
      if (controller.signal.aborted) return;
      setSlots((current) => {
        const base = pageOf(current[id]);
        // The cursor moved: a newer read already took this page.
        if (!base || base.firstSeq !== cursor) return current;
        return { ...current, [id]: { status: "ready", loadingEarlier: false, page: { ...earlier, events: [...earlier.events, ...base.events] } } };
      });
    } catch {
      if (controller.signal.aborted) return;
      setSlots((current) => {
        const base = pageOf(current[id]);
        if (!base || base.firstSeq !== cursor) return current;
        return { ...current, [id]: { status: "error", page: base } };
      });
    } finally {
      earlierReads.current.delete(id);
      liveReads.current.delete(controller);
    }
  }

  function retry() {
    const refetchEarlier = runIds.filter((id) => {
      const slot = slotsRef.current[id];
      return slot?.status === "error" && Boolean(slot.page?.firstSeq);
    });
    for (const id of refetchEarlier) void loadEarlier(id);
    const needsFirstPage = runIds.some((id) => {
      const slot = slotsRef.current[id];
      return !slot || slot.status === "loading" || (slot.status === "error" && !slot.page);
    });
    if (needsFirstPage) setAttempt((value) => value + 1);
  }

  if (runIds.length === 0) return null;
  const pending = runIds.some((id) => slots[id]?.status !== "ready" && slots[id]?.status !== "error");
  const failed = runIds.some((id) => slots[id]?.status === "error");
  return <>
    <EarlierPlannerNotice pending={pending} failed={failed} onRetry={retry} />
    {runIds.map((id) => {
      const slot = slots[id];
      const page = pageOf(slot);
      const loadingEarlier = slot?.status === "ready" && slot.loadingEarlier;
      return (
        <Fragment key={id}>
          {page && page.earlier > 0 && (
            <button type="button" className="btn btn-ghost" disabled={loadingEarlier} onClick={() => void loadEarlier(id)}>
              {loadingEarlier ? "Loading..." : "Load earlier output"}
            </button>
          )}
          <RunConversationRows events={page?.events ?? []} runId={id} agentName={agentName} messages={messagesFor(id)} />
        </Fragment>
      );
    })}
  </>;
}

function pageOf(slot: HistorySlot | undefined): HistoryPage | null {
  if (!slot || slot.status === "loading") return null;
  return slot.page;
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
