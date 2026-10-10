import { shouldHoldLiveSession } from "@bento/core";
import type { LiveSession } from "@bento/agents";
import type { LineChannel } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import {
  claimQueuedMessages,
  markMessagesSent,
  requeueMessages,
} from "./messages.js";

/**
 * Where a live session's messages come from and whether it waits for
 * more, which is the part that differs between a card's agent, a
 * swarm's planner, and a swarm's worker.
 *
 * The stdin mechanics (writing a line, closing the process, parking a
 * message that arrived mid turn) are the same for all three and live
 * in attachLiveConversation. What a card parks on its feature, a
 * worker parks on its node, and a planner has folded for it by the
 * coordinator, so each one answers these questions its own way.
 */
export interface LiveConversation {
  /**
   * Messages that parked while a turn ran, oldest first. Taken, not
   * read: the rows are the caller's to bind to the run (markSent) or
   * put back (requeue) depending on whether the write reached stdin.
   */
  claim(): Promise<{ id: string; text: string }[]>;
  markSent(ids: string[]): Promise<void>;
  requeue(ids: string[]): Promise<void>;
  /**
   * How long to keep the process open after a finished turn with
   * nothing waiting, in seconds. 0 closes stdin, which ends the run.
   * Asked after every turn, so a hold can stop re-arming once there is
   * nobody left to wait for.
   */
  holdFor(ok: boolean): Promise<number>;
  /** The transcript line announcing the hold, said once per run. */
  waitingNotice(idleSec: number): string;
  /**
   * Called each time the hold is armed, after `waiting()` turns true.
   * The planner's conversation uses it to ask the coordinator for
   * whatever folded up while the turn ran.
   */
  onWaiting?(): Promise<void>;
}

export interface LiveConversationHandle {
  deliver: (text: string) => Promise<boolean>;
  onTurnFinished: (ok: boolean) => Promise<void>;
  dispose: () => void;
  /** True between turns while the process is held open for a message. */
  waiting: () => boolean;
}

/**
 * Owns the live stdin conversation for one run: delivering a message
 * the user typed, feeding messages that parked while a turn ran, and
 * either holding the process open after a successful turn (so they can
 * keep talking without a second run) or closing stdin so the process
 * ends.
 *
 * Shared by the first execution and by a reattach after a restart, so
 * the hold cannot exist on one path and vanish on the other.
 */
export function attachLiveConversation(input: {
  runId: string;
  live: LiveSession;
  liveChannel: LineChannel;
  conversation: LiveConversation;
  /**
   * The moment past which no hold may reach, as epoch milliseconds:
   * the run limit, less a margin. A process held past the limit is
   * killed mid wait and the run fails as timed out, so a hold that
   * would end after this closes stdin instead and the next message
   * starts a fresh run on the same session.
   */
  holdUntil?: number;
  sayAsUser: (text: string) => Promise<void>;
  saySystem: (text: string) => Promise<void>;
}): LiveConversationHandle {
  const { live, liveChannel, conversation } = input;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let announcedWait = false;
  let waiting = false;

  const clearIdle = () => {
    waiting = false;
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const closeWhenQuiet = () => {
    clearIdle();
    if (liveChannel.pending === 0) liveChannel.end();
  };

  const deliver = async (text: string): Promise<boolean> => {
    clearIdle();
    const accepted = liveChannel.write(live.encodeMessage(text, "followUp"));
    if (accepted) await input.sayAsUser(text);
    return accepted;
  };

  const onTurnFinished = async (ok: boolean): Promise<void> => {
    const claimed = await conversation.claim();
    if (claimed.length > 0) {
      clearIdle();
      const joined = claimed.map((m) => m.text).join("\n");
      const accepted = liveChannel.write(live.encodeMessage(joined, "followUp"));
      if (accepted) {
        await conversation.markSent(claimed.map((m) => m.id));
        await input.sayAsUser(joined);
        return;
      }
      await conversation.requeue(claimed.map((m) => m.id));
    }

    if (liveChannel.pending === 0) {
      const idleSec = await conversation.holdFor(ok);
      const fits = input.holdUntil === undefined || Date.now() + idleSec * 1000 <= input.holdUntil;
      if (idleSec > 0 && fits) {
        if (!announcedWait) {
          announcedWait = true;
          await input.saySystem(conversation.waitingNotice(idleSec));
        }
        clearIdle();
        idleTimer = setTimeout(() => {
          idleTimer = null;
          waiting = false;
          if (liveChannel.pending === 0) liveChannel.end();
        }, idleSec * 1000);
        idleTimer.unref?.();
        waiting = true;
        await conversation.onWaiting?.();
        return;
      }
    }

    closeWhenQuiet();
  };

  return {
    deliver,
    onTurnFinished,
    dispose() {
      closeWhenQuiet();
    },
    waiting: () => waiting,
  };
}

/**
 * A card's conversation: messages park on the feature, the stage's
 * gate decides whether the process waits, and the feature message
 * route delivers through the executor's handle.
 */
export function cardConversation(
  ctx: Pick<AppContext, "db">,
  input: { featureId: string; runId: string; role: string; gateType: string; idleSec: number },
): LiveConversation {
  return {
    claim: () => claimQueuedMessages(ctx.db, input.featureId),
    markSent: (ids) => markMessagesSent(ctx.db, ids, input.runId),
    requeue: (ids) => requeueMessages(ctx.db, ids),
    holdFor: async (ok) =>
      shouldHoldLiveSession({ ok, role: input.role, gateType: input.gateType, idleSec: input.idleSec }) ? input.idleSec : 0,
    waitingNotice: (seconds) =>
      seconds === 1
        ? "The agent is waiting. Send a message to keep talking in this session. The run ends after 1 second of silence."
        : `The agent is waiting. Send a message to keep talking in this session. The run ends after ${seconds} seconds of silence.`,
  };
}

/**
 * No conversation at all: the process gets its prompt, and stdin is
 * closed the moment its first turn ends.
 *
 * For a run on a live adapter that nobody can talk to (a swarm's judge
 * or resolver, a subplanner). Before this, such a run attached nothing
 * and nothing ended its stdin, so a CLI that reads stdin to end of
 * input sat idle after its result until the run limit.
 */
export function headlessConversation(): LiveConversation {
  return {
    claim: async () => [],
    markSent: async () => {},
    requeue: async () => {},
    holdFor: async () => 0,
    waitingNotice: () => "",
  };
}
