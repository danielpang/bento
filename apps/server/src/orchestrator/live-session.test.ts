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

/**
 * Interrupts and questions. The wire here is Claude Code's real
 * protocol, so the lines written to stdin are the ones the CLI reads.
 */
import { claudeCodeAdapter, type LiveAsk } from "@bento/agents";

const claudeWire = () => openLiveWire(claudeCodeAdapter.live!, { prompt: "", model: "m", cwd: "/" }, { attach: false });
const asked: LiveAsk = {
  id: "req-9",
  questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
  input: { questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] },
};

function drain(channel: LineChannel): string[] {
  const lines: string[] = [];
  while (channel.pending > 0) lines.push((channel as unknown as { queue: string[] }).queue.shift()!);
  return lines;
}

test("an interrupt writes the control request, and the session waits for the next message after it", async () => {
  const channel = new LineChannel();
  const said: string[] = [];
  const handle = attachLiveConversation({
    runId: "r7",
    wire: claudeWire(),
    liveChannel: channel,
    // An automatic stage: an ordinary turn's end would close stdin at once.
    conversation: { ...conversation(0), holdAfterInterrupt: () => 1, interruptedNotice: () => "interrupted notice" },
    mayEnd: async () => true,
    sayAsUser: async () => {},
    saySystem: async (text) => {
      said.push(text);
    },
  });
  assert.equal(handle.interrupt(), true);
  assert.deepEqual(drain(channel).map((l) => (JSON.parse(l) as { request: unknown }).request), [{ subtype: "interrupt" }]);
  await handle.onTurnFinished(false, true);
  assert.equal(handle.waiting(), true, "held open for the person's next message");
  assert.deepEqual(said, ["interrupted notice"]);
  assert.equal(channel.ended, false);
  await tick(1200);
  assert.equal(channel.ended, true, "and closed once nobody wrote");

  const plain = new LineChannel();
  const noHold = attachLiveConversation({
    runId: "r8",
    wire: claudeWire(),
    liveChannel: plain,
    conversation: conversation(0),
    mayEnd: async () => true,
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await noHold.onTurnFinished(false, false);
  assert.equal(plain.ended, true, "a failed turn that nobody interrupted ends the run, as before");
});

test("a tool that cannot interrupt says so, and Stop remains", () => {
  const channel = new LineChannel();
  const handle = attachLiveConversation({
    runId: "r9",
    wire,
    liveChannel: channel,
    conversation: conversation(0),
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  assert.equal(handle.interrupt(), false);
  assert.equal(channel.pending, 0);
});

test("a question nobody can answer is declined at once, so the agent decides by itself", async () => {
  const channel = new LineChannel();
  const handle = attachLiveConversation({
    runId: "r10",
    wire: claudeWire(),
    liveChannel: channel,
    conversation: conversation(0),
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  await handle.ask([asked]);
  const [reply] = drain(channel).map((l) => JSON.parse(l) as { response: { request_id: string; response: { behavior: string } } });
  assert.equal(reply!.response.request_id, "req-9");
  assert.equal(reply!.response.response.behavior, "deny");
});

test("a question a person can answer is stored and announced, and the answer goes in ahead of parked messages", async () => {
  const channel = new LineChannel();
  const recorded: LiveAsk[] = [];
  const announced: string[] = [];
  const shown: string[] = [];
  let answered = [{ id: "row-1", ask: asked, answers: { "Which?": "B" } }];
  const handle = attachLiveConversation({
    runId: "r11",
    wire: claudeWire(),
    liveChannel: channel,
    conversation: {
      ...conversation(0),
      claim: async () => [{ id: "m1", text: "also, use tabs" }],
      questions: {
        record: async (a) => {
          recorded.push(a);
          return "row-1";
        },
        claimAnswers: async () => {
          const taken = answered;
          answered = [];
          return taken;
        },
        requeueAnswers: async () => {},
        withdraw: async () => {},
      },
    },
    sayAsUser: async (text) => {
      shown.push(text);
    },
    saySystem: async () => {},
    sayAsked: async (id) => {
      announced.push(id);
    },
  });
  await handle.ask([asked]);
  assert.deepEqual(recorded.map((a) => a.id), ["req-9"]);
  assert.deepEqual(announced, ["row-1"], "the transcript line names the stored question");
  assert.equal(channel.pending, 0, "nothing is written until a person answers");

  assert.equal(await handle.pump(), true);
  const lines = drain(channel).map((l) => JSON.parse(l) as { type: string; response?: { response: { updatedInput: { answers: unknown } } } });
  assert.deepEqual(lines.map((l) => l.type), ["control_response", "user"], "the answer first: the agent is blocked on it");
  assert.deepEqual(lines[0]!.response!.response.updatedInput.answers, { "Which?": "B" });
  assert.deepEqual(shown, ["Which? B", "also, use tabs"]);
});

test("a turn that ends withdraws what the agent asked in it, since it waits on nothing now", async () => {
  const channel = new LineChannel();
  const withdrawn: string[][] = [];
  let release!: () => void;
  const recordedLate = new Promise<void>((r) => (release = r));
  const handle = attachLiveConversation({
    runId: "r12",
    wire: claudeWire(),
    liveChannel: channel,
    conversation: {
      ...conversation(0),
      questions: {
        // A slow insert: the turn's end must not withdraw before the row exists.
        record: async () => {
          await recordedLate;
          return "row-1";
        },
        claimAnswers: async () => [],
        requeueAnswers: async () => {},
        withdraw: async (ids) => {
          withdrawn.push(ids);
        },
      },
    },
    sayAsUser: async () => {},
    saySystem: async () => {},
  });
  const asking = handle.ask([asked, { ...asked, id: "req-10" }]);
  const cancelled = handle.withdraw(["req-10"]);
  const ending = handle.onTurnFinished(false);
  await tick(20);
  assert.deepEqual(withdrawn, [], "nothing is withdrawn while its row is still being written");
  release();
  await Promise.all([asking, cancelled, ending]);
  assert.deepEqual(withdrawn, [["req-10"], ["req-9"]], "the turn's end withdrew the rest, once recorded");
  await handle.onTurnFinished(true);
  assert.equal(withdrawn.length, 2, "nothing asked since, nothing withdrawn");
});
