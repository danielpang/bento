import type { JobCounts, JobQueue, QueueName, SendOptions, WorkOptions } from "./types.js";

/** One send recorded by FakeJobQueue, the shape swarm tests already assert. */
export interface FakeJob {
  queue: QueueName;
  data: unknown;
  opts?: SendOptions;
}

/**
 * In-process JobQueue for tests that used to hand-build a fake boss.
 *
 * `sent`, `worked`, `offWorked` and `woken` are the recording; tests
 * that need to intercept a call overwrite the method on the instance.
 */
export class FakeJobQueue implements JobQueue {
  readonly sent: FakeJob[] = [];
  readonly worked: QueueName[] = [];
  readonly offWorked: QueueName[] = [];
  readonly woken: QueueName[] = [];
  readonly scheduled: Array<{ id: string; queue: QueueName; cron: string; data?: unknown }> = [];
  readonly unscheduled: string[] = [];
  stopped = false;

  async send<T>(queue: QueueName, data: T, opts?: SendOptions): Promise<void> {
    this.sent.push(opts === undefined ? { queue, data } : { queue, data, opts });
  }

  async work<T>(queue: QueueName, _opts: WorkOptions, _handler: (data: T) => Promise<void>): Promise<void> {
    this.worked.push(queue);
  }

  async schedule(id: string, queue: QueueName, cron: string, data?: unknown): Promise<void> {
    this.scheduled.push(data === undefined ? { id, queue, cron } : { id, queue, cron, data });
  }

  async unschedule(id: string): Promise<void> {
    this.unscheduled.push(id);
  }

  async counts(_queue: QueueName): Promise<JobCounts> {
    return { waiting: 0, active: 0, delayed: 0 };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  wake(queue: QueueName): void {
    this.woken.push(queue);
  }

  async offWork(queue: QueueName): Promise<void> {
    this.offWorked.push(queue);
  }
}
