import { EventEmitter } from "node:events";
import type { AgentEvent } from "@bento/core";

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

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  emitRunEvent(envelope: RunEventEnvelope): void {
    this.emitter.emit(`run:${envelope.runId}`, envelope);
  }

  onRunEvent(runId: string, listener: (envelope: RunEventEnvelope) => void): () => void {
    const key = `run:${runId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  /**
   * Signals that a run reached a terminal status. Streams listen for
   * this instead of polling the database to notice the run ended.
   */
  emitRunDone(runId: string, status: string): void {
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
