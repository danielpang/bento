import { EventEmitter } from "node:events";
import type { AgentDelta, AgentEvent } from "@bento/core";

export interface RunEventEnvelope {
  runId: string;
  seq: number;
  event: AgentEvent;
}

export interface BoardEvent {
  type: "feature_updated" | "run_updated" | "run_output";
  projectId: string;
  featureId: string;
  runId?: string;
  status?: string;
  currentStageId?: string | null;
  /** For run_output: the agent's latest line, truncated for a card. */
  text?: string;
}

/**
 * What travels between server processes when the bus is replicated
 * (see pg-bus.ts). A run_event carries only its coordinates: the row
 * is already persisted by the time it is emitted, payloads can exceed
 * the NOTIFY size limit, and a receiver with no viewer for that run
 * should not pay to move the bytes at all. Everything else is small
 * and loss-tolerant, so it travels inline.
 */
export type BusWirePayload =
  | { kind: "run_event"; runId: string; seq: number }
  | { kind: "run_delta"; runId: string; delta: AgentDelta }
  | { kind: "run_done"; runId: string; status: string }
  | { kind: "board"; event: BoardEvent };

/**
 * Fan-out from the orchestrator to SSE subscribers.
 *
 * Delivery is in-process (an EventEmitter), and every emit also hands
 * a wire payload to the publisher, if one is attached, so a second
 * server process can deliver the same event to its own subscribers.
 * The deliver* methods are the receiving half: local bookkeeping and
 * emit, without republishing, so a replicated event cannot echo.
 * Without a publisher this collapses to the plain single-process bus.
 */
export class EventBus {
  private emitter = new EventEmitter();
  /**
   * The message each run is composing right now, accumulated from its
   * text fragments. Exists because fragments are fire-and-forget: a
   * viewer that subscribes mid message missed the head of the draft
   * forever, and on a fast driver the subscription reliably loses that
   * race even when the page was open before the run began. The
   * snapshot lets the stream start a late subscriber from the whole
   * draft. Text only: thinking fragments are a sign of life, not a
   * draft, and accumulating them here built kilobyte strings nothing
   * ever read. Cleared when the finished message lands and when the
   * run ends, so it holds at most one in-flight message per active
   * run.
   */
  private runDrafts = new Map<string, string>();

  private publisher: ((payload: BusWirePayload) => void) | undefined;

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  /**
   * Attaches the cross-process side. The publisher must not throw:
   * it is called synchronously inside every emit, on paths that have
   * already persisted their event and must not fail after the fact.
   */
  setPublisher(publisher: (payload: BusWirePayload) => void): void {
    this.publisher = publisher;
  }

  emitRunEvent(envelope: RunEventEnvelope): void {
    this.deliverRunEvent(envelope);
    this.publisher?.({ kind: "run_event", runId: envelope.runId, seq: envelope.seq });
  }

  /** Local delivery of a run event, whether emitted here or replicated. */
  deliverRunEvent(envelope: RunEventEnvelope): void {
    /**
     * The persisted message supersedes the fragments that previewed
     * it; a draft kept past this point would replay as a duplicate.
     *
     * Assistant messages and results only. A user or system line
     * (a steer delivered mid turn, a progress note) says nothing
     * about the message the agent is still composing, and clearing on
     * it desynchronized this map from runAgent's offset counter: the
     * next fragment rebuilt the draft from mid sentence and every
     * late subscriber received the tail stamped as a whole message.
     */
    if (
      envelope.event.type === "result"
      || (envelope.event.type === "message" && envelope.event.role === "assistant")
    ) {
      this.runDrafts.delete(envelope.runId);
    }
    this.emitter.emit(`run:${envelope.runId}`, envelope);
  }

  onRunEvent(runId: string, listener: (envelope: RunEventEnvelope) => void): () => void {
    const key = `run:${runId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  /**
   * Streaming fragments of the message the agent is composing. Bus
   * only, never the database: a fragment missed is a fragment gone,
   * and that is fine, because the finished message follows as a
   * persisted run event. Late subscribers see nothing and lose
   * nothing.
   */
  emitRunDelta(runId: string, delta: AgentDelta): void {
    this.deliverRunDelta(runId, delta);
    this.publisher?.({ kind: "run_delta", runId, delta });
  }

  /**
   * Local delivery of a delta. Runs the draft bookkeeping even with
   * no listener: it is what lets a viewer subscribe on this process
   * mid message and still receive the whole draft, when the run is
   * executing on another process entirely.
   */
  deliverRunDelta(runId: string, delta: AgentDelta): void {
    if (delta.channel === "text") {
      const current = this.runDrafts.get(runId) ?? "";
      if (delta.offset === 0) this.runDrafts.set(runId, delta.text);
      else if (delta.offset === current.length) this.runDrafts.set(runId, current + delta.text);
      // A gap means this draft lost its head somewhere; refusing to
      // snapshot a torn draft beats serving one as authoritative. The
      // stream recovers at the next message's offset zero.
      else this.runDrafts.delete(runId);
    }
    this.emitter.emit(`run_delta:${runId}`, delta);
  }

  onRunDelta(runId: string, listener: (delta: AgentDelta) => void): () => void {
    const key = `run_delta:${runId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  /** The in-flight message so far, for a subscriber arriving mid stream. */
  runDraft(runId: string): string | undefined {
    return this.runDrafts.get(runId);
  }

  /**
   * Drops a run's draft without signalling anything. For the crash
   * path: a run whose executor threw outside its own error handling
   * never reaches a terminal event, and without this its entry would
   * sit in the map for the life of the process.
   */
  dropRunDraft(runId: string): void {
    this.runDrafts.delete(runId);
  }

  /**
   * Signals that a run reached a terminal status. Streams listen for
   * this instead of polling the database to notice the run ended.
   */
  emitRunDone(runId: string, status: string): void {
    this.deliverRunDone(runId, status);
    this.publisher?.({ kind: "run_done", runId, status });
  }

  deliverRunDone(runId: string, status: string): void {
    this.runDrafts.delete(runId);
    this.emitter.emit(`run_done:${runId}`, status);
  }

  onRunDone(runId: string, listener: (status: string) => void): () => void {
    this.emitter.on(`run_done:${runId}`, listener);
    return () => this.emitter.off(`run_done:${runId}`, listener);
  }

  emitBoardEvent(event: BoardEvent): void {
    this.deliverBoardEvent(event);
    this.publisher?.({ kind: "board", event });
  }

  deliverBoardEvent(event: BoardEvent): void {
    this.emitter.emit(`board:${event.projectId}`, event);
  }

  onBoardEvent(projectId: string, listener: (event: BoardEvent) => void): () => void {
    const key = `board:${projectId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  /**
   * Whether any stream on this process is watching the run. The
   * replication listener asks before fetching a replicated run
   * event's payload, so a process with no viewer for the run does
   * zero queries for it.
   */
  hasRunEventListeners(runId: string): boolean {
    return this.emitter.listenerCount(`run:${runId}`) > 0;
  }

  /**
   * Signals that this process may have missed replicated events: the
   * LISTEN connection dropped and has just come back. Run streams
   * answer by re-querying past their last written seq, the same
   * catch-up they run at open. Local only, never published.
   */
  emitResync(): void {
    this.emitter.emit("resync");
  }

  onResync(listener: () => void): () => void {
    this.emitter.on("resync", listener);
    return () => this.emitter.off("resync", listener);
  }
}
