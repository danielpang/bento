import type { JobQueue, QueueName, SendOptions } from "./types.js";

/**
 * Queues whose payloads cannot be rebuilt from domain rows. Boot
 * already re-queues runs, landings, ticks, and Modal hibernations
 * from tables; these three only lived in pg-boss.
 */
export const PAYLOAD_ONLY_QUEUES = ["slack.notify", "linear.outbound", "linear.create-issue"] as const;

export type PayloadOnlyQueue = (typeof PAYLOAD_ONLY_QUEUES)[number];

const IMPORT_STATES = ["created", "retry"] as const;

/**
 * slack.notify is the only imported queue with non-default retries.
 * Same numbers as queueSlackNotify: 9 attempts, 15s exponential.
 */
const QUEUE_SEND_OPTIONS: Record<PayloadOnlyQueue, SendOptions> = {
  "slack.notify": { attempts: 9, backoffMs: 15_000 },
  "linear.outbound": {},
  "linear.create-issue": {},
};

/** BullMQ job id for one pg-boss row. Repeat imports find the same job. */
export function importedPgbossJobId(pgbossJobId: string): string {
  return `import__${encodeURIComponent(pgbossJobId)}`;
}

export interface ImportPgbossPayloadJobsResult {
  imported: number;
  skipped: number;
}

interface ImportQuery {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<{ id: string; name: string; data: unknown; start_after: Date | string }> }>;
}

interface PayloadImporter {
  kind: JobQueue["kind"];
  importOnce(
    queue: QueueName,
    data: unknown,
    opts: SendOptions & { sourceId: string },
  ): Promise<"imported" | "skipped">;
}

function isPayloadImporter(jobs: JobQueue): jobs is JobQueue & PayloadImporter {
  return jobs.kind === "bullmq" && typeof (jobs as Partial<PayloadImporter>).importOnce === "function";
}

function isMissingPgboss(err: unknown): boolean {
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
  // 3F000: schema does not exist. 42P01: relation does not exist.
  return code === "3F000" || code === "42P01";
}

function assertSafeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid pg-boss schema name: ${name}`);
  }
  return name;
}

/**
 * Copy created/retry slack.notify, linear.outbound, and
 * linear.create-issue jobs from pgboss.job into BullMQ.
 *
 * Idempotent via deterministic job ids: a second call, or a boot that
 * resumes after a crash, adds only rows that are not already in Redis
 * (including completed imports, which are kept so they are not
 * re-queued). The pgboss schema is not modified.
 *
 * A database that never ran pg-boss (no schema) is a no-op. Local and
 * Mac pg-boss processes skip this; they are not cutting over.
 */
export async function importPgbossPayloadJobs(opts: {
  pool: ImportQuery;
  jobs: JobQueue;
  schema?: string;
}): Promise<ImportPgbossPayloadJobsResult> {
  if (!isPayloadImporter(opts.jobs)) return { imported: 0, skipped: 0 };

  const schema = assertSafeIdent(opts.schema ?? "pgboss");
  let rows: Array<{ id: string; name: string; data: unknown; start_after: Date | string }>;
  try {
    const result = await opts.pool.query(
      `SELECT id, name, data, start_after
       FROM ${schema}.job
       WHERE name = ANY($1::text[])
         AND state::text = ANY($2::text[])
       ORDER BY created_on ASC`,
      [[...PAYLOAD_ONLY_QUEUES], [...IMPORT_STATES]],
    );
    rows = result.rows;
  } catch (err) {
    if (isMissingPgboss(err)) return { imported: 0, skipped: 0 };
    throw err;
  }

  let imported = 0;
  let skipped = 0;
  const now = Date.now();
  for (const row of rows) {
    if (!isPayloadOnlyQueue(row.name)) continue;
    const startAfter = new Date(row.start_after).getTime();
    const delayMs = Number.isFinite(startAfter) && startAfter > now ? startAfter - now : undefined;
    const data = row.data !== null && typeof row.data === "object" ? row.data : {};
    const outcome = await opts.jobs.importOnce(row.name, data, {
      sourceId: String(row.id),
      ...QUEUE_SEND_OPTIONS[row.name],
      ...(delayMs !== undefined ? { delayMs } : {}),
    });
    if (outcome === "imported") imported += 1;
    else skipped += 1;
  }
  return { imported, skipped };
}

function isPayloadOnlyQueue(name: string): name is PayloadOnlyQueue {
  return (PAYLOAD_ONLY_QUEUES as readonly string[]).includes(name);
}
