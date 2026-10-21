import { test } from "node:test";
import assert from "node:assert/strict";
import { LineChannel } from "@bento/sandbox";
import { openLiveWire, type LiveProtocol, type LiveSession } from "@bento/agents";
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
const wire = openLiveWire(live, { prompt: "", model: "m", cwd: "/" }, { attach: false });

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
    wire,
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
    wire,
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
    wire,
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
    wire,
    liveChannel: closed,
    conversation: conversation(0),
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await closedHandle.onTurnFinished(true);
  assert.equal(closed.write("x"), false, "no mayEnd given: closes at once, as before");
});

/**
 * A protocol that holds a message until its handshake answers (Codex
 * needs a thread id before a turn can name it). Held is still owed to
 * the process, so a turn's end must not close stdin under it.
 */
function holdingWire(): LiveProtocol & { release(): string[] } {
  const held: string[] = [];
  let ready = false;
  return {
    get held() {
      return held.length;
    },
    open: () => [],
    send(text) {
      if (ready) return [text];
      held.push(text);
      return [];
    },
    read: () => ({ write: [] }),
    release() {
      ready = true;
      return held.splice(0);
    },
  };
}

test("a message a protocol is holding keeps stdin open past a turn's end", async () => {
  const channel = new LineChannel();
  const holding = holdingWire();
  const said: string[] = [];
  const handle = attachLiveConversation({
    runId: "r5",
    wire: holding,
    liveChannel: channel,
    conversation: conversation(0),
    mayEnd: async () => true,
    sayAsUser: async (text) => {
      said.push(text);
    },
    saySystem: async () => {},
  });
  assert.equal(await handle.deliver("before the handshake"), true, "held counts as delivered");
  assert.deepEqual(said, ["before the handshake"], "and is shown as sent");
  await handle.onTurnFinished(true);
  assert.equal(channel.ended, false, "stdin stays open while a message is held");
  for (const line of holding.release()) channel.write(line);
  assert.equal(channel.pending, 1, "the held message goes out once released");
});

test("a message a protocol refuses is not delivered, so it goes back on the card", async () => {
  const channel = new LineChannel();
  const refusing: LiveProtocol = { held: 0, open: () => [], send: () => null, read: () => ({ write: [] }) };
  const said: string[] = [];
  const handle = attachLiveConversation({
    runId: "r6",
    wire: refusing,
    liveChannel: channel,
    conversation: conversation(0),
    sayAsUser: async (text) => {
      said.push(text);
    },
    saySystem: async () => {},
  });
  assert.equal(await handle.deliver("too late"), false);
  assert.deepEqual(said, [], "nothing is shown as sent");
  assert.equal(channel.pending, 0);
});
