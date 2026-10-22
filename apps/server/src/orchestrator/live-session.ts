import { shouldHoldLiveSession, type TurnState } from "@bento/core";
import type { LiveAsk, LiveWire } from "@bento/agents";
import type { LineChannel } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import {
  claimQueuedMessages,
  markMessagesSent,
  requeueMessages,
} from "./messages.js";
import { claimAnswers, recordQuestion, requeueAnswers, withdrawQuestions, type ClaimedAnswer } from "./questions.js";

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
  /**
   * How long to keep the process open after a person interrupted its
   * turn, in seconds: they stopped it to say something else, so the
   * session waits for that message whatever the stage's gate would do
   * after a finished turn. Absent or 0 ends the run as a failed turn
   * would.
   */
  holdAfterInterrupt?(): number;
  /** The transcript line saying the session is waiting after an interrupt. */
  interruptedNotice?(idleSec: number): string;
  /**
   * Where the agent's questions go when a person can answer them. Absent
   * means nobody can, and a question is declined at once so the agent
   * decides by itself rather than waiting for the run limit.
   */
  questions?: {
    /** Stores a question; the row's id, or null when it was already stored. */
    record(ask: LiveAsk): Promise<string | null>;
    /** Answers a person gave that the agent does not have yet, taken for writing. */
    claimAnswers(): Promise<ClaimedAnswer[]>;
    /** Answers whose write failed, back for the next pump. */
    requeueAnswers(ids: string[]): Promise<void>;
    /** Questions the agent withdrew, by its request id. */
    withdraw(requestIds: string[]): Promise<void>;
  };
}

/** What a question is told when nobody can answer it. */
export const NOBODY_TO_ASK =
  "Nobody can answer questions in this run. Make the most reasonable choice yourself, say which one you made and why, and carry on.";

