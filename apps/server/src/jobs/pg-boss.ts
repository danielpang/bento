import { createHash } from "node:crypto";
import type PgBoss from "pg-boss";
import { COALESCE_QUEUES, type JobCounts, type JobQueue, type QueueName, type SendOptions, type WorkOptions } from "./types.js";

/**
 * pg-boss as a JobQueue.
 *
 * Local, desktop, TUI and self-hosted installs keep this adapter, so
 * they need no Redis. Dedupe and debounce use a stable job id because
 * standard-policy singletonKey is not unique in pg-boss 10.
 */
export class PgBossQueue implements JobQueue {
  readonly kind = "pg-boss" as const;
  private readonly created = new Set<QueueName>();
  private readonly workersByQueue = new Map<QueueName, string[]>();
  private stopped = false;

  constructor(private readonly boss: PgBoss) {}

  async send<T>(queue: QueueName, data: T, opts?: SendOptions): Promise<void> {
    this.assertOpen();
    await this.ensureQueue(queue);
    const payload = asJobData(data);
    if (opts?.dedupeKey) {
      await this.sendKeyed(queue, payload, "dedupe", opts.dedupeKey, opts);
      return;
    }
    if (opts?.debounceKey) {
      await this.sendDebounce(queue, payload, opts.debounceKey, opts);
      return;
    }
    const sendOpts = toPgBossSend(opts);
    if (sendOpts) {
      await this.boss.send(queue, payload, sendOpts);
    } else {
      await this.boss.send(queue, payload);
    }
  }

  async work<T>(queue: QueueName, opts: WorkOptions, handler: (data: T) => Promise<void>): Promise<void> {
    this.assertOpen();
    await this.ensureQueue(queue);
    const workOpts = {
      batchSize: opts.batchSize ?? 1,
      ...(opts.pollingIntervalSeconds !== undefined
        ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
        : {}),
    };
    const concurrency = Math.max(1, opts.concurrency ?? 1);
    for (let slot = 0; slot < concurrency; slot++) {
      const workerId = await this.boss.work<T>(queue, workOpts, async (jobs) => {
        await Promise.all(jobs.map((job) => handler(job.data)));
      });
      const tracked = this.workersByQueue.get(queue) ?? [];
      tracked.push(workerId);
      this.workersByQueue.set(queue, tracked);
    }
  }

  async schedule(id: string, queue: QueueName, cron: string, data?: unknown): Promise<void> {
    this.assertOpen();
    await this.ensureQueue(queue);
    // pg-boss names a schedule by its queue. Phase 0 schedules are one
    // per queue, so the id is the queue name; a later phase that needs
    // many schedules on one queue will use a different backend.
    void id;
    if (data === undefined) {
      await this.boss.schedule(queue, cron);
    } else {
      await this.boss.schedule(queue, cron, asJobData(data));
    }
  }

  async unschedule(id: string): Promise<void> {
    await this.boss.unschedule(id);
  }

  async counts(queue: QueueName): Promise<JobCounts> {
    // pg-boss 10 has no getQueueStats. Size before active is created+retry
    // (waiting, including delayed); size before completed adds active.
    const waiting = Number(await this.boss.getQueueSize(queue)) || 0;
    const withActive = Number(await this.boss.getQueueSize(queue, { before: "completed" })) || 0;
    return {
      waiting,
      active: Math.max(0, withActive - waiting),
      delayed: 0,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.boss.stop({ close: true, timeout: 2000 }).catch(() => {});
  }

  wake(queue: QueueName): void {
    for (const id of this.workersByQueue.get(queue) ?? []) this.boss.notifyWorker(id);
  }

  async offWork(queue: QueueName): Promise<void> {
    this.workersByQueue.delete(queue);
    await this.boss.offWork(queue);
  }

  /**
   * Standard-policy singletonKey is not unique in pg-boss 10. A stable
   * job id (UUID) is: one incomplete job per key, and a finished row
   * is deleted so the key can be used again.
   */
  private async sendKeyed(
    queue: QueueName,
    payload: object,
    kind: "dedupe",
    key: string,
    opts: SendOptions,
  ): Promise<void> {
    const id = keyedJobId(kind, key);
    const existing = await this.boss.getJobById(queue, id);
    if (existing && (existing.state === "created" || existing.state === "retry" || existing.state === "active")) {
      return;
    }
    await this.boss.deleteJob(queue, id).catch(() => {});
    await this.boss.send(queue, payload, { ...toPgBossSend(opts), id });
  }

  private async sendDebounce(
    queue: QueueName,
    payload: object,
    key: string,
    opts: SendOptions,
  ): Promise<void> {
    const id = keyedJobId("debounce", key);
    const existing = await this.boss.getJobById(queue, id);
    if (existing) {
      if (existing.state === "active") return;
      await this.boss.cancel(queue, id).catch(() => {});
      await this.boss.deleteJob(queue, id).catch(() => {});
    }
    await this.boss.send(queue, payload, { ...toPgBossSend(opts), id });
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("PgBossQueue is stopped");
  }

  private async ensureQueue(name: QueueName): Promise<void> {
    if (this.created.has(name)) return;
    if (COALESCE_QUEUES.has(name)) {
      await this.ensureCoalesceQueue(name);
    } else {
      await this.boss.createQueue(name);
    }
    this.created.add(name);
  }

  /**
   * createQueue is ON CONFLICT DO NOTHING, so an install that already
   * has gate.evaluate (or another coalesce queue) as standard keeps
   * that policy. Upgrade in place: pending jobs stay, and new sends
   * copy short from the queue row.
   */
  private async ensureCoalesceQueue(name: QueueName): Promise<void> {
    const existing = await this.boss.getQueue(name);
    if (!existing) {
      await this.boss.createQueue(name, { name, policy: "short" });
      return;
    }
    if (existing.policy !== "short") {
      await this.boss.updateQueue(name, { name, policy: "short" });
    }
  }
}

/** pg-boss job ids are UUIDs. Hash keeps the id a function of the caller key. */
function keyedJobId(kind: "dedupe" | "debounce", key: string): string {
  const hex = createHash("sha1").update(`${kind}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function asJobData<T>(data: T): object {
  if (data !== null && typeof data === "object") return data as object;
  return { value: data };
}

function toPgBossSend(opts?: SendOptions): PgBoss.SendOptions | undefined {
  if (!opts) return undefined;
  const send: PgBoss.SendOptions = {};
  const key = opts.coalesceKey ?? opts.dedupeKey ?? opts.debounceKey;
  if (key !== undefined) send.singletonKey = key;
  if (opts.delayMs !== undefined) send.startAfter = new Date(Date.now() + opts.delayMs);
  if (opts.attempts !== undefined) send.retryLimit = Math.max(0, opts.attempts - 1);
  if (opts.backoffMs !== undefined) {
    send.retryDelay = Math.max(1, Math.round(opts.backoffMs / 1000));
    send.retryBackoff = true;
  }
  return send;
}
