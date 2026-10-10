export type { FakeJob } from "./fake.js";
export { FakeJobQueue } from "./fake.js";
export { PgBossQueue } from "./pg-boss.js";
// BullMqQueue lives in ./bullmq.js and is imported only on the multi-mode
// path, so a local or Mac process never loads Redis.
export {
  COALESCE_QUEUES,
  QUEUE_NAMES,
  type JobCounts,
  type JobQueue,
  type JobQueueKind,
  type QueueName,
  type SendOptions,
  type WorkOptions,
} from "./types.js";