export interface LiveConversationHandle {
  deliver: (text: string) => Promise<boolean>;
  /** `interrupted` when a person stopped the turn (see LiveConversation.holdAfterInterrupt). */
  onTurnFinished: (ok: boolean, interrupted?: boolean) => Promise<void>;
  /**
   * Stops the turn in progress without ending the session. False when
   * the tool cannot, or this process no longer holds the conversation.
   */
  interrupt: () => boolean;
  /**
   * The same, saying why nothing was sent: "waiting" (no turn to stop),
   * "unnamed" (a turn the protocol cannot name, one that started before
   * this process attached), "closed" (no tool, no stdin, or not ours).
   */
  tryInterrupt: () => "sent" | "waiting" | "unnamed" | "closed";
  /** Questions the agent just asked, as the protocol read them off its output. */
  ask: (asks: LiveAsk[]) => Promise<void>;
  /** Questions the agent withdrew, by its request id. */
  withdraw: (requestIds: string[]) => Promise<void>;
  /**
   * Settles once every question the agent asked so far is stored (or
   * failed to be), so whatever withdraws questions after the stream
   * ends sees all of them rather than racing an insert.
   */
  recorded: () => Promise<void>;
  dispose: () => void;
  /** True between turns while the process is held open for a message. */
  waiting: () => boolean;
  /**
   * Claims what is parked for this conversation and writes it in now,
   * without waiting for the turn to end. The answer to a nudge from
   * another server, which enqueued the row and could not reach this
   * process's stdin itself. True when something was written.
   */
  pump: () => Promise<boolean>;
  /**
   * Lets go of the conversation without ending it: the hold timer is
   * cleared and nothing further is written, but stdin stays open,
   * because another process now owns this session and will close it
   * when it is done. For a run this process was disowned of.
   */
  detach: () => void;
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
  /** The process's side of the protocol: what to write for a message. */
  wire: LiveWire;
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
  /**
   * Asked before stdin is closed at the end of a hold or a turn. False
   * leaves it open: the run belongs to another process now (adopted
   * while this one was suspended, or handed to a successor on drain),
   * and the EOF would end the agent under it. Absent means always.
   */
  mayEnd?: () => Promise<boolean>;
  sayAsUser: (text: string) => Promise<void>;
  saySystem: (text: string) => Promise<void>;
  /**
   * The transcript line saying the agent asked a question, carrying the
   * question's id, which is how a watching console knows to show it.
   */
  sayAsked?: (questionId: string, ask: LiveAsk) => Promise<void>;
  /**
   * Each change between the agent working on a turn and waiting for a
   * message, starting with "working" as the conversation attaches. The
   * executor puts it on the bus, which is how the console's Stop knows
   * whether there is a turn to stop without reading it off the
   * transcript.
   */
  onTurnState?: (state: TurnState) => void;
}): LiveConversationHandle {
  const { wire, liveChannel, conversation } = input;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let announcedWait = false;
  let waiting = false;
  let detached = false;
  let announced: TurnState | null = null;
  const announce = (state: TurnState) => {
    if (detached || announced === state) return;
    announced = state;
    input.onTurnState?.(state);
  };

  const clearIdle = () => {
    waiting = false;
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  /**
   * Nothing is waiting to reach the process: no line the channel has
   * not handed over, and no message the protocol is holding until its
   * handshake answers (a thread id the message has to name).
   */
  const quiet = () => liveChannel.pending === 0 && wire.held === 0;

  /**
   * A message into the process. False when it did not go in, so the
   * caller can put it back: the channel closed, or the protocol says
   * this process will never take it. Held counts as in: it goes out
   * when the handshake answers.
   */
  const write = (text: string): boolean => {
    const lines = wire.send(text);
    if (lines === null) return false;
    for (const line of lines) if (!liveChannel.write(line)) return false;
    return !liveChannel.ended;
  };

  const closeWhenQuiet = () => {
    clearIdle();
    if (quiet()) liveChannel.end();
  };

  /**
   * Ends stdin once nothing is waiting to be read, if this process may
   * still do so. The hold timer and the no-hold close both come through
   * here, because both can fire on a process that no longer owns the
   * run; dispose does not, because by then the stream has ended.
   */
  const endStdinIfOurs = async (): Promise<void> => {
    if (!quiet()) return;
    if (input.mayEnd && !(await input.mayEnd())) return;
    liveChannel.end();
  };

  const deliver = async (text: string): Promise<boolean> => {
    if (detached) return false;
    clearIdle();
    const accepted = write(text);
    if (accepted) {
      announce("working");
      await input.sayAsUser(text);
    }
    return accepted;
  };

  /**
   * Feeds in whatever parked while the agent worked, oldest first, as
   * one message. Shared by the turn's end and by a nudge, so the two
   * doors agree on what a delivered message is: written to stdin, then
   * marked sent, then shown in the transcript. A write the channel
   * refused puts the rows back for the next door.
   */
  const pumpParked = async (): Promise<boolean> => {
    if (detached) return false;
    const claimed = await conversation.claim();
    if (claimed.length === 0) return false;
    clearIdle();
    const joined = claimed.map((m) => m.text).join("\n");
    const accepted = write(joined);
    if (accepted) {
      announce("working");
      await conversation.markSent(claimed.map((m) => m.id));
      await input.sayAsUser(joined);
      return true;
    }
    await conversation.requeue(claimed.map((m) => m.id));
    return false;
  };

  /**
   * Writes answers a person gave into the agent, which is blocked on
   * them mid turn, so this never waits for a turn to end. Each answer is
   * shown in the transcript as the person's words. True when one went in.
   */
  const pumpAnswers = async (): Promise<boolean> => {
    if (detached || !conversation.questions || !wire.answer) return false;
    const claimed = await conversation.questions.claimAnswers();
    if (claimed.length === 0) return false;
    const failed: string[] = [];
    for (const answer of claimed) {
      const lines = wire.answer(answer.ask, answer.answers);
      if (!lines.every((line) => liveChannel.write(line))) {
        failed.push(answer.id);
        continue;
      }
      await input.sayAsUser(
        Object.entries(answer.answers)
          .map(([question, chosen]) => `${question} ${chosen}`)
          .join("\n"),
      );
    }
    if (failed.length > 0) await conversation.questions.requeueAnswers(failed);
    return failed.length < claimed.length;
  };

  /** Answers first: the agent is blocked on those; messages queue behind its turn. */
  const pump = async (): Promise<boolean> => {
    const answered = await pumpAnswers();
    const sent = await pumpParked();
    return answered || sent;
  };

  /** Keeps the process open for `idleSec` for a message, then closes stdin. */
  const hold = async (idleSec: number, notice: string | null): Promise<void> => {
    if (notice !== null) await input.saySystem(notice);
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      waiting = false;
      endStdinIfOurs().catch((err: unknown) => {
        console.warn(`could not end the held session of run ${input.runId}:`, err);
      });
    }, idleSec * 1000);
    idleTimer.unref?.();
    waiting = true;
    announce("waiting");
    await conversation.onWaiting?.();
  };
  const fits = (idleSec: number) => input.holdUntil === undefined || Date.now() + idleSec * 1000 <= input.holdUntil;

  /**
   * The questions asked in this process's life still open, and every
   * insert of one still in flight. A turn that ended is waiting on none
   * of them: Claude Code
   * withdraws its own, but pi resolves a dialog its abort cut short and
   * says nothing, so the end of the turn is what takes the card away.
   */
  const asked = new Set<string>();
  let recording: Promise<void> = Promise.resolve();
  const withdrawAsked = async (): Promise<void> => {
    if (asked.size === 0) return;
    const ids = [...asked];
    asked.clear();
    await recording;
    await conversation.questions?.withdraw(ids);
  };

  const onTurnFinished = async (ok: boolean, interrupted = false): Promise<void> => {
    if (detached) return;
    await withdrawAsked();
    if (await pumpParked()) return;
    // Another turn is due (Claude Code takes what was sent mid turn as a
    // turn of its own): its result decides, so the agent is not "waiting"
    // while it works and its turn can still be stopped.
    if (wire.working) return;

    // A person stopped the turn to say something else: wait for it,
    // whatever the stage would do with an ordinary finished turn.
    if (interrupted && quiet()) {
      const idleSec = conversation.holdAfterInterrupt?.() ?? 0;
      if (idleSec > 0 && fits(idleSec)) {
        await hold(idleSec, conversation.interruptedNotice?.(idleSec) ?? null);
        return;
      }
    }

    if (quiet()) {
      const idleSec = await conversation.holdFor(ok);
      if (idleSec > 0 && fits(idleSec)) {
        let notice: string | null = null;
        if (!announcedWait) {
          announcedWait = true;
          notice = conversation.waitingNotice(idleSec);
        }
        await hold(idleSec, notice);
        return;
      }
    }

    clearIdle();
    await endStdinIfOurs();
  };

  const tryInterrupt = (): "sent" | "waiting" | "unnamed" | "closed" => {
    if (detached || !wire.interrupt || liveChannel.ended) return "closed";
    // Held open between turns: nothing is working. Interrupting here
    // would also clear the hold's timer with no turn end to come.
    if (waiting) return "waiting";
    const lines = wire.interrupt();
    if (lines === null) return "unnamed";
    clearIdle();
    return lines.every((line) => liveChannel.write(line)) ? "sent" : "closed";
  };
  const interrupt = (): boolean => tryInterrupt() === "sent";

  /**
   * Questions the agent asked. Stored for a person to answer when this
   * conversation has someone who can, and declined at once when it does
   * not, so the agent never waits on nobody.
   */
  const ask = async (asks: LiveAsk[]): Promise<void> => {
    if (detached) return;
    if (conversation.questions && wire.answer) for (const one of asks) asked.add(one.id);
    const done = (async () => {
      for (const one of asks) {
        if (conversation.questions && wire.answer) {
          const id = await conversation.questions.record(one);
          if (id) await input.sayAsked?.(id, one);
          continue;
        }
        for (const line of wire.decline?.(one, NOBODY_TO_ASK) ?? []) liveChannel.write(line);
      }
    })();
    recording = Promise.all([recording, done.catch(() => {})]).then(() => {});
    await done;
  };

  const withdraw = async (requestIds: string[]): Promise<void> => {
    if (detached || requestIds.length === 0) return;
    for (const id of requestIds) asked.delete(id);
    // After any insert in flight, or the row would be written after its withdrawal.
    await recording;
    await conversation.questions?.withdraw(requestIds);
  };

  announce("working");

  return {
    deliver,
    onTurnFinished,
    interrupt,
    tryInterrupt,
    ask,
    withdraw,
    recorded: () => recording,
    dispose() {
      if (detached) return;
      closeWhenQuiet();
    },
    waiting: () => waiting,
    pump,
    detach() {
      detached = true;
      // The timer only, never the channel: ending stdin here would end
      // the agent under the process that now owns it.
      clearIdle();
    },
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
    // Every stage, manual or not: the person stopped the turn to redirect it.
    holdAfterInterrupt: () => input.idleSec,
    interruptedNotice: (seconds) =>
      `If no follow up message is sent after ${seconds}s the agent run will end. Sending a follow up message will restart the stage.`,
    questions: {
      record: (ask) => recordQuestion(ctx.db, input.runId, ask),
      claimAnswers: () => claimAnswers(ctx.db, input.runId),
      requeueAnswers: (ids) => requeueAnswers(ctx.db, ids),
      withdraw: (requestIds) => withdrawQuestions(ctx.db, input.runId, requestIds),
    },
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
