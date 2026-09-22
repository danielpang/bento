import { eq, inArray } from "drizzle-orm";
import type { AgentAdapter, SessionRecovery } from "@bento/agents";
import type { AgentEvent } from "@bento/core";
import { agentRuns, runEvents } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { appendRunEvent } from "./transcript.js";

/**
 * Fills transcript holes from the agent's own session record before a
 * resumed run starts.
 *
 * A server restart detaches the stream but not the agent: the process
 * keeps working in its sandbox, and everything it says while nobody is
 * attached reaches no transcript. The CLI's session storage in the
 * sandbox is the surviving copy of those messages. This reads that
 * record, diffs it against every message already persisted for the
 * card by CLI-native message id, and appends what is missing to the
 * given run's transcript, so the user sees what the agent said while
 * Bento was away instead of a conversation that skips from mid-task
 * to "the work is done".
 *
 * Two callers, one gap. A boot that reattaches to the still running
 * agent calls this before it reads a line of the live stream, so the
 * deploy's worth of messages lands ahead of what follows. A later run
 * that resumes the session calls it too, for the case where the agent
 * finished while no server was attached and there was nothing to
 * reattach to.
 *
 * Idempotent by construction: recovered events carry the same native
 * ids in their raw payload that delivered events do, so a later
 * recovery sees them as already present. Best effort by design: a
 * sandbox whose record is gone, a CLI without the capability, or a
 * failed read costs nothing but the recovery.
 */

/** A resume gone wrong should not flood a card with a book. */
export const MAX_RECOVERED_MESSAGES = 50;
const READ_TIMEOUT_MS = 30_000;

export interface RecoverArgs {
  handle: SandboxHandle;
  adapter: AgentAdapter;
  featureId: string;
  /** The starting run whose transcript receives what was missed. */
  runId: string;
  sessionId: string;
  /** Where the agent runs, for CLIs that key storage on the directory. */
  cwd: string;
  /**
   * The ids the card's transcript already holds, when the caller has
   * them (see loadPersistedIds). Extended in place with every message
   * recovered here, so a caller that goes on to filter a live stream
   * against the same set sees the recovered messages as delivered.
   * Loaded here when absent.
   */
  seen?: Set<string>;
}

export async function recoverMissedMessages(ctx: AppContext, args: RecoverArgs): Promise<void> {
  try {
    await recover(ctx, args);
  } catch (err) {
    // The resume itself must start either way; the messages stay in
    // the sandbox's record for the next attempt.
    console.warn(`could not recover missed messages for run ${args.runId}:`, err);
  }
}

async function recover(ctx: AppContext, args: RecoverArgs): Promise<void> {
  const recovery = args.adapter.sessionRecovery;
  if (!recovery) return;
  /**
   * The session id came from the CLI's own output stream, which the
   * agent controls, and at least one adapter interpolates it into a
   * shell command. The agent already runs code in its sandbox, so this
   * is hygiene rather than a boundary, but hygiene is cheap: every
   * real session id is machine-generated and matches this.
   */
  if (!/^[A-Za-z0-9_.-]+$/.test(args.sessionId)) return;

  const read = await collectExec(
    ctx.driver.exec(args.handle, recovery.readLogCommand(args.sessionId, args.cwd), {
      cwd: args.cwd,
      timeoutMs: READ_TIMEOUT_MS,
    }),
  );
  // No record is the common case (fresh sandbox, rotated storage) and
  // is not worth a transcript line, let alone a failure.
  if (read.exitCode !== 0 || !read.stdout.trim()) return;

  const held = recovery.parseLog(read.stdout);
  if (held.length === 0) return;

  const seen = args.seen ?? (await loadPersistedIds(ctx, recovery, args.featureId));

  const missed = held.filter((message) => {
    const event: AgentEvent = { type: "message", role: "assistant", text: message.text, raw: message.raw };
    // No identity means no safe diff; skipping loses nothing that was
    // ever attributable, and recovering it would duplicate forever.
    if (recovery.persistedIds(event).length === 0) return false;
    return !isPersisted(recovery, seen, event);
  });
  if (missed.length === 0) return;

  const kept = missed.slice(0, MAX_RECOVERED_MESSAGES);
  await appendRunEvent(ctx, args.runId, {
    type: "message",
    role: "system",
    text:
      kept.length === 1
        ? "The agent kept working while Bento was disconnected. One message it sent during that time follows, recovered from the agent's session record."
        : `The agent kept working while Bento was disconnected. ${kept.length} messages it sent during that time follow, recovered from the agent's session record.`,
  });
  for (const message of kept) {
    const event: AgentEvent = { type: "message", role: "assistant", text: message.text, raw: message.raw };
    await appendRunEvent(ctx, args.runId, event);
    for (const id of recovery.persistedIds(event)) seen.add(id);
  }
  if (missed.length > kept.length) {
    await appendRunEvent(ctx, args.runId, {
      type: "message",
      role: "system",
      text: `${missed.length - kept.length} more recovered message(s) were left out to keep this readable.`,
    });
  }
}

/**
 * Every native id the card's transcript holds, whichever run delivered
 * it. The session spans runs (each resume is a new run in the same CLI
 * session), so the set must too, or a resume would "recover" the whole
 * conversation into one transcript again.
 *
 * A snapshot, on purpose. A reattaching server filters the live stream
 * against the ids it loaded at attach time and nothing later: the
 * sandbox may replay output the transcript already has (the first
 * life's, or the gap this module just recovered), and that is what
 * the filter drops. It must not learn the ids of the events it goes
 * on to append, because one message can arrive as several lines under
 * one id (claude-code emits one line per content block), and a filter
 * that remembered the first line would drop the rest.
 */
export async function loadPersistedIds(
  ctx: AppContext,
  recovery: Pick<SessionRecovery, "persistedIds">,
  featureId: string,
): Promise<Set<string>> {
  const cardRuns = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.featureId, featureId));
  const persisted = cardRuns.length
    ? await ctx.db
        .select({ payload: runEvents.payload })
        .from(runEvents)
        .where(
          inArray(
            runEvents.runId,
            cardRuns.map((r) => r.id),
          ),
        )
    : [];
  const seen = new Set<string>();
  for (const row of persisted) {
    for (const id of recovery.persistedIds(row.payload as AgentEvent)) seen.add(id);
  }
  return seen;
}

/**
 * Whether the transcript already holds this event, by native id. An
 * event without one is never "already there": it cannot be told from
 * a new one, and dropping it would lose something real.
 */
export function isPersisted(
  recovery: Pick<SessionRecovery, "persistedIds">,
  seen: ReadonlySet<string>,
  event: AgentEvent,
): boolean {
  return recovery.persistedIds(event).some((id) => seen.has(id));
}
