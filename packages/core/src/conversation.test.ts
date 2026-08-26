import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRunPrompt,
  compactTranscript,
  forgetsBetweenRuns,
  hasNoLiveTranscript,
  shouldHoldLiveSession,
} from "./conversation.js";

test("a fresh stage run is the stage prompt", () => {
  assert.equal(
    agentRunPrompt({ cli: "codex", followUp: null, stagePrompt: "Implement the feature.", resume: false }),
    "Implement the feature.",
  );
  assert.equal(
    agentRunPrompt({ cli: "codex", followUp: "", stagePrompt: "Implement the feature.", resume: true }),
    "Implement the feature.",
  );
});

test("a resumed session is the follow-up alone", () => {
  assert.equal(
    agentRunPrompt({
      cli: "codex",
      followUp: "Please add a test.",
      stagePrompt: "Stage context",
      resume: true,
    }),
    "Please add a test.",
  );
});

test("a judge keeps its own prompt even without a session", () => {
  assert.equal(
    agentRunPrompt({
      cli: "claude-code",
      followUp: "You are the completion judge. VERDICT.",
      stagePrompt: "Stage context",
      resume: false,
      compacted: "you: please ship it",
      kind: "judge",
    }),
    "You are the completion judge. VERDICT.",
  );
});

test("a cold follow-up carries the stage prompt, compacted history, and the new message", () => {
  const prompt = agentRunPrompt({
    cli: "codex",
    followUp: "Also handle the empty case.",
    stagePrompt: "Implement the feature from the card.",
    resume: false,
    compacted: "you: ship it\nagent: committed",
  });
  assert.match(prompt, /^Implement the feature from the card\./);
  assert.match(prompt, /Previous conversation on this card, compacted:/);
  assert.match(prompt, /you: ship it/);
  assert.match(prompt, /agent: committed/);
  assert.match(prompt, /User follow-up:\nAlso handle the empty case\.$/);
});

test("pool and dsh follow-ups stay cold even when a session id exists", () => {
  assert.equal(forgetsBetweenRuns("pool"), true);
  assert.equal(forgetsBetweenRuns("dsh"), true);
  assert.equal(forgetsBetweenRuns("codex"), false);
  assert.equal(hasNoLiveTranscript("dsh"), true);
  assert.equal(hasNoLiveTranscript("pool"), false);
  assert.equal(hasNoLiveTranscript("codex"), false);
  const prompt = agentRunPrompt({
    cli: "pool",
    followUp: "Please also add a test.",
    stagePrompt: "Implement the feature from the card.",
    resume: true,
  });
  assert.match(prompt, /^Implement the feature from the card\./);
  assert.match(prompt, /User follow-up:\nPlease also add a test\.$/);
  assert.doesNotMatch(prompt, /compacted/);
});

test("compactTranscript keeps the newest turns inside the budget", () => {
  const compacted = compactTranscript(
    [
      { role: "user", text: "first" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "second" },
      { role: "assistant", text: "done" },
    ],
    40,
  );
  assert.match(compacted, /you: second/);
  assert.match(compacted, /agent: done/);
  assert.doesNotMatch(compacted, /first/);
});

test("compactTranscript trims an oversize oldest line rather than dropping the newest", () => {
  const compacted = compactTranscript([{ role: "assistant", text: "A".repeat(80) }], 30);
  assert.match(compacted, /^agent: A+/);
  assert.ok(compacted.endsWith("..."));
  assert.ok(compacted.length <= 30);
});

test("compactTranscript skips empty turns", () => {
  assert.equal(compactTranscript([{ role: "user", text: "  " }]), "");
  assert.equal(
    compactTranscript([
      { role: "user", text: "  hi  \n there " },
      { role: "assistant", text: "ok" },
    ]),
    "you: hi there\nagent: ok",
  );
});

test("a live session holds only a successful turn on a manual stage", () => {
  assert.equal(shouldHoldLiveSession({ ok: true, kind: "task", gateType: "manual", idleSec: 90 }), true);
  assert.equal(shouldHoldLiveSession({ ok: true, kind: "task", gateType: "auto", idleSec: 90 }), false);
  assert.equal(shouldHoldLiveSession({ ok: false, kind: "task", gateType: "manual", idleSec: 90 }), false);
  assert.equal(shouldHoldLiveSession({ ok: true, kind: "judge", gateType: "manual", idleSec: 90 }), false);
  assert.equal(shouldHoldLiveSession({ ok: true, kind: "task", gateType: "manual", idleSec: 0 }), false);
});
