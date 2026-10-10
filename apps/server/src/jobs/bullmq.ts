import { Queue, Worker, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { JobCounts, JobQueue, QueueName, SendOptions, WorkOptions } from "./types.js";

/** pg-boss 10 default retryLimit is 2, so 3 attempts including the first. */
export const DEFAULT_ATTEMPTS = 3;

export function bullMqPrefix(environment: string): string {
  return `bento:${environment}`;
}

export function bullMqJobId(kind: "dedupe" | "coalesce" | "debounce", key: string): string {
  // BullMQ forbids `:` in custom job ids. encodeURIComponent keeps the
  // id a pure function of the caller key for any durable row id.
  return `${kind}__${encodeURIComponent(key)}`;
}

export function bullMqRerunKey(prefix: string, queue: QueueName, key: string): string {
  return `${prefix}:rerun:${queue}:${key}`;
}

export function bullMqRerunPayloadKey(prefix: string, queue: QueueName, key: string): string {
  return `${prefix}:rerun-payload:${queue}:${key}`;
}

export function bullMqSchedulerMapKey(prefix: string, id: string): string {
  return `${prefix}:scheduler:${id}`;
}

export interface BullMqQueueOptions {
  redisUrl: string;
  /** `BENTO_ENVIRONMENT`: development and production share one Redis safely. */
  environment: string;
}

/**
 * BullMQ as a JobQueue for multi mode.
 *
 * Local, desktop, TUI and Mac keep PgBossQueue and never construct this.
 * Job ids and rerun flags are functions of the environment prefix plus
 * the caller key, so a new process (or a Redis AOF replay) finds the
 * same identities.
 */
export class BullMqQueue implements JobQueue {
  readonly kind = "bullmq" as const;
  private readonly prefix: string;
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly workerConnections: Redis[] = [];
  private stopped = false;

  constructor(opts: BullMqQueueOptions) {
    this.prefix = bullMqPrefix(opts.environment);
    this.connection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
  }

  async send<T>(queue: QueueName, data: T, opts?: SendOptions): Promise<void> {
    this.assertOpen();
    const q = await this.queue(queue);
    const payload = asJobData(data);
    const jobOpts = this.jobOpts(opts);
    if (opts?.coalesceKey) {
      await this.sendCoalesce(q, queue, payload, opts.coalesceKey, jobOpts);
      return;
    }
    if (opts?.dedupeKey) {
      await this.sendKeyed(q, payload, bullMqJobId("dedupe", opts.dedupeKey), jobOpts);
      return;
    }
    if (opts?.debounceKey) {
      await this.sendDebounce(q, payload, opts.debounceKey, jobOpts);
      return;
    }
    await q.add("job", payload, jobOpts);
  }

  async work<T>(queue: QueueName, opts: WorkOptions, handler: (data: T) => Promise<void>): Promise<void> {
    this.assertOpen();
    await this.queue(queue);
    const connection = this.connection.duplicate();
    this.workerConnections.push(connection);
    const worker = new Worker(
      queue,
      async (job) => {
        await handler(job.data as T);
      },
      {
        connection,
        prefix: this.prefix,
        // One Worker, not one process per slot. batchSize is the
        // pg-boss poll width; without an explicit concurrency it is
        // how many jobs this Worker runs at once (gate.evaluate: 5).
        concurrency: Math.max(1, opts.concurrency ?? opts.batchSize ?? 1),
      },
    );
    worker.on("completed", (job) => {
      void this.maybeRerun(queue, job.id, job.data);
    });
    worker.on("failed", (job) => {
      if (!job) return;
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.maybeRerun(queue, job.id, job.data);
      }
    });
    this.workers.push(worker);
    await worker.waitUntilReady();
  }

  async schedule(id: string, queue: QueueName, cron: string, data?: unknown): Promise<void> {
    this.assertOpen();
    const q = await this.queue(queue);
    await q.upsertJobScheduler(id, { pattern: cron }, { name: "job", data: asJobData(data ?? {}) });
    await this.connection.set(bullMqSchedulerMapKey(this.prefix, id), queue);
  }

  async unschedule(id: string): Promise<void> {
    this.assertOpen();
    const mapped = await this.connection.get(bullMqSchedulerMapKey(this.prefix, id));
    if (!mapped) return;
    const q = await this.queue(mapped as QueueName);
    await q.removeJobScheduler(id);
    await this.connection.del(bullMqSchedulerMapKey(this.prefix, id));
  }

  async counts(queue: QueueName): Promise<JobCounts> {
    this.assertOpen();
    const q = await this.queue(queue);
    const raw = await q.getJobCounts("wait", "active", "delayed");
    return {
      waiting: raw.wait ?? 0,
      active: raw.active ?? 0,
      delayed: raw.delayed ?? 0,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all(this.workerConnections.map((conn) => conn.quit()));
    await this.connection.quit();
  }

  wake(_queue: QueueName): void {
    // BullMQ hands a job over as soon as it is added.
  }

  async offWork(_queue: QueueName): Promise<void> {
    // Closing a Worker from inside its own processor deadlocks. Idle
    // workers cost Redis nothing, so lazy offWork is a no-op here.
  }

  private async sendCoalesce(
    q: Queue,
    queue: QueueName,
    data: object,
    key: string,
    jobOpts: JobsOptions,
  ): Promise<void> {
    const jobId = bullMqJobId("coalesce", key);
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active") {
        await this.markRerun(queue, key, data);
        const again = await existing.getState();
        if (again !== "active" && again !== "waiting" && again !== "delayed") {
          await this.consumeRerun(q, queue, key, data, jobOpts);
        }
        return;
      }
      if (state === "waiting" || state === "delayed") return;
      await existing.remove().catch(() => {});
    }
    await q.add("job", data, { ...jobOpts, jobId });
  }

  private async sendKeyed(q: Queue, data: object, jobId: string, jobOpts: JobsOptions): Promise<void> {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed" || state === "unknown") {
        await existing.remove().catch(() => {});
      } else {
        return;
      }
    }
    await q.add("job", data, { ...jobOpts, jobId });
  }

  private async sendDebounce(q: Queue, data: object, key: string, jobOpts: JobsOptions): Promise<void> {
    const jobId = bullMqJobId("debounce", key);
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active") return;
      await existing.remove().catch(() => {});
    }
    await q.add("job", data, { ...jobOpts, jobId });
  }

  private async markRerun(queue: QueueName, key: string, data: object): Promise<void> {
    await this.connection.set(bullMqRerunKey(this.prefix, queue, key), "1");
    await this.connection.set(bullMqRerunPayloadKey(this.prefix, queue, key), JSON.stringify(data));
  }

  private async maybeRerun(queue: QueueName, jobId: string | undefined, fallback: unknown): Promise<void> {
    if (!jobId?.startsWith("coalesce__")) return;
    const key = decodeURIComponent(jobId.slice("coalesce__".length));
    const q = await this.queue(queue);
    await this.consumeRerun(q, queue, key, asJobData(fallback), this.jobOpts());
  }

  private async consumeRerun(
    q: Queue,
    queue: QueueName,
    key: string,
    fallback: object,
    jobOpts: JobsOptions,
  ): Promise<void> {
    const taken = await this.connection.getdel(bullMqRerunKey(this.prefix, queue, key));
    if (!taken) return;
    const raw = await this.connection.getdel(bullMqRerunPayloadKey(this.prefix, queue, key));
    const data = raw ? (JSON.parse(raw) as object) : fallback;
    await q.add("job", data, { ...jobOpts, jobId: bullMqJobId("coalesce", key) });
  }

  private jobOpts(opts?: SendOptions): JobsOptions {
    const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
    return {
      attempts,
      removeOnComplete: true,
      removeOnFail: true,
      ...(opts?.delayMs !== undefined ? { delay: opts.delayMs } : {}),
      ...(opts?.backoffMs !== undefined
        ? { backoff: { type: "exponential" as const, delay: opts.backoffMs } }
        : {}),
    };
  }

  private async queue(name: QueueName): Promise<Queue> {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: {
          attempts: DEFAULT_ATTEMPTS,
          removeOnComplete: true,
          removeOnFail: true,
        },
      });
      this.queues.set(name, q);
      await q.waitUntilReady();
    }
    return q;
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("BullMqQueue is stopped");
  }
}

function asJobData<T>(data: T): object {
  if (data !== null && typeof data === "object") return data as object;
  return { value: data };
}
