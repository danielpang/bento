/**
 * The queue names this process sends and works.
 *
 * A typo is a compile error. `previews` is reserved for the App
 * Previews plan and is unused until that work lands.
 */
export const QUEUE_NAMES = [
  "run.execute",
  "gate.evaluate",
  "gate.sweep",
  "runner.reap",
  "run.queue-snapshot",
  "sandbox.reap",
  "sandbox.hibernate",
  "sandbox.modal-sweep",
  "swarm.tick",
  "swarm.land",
  "swarm.publish",
  "swarm.push",
  "swarm.task-start-over",
  "swarm.watchdog",
  "linear.backlog-sync",
  "linear.inbound",
  "linear.outbound",
  "linear.create-issue",
  "linear.sweep",
  "slack.inbound",
  "slack.notify",
  "previews",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Queues whose send coalesces: at most one waiting job per key, and a
 * job that is already running does not swallow the next send. pg-boss
 * "short" plus singletonKey; BullMQ coalesceKey plus a rerun flag.
 */
export const COALESCE_QUEUES = new Set<QueueName>(["swarm.tick", "swarm.land", "swarm.push", "swarm.task-start-over"]);

export interface SendOptions {
  /** pg-boss startAfter · BullMQ delay. */
  delayMs?: number;
  /** One job per key until it finishes. */
  dedupeKey?: string;
  /** One waiting job per key; a send during a run queues one rerun. */
  coalesceKey?: string;
  /** Replace a waiting delayed job and push its delay back. */
  debounceKey?: string;
  /** Total attempts, including the first. Both backends retry the same way. */
  attempts?: number;
  backoffMs?: number;
}

export interface WorkOptions {
  /**
   * Independent workers on this process. `run.execute` uses one per
   * concurrent slot so a long agent run does not hold the others idle.
   */
  concurrency?: number;
  /** Jobs fetched per poll. Gate evaluation uses 5; most queues use 1. */
  batchSize?: number;
  pollingIntervalSeconds?: number;
}

export interface JobCounts {
  waiting: number;
  active: number;
  delayed: number;
}

/**
 * The queue this process talks to.
 *
 * Payloads carry durable row ids. Callers receive no backend job id.
 * `wake` and `offWork` exist so Phase 0 can keep pg-boss's slow-poll
 * run workers and lazy swarm workers; BullMQ will no-op them.
 */
export interface JobQueue {
  send<T>(queue: QueueName, data: T, opts?: SendOptions): Promise<void>;
  work<T>(queue: QueueName, opts: WorkOptions, handler: (data: T) => Promise<void>): Promise<void>;
  schedule(id: string, queue: QueueName, cron: string, data?: unknown): Promise<void>;
  unschedule(id: string): Promise<void>;
  counts(queue: QueueName): Promise<JobCounts>;
  stop(): Promise<void>;
  /**
   * Nudges idle workers on `queue` so a just-sent job does not wait
   * for the next poll. pg-boss run workers poll every 30s; enqueueRun
   * wakes them. A queue with no workers is a no-op.
   */
  wake(queue: QueueName): void;
  /** Stops this process's worker on `queue`. Used by lazy swarm workers. */
  offWork(queue: QueueName): Promise<void>;
}
