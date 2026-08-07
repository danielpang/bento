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
 * In-process fan-out from the orchestrator to SSE subscribers.
 * The server is a single process today; when it grows to multiple
 * processes, back this with Postgres LISTEN/NOTIFY.
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

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  emitRunEvent(envelope: RunEventEnvelope): void {
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
    this.runDrafts.delete(runId);
    this.emitter.emit(`run_done:${runId}`, status);
  }

  onRunDone(runId: string, listener: (status: string) => void): () => void {
    this.emitter.on(`run_done:${runId}`, listener);
    return () => this.emitter.off(`run_done:${runId}`, listener);
  }

  emitBoardEvent(event: BoardEvent): void {
    this.emitter.emit(`board:${event.projectId}`, event);
  }

  onBoardEvent(projectId: string, listener: (event: BoardEvent) => void): () => void {
    const key = `board:${projectId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
