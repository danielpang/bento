import { test } from "node:test";
import assert from "node:assert/strict";
import { LineChannel } from "@bento/sandbox";
import type { LiveSession } from "@bento/agents";
import { attachLiveConversation, type LiveConversation } from "./live-session.js";

/**
 * The hold timer closes the agent's stdin when it fires, and it fires
 * on whichever process armed it, which after a suspend may no longer
 * own the run. The timer asks before it ends anything.
 */

const live: LiveSession = {
  delivery: "queue",
  buildCommand: () => [],
  encodeMessage: (text) => text,
};

function conversation(holdSec: number): LiveConversation {
  return {
    claim: async () => [],
    markSent: async () => {},
    requeue: async () => {},
    holdFor: async () => holdSec,
    waitingNotice: () => "waiting",
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a hold timer that fires on a process which no longer owns the run leaves stdin open", async () => {
  const channel = new LineChannel();
  let asked = 0;
  const handle = attachLiveConversation({
    runId: "r1",
    live,
    liveChannel: channel,
    conversation: conversation(1),
    mayEnd: async () => {
      asked += 1;
      return false;
    },
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await handle.onTurnFinished(true);
  assert.equal(handle.waiting(), true, "the hold is armed");
  await tick(1200);
  assert.equal(asked, 1, "the timer asked before ending stdin");
  assert.equal(channel.write("still open"), true, "and left stdin open when told no");
});

test("a hold timer on the owning process closes stdin as before", async () => {
  const channel = new LineChannel();
  const handle = attachLiveConversation({
    runId: "r2",
    live,
    liveChannel: channel,
    conversation: conversation(1),
    mayEnd: async () => true,
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await handle.onTurnFinished(true);
  await tick(1200);
  assert.equal(channel.write("too late"), false, "stdin was closed at the end of the hold");
});

test("a turn with no hold closes stdin only if the process still owns the run", async () => {
  const kept = new LineChannel();
  const keptHandle = attachLiveConversation({
    runId: "r3",
    live,
    liveChannel: kept,
    conversation: conversation(0),
    mayEnd: async () => false,
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await keptHandle.onTurnFinished(true);
  assert.equal(kept.write("x"), true, "another process owns the run: stdin stays open");

  const closed = new LineChannel();
  const closedHandle = attachLiveConversation({
    runId: "r4",
    live,
    liveChannel: closed,
    conversation: conversation(0),
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await closedHandle.onTurnFinished(true);
  assert.equal(closed.write("x"), false, "no mayEnd given: closes at once, as before");
});
