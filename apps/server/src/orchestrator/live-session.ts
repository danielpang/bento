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
  ctx: AppContext;
  runId: string;
  featureId: string;
  role: string;
  gateType: string;
  idleSec: number;
  live: LiveSession;
  liveChannel: LineChannel;
  sayAsUser: (text: string) => Promise<void>;
  saySystem: (text: string) => Promise<void>;
}): { deliver: (text: string) => Promise<boolean>; onTurnFinished: (ok: boolean) => Promise<void>; dispose: () => void } {
  const { ctx, runId, featureId, live, liveChannel } = input;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let announcedWait = false;

  const clearIdle = () => {
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
    const claimed = await claimQueuedMessages(ctx.db, featureId);
    if (claimed.length > 0) {
      clearIdle();
      const joined = claimed.map((m) => m.text).join("\n");
      const accepted = liveChannel.write(live.encodeMessage(joined, "followUp"));
      if (accepted) {
        await markMessagesSent(ctx.db, claimed.map((m) => m.id), runId);
        await input.sayAsUser(joined);
        return;
      }
      await requeueMessages(ctx.db, claimed.map((m) => m.id));
    }

    if (
      liveChannel.pending === 0 &&
      shouldHoldLiveSession({ ok, role: input.role, gateType: input.gateType, idleSec: input.idleSec })
    ) {
      if (!announcedWait) {
        announcedWait = true;
        const seconds = input.idleSec;
        await input.saySystem(
          seconds === 1
            ? "The agent is waiting. Send a message to keep talking in this session. The run ends after 1 second of silence."
            : `The agent is waiting. Send a message to keep talking in this session. The run ends after ${seconds} seconds of silence.`,
        );
      }
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (liveChannel.pending === 0) liveChannel.end();
      }, input.idleSec * 1000);
      idleTimer.unref?.();
      return;
    }

    closeWhenQuiet();
  };

  return {
    deliver,
    onTurnFinished,
    dispose() {
      closeWhenQuiet();
    },
  };
}
