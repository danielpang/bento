import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentProfile, AgentRun, BentoClient } from "@bento/api-client";
import { AgentSession, composerPrompt } from "./components/AgentSession.js";

const client = {} as unknown as BentoClient;
const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

function storageWithout(): Storage {
  return {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
    key: () => null,
    length: 0,
  } as Storage;
}

function withStorage(run: () => void) {
  (globalThis as { localStorage?: Storage }).localStorage = storageWithout();
  try {
    run();
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
}

function profile(cli: AgentProfile["cli"]): AgentProfile {
  return { id: "p1", name: "Staff Engineer", cli, model: "x" };
}

function run(status: AgentRun["status"]): AgentRun {
  return {
    id: "r1",
    featureId: "f1",
    stageId: "s1",
    agentProfileId: "p1",
    status,
    cliSessionId: null,
    costUsd: null,
    error: null,
    queuedAt: "2026-08-19T00:00:00.000Z",
    startedAt: "2026-08-19T00:00:00.000Z",
    endedAt: status === "running" ? null : "2026-08-19T00:01:00.000Z",
  };
}

function renderComposer(status: AgentRun["status"], cli: AgentProfile["cli"]): string {
  return renderToStaticMarkup(
    createElement(AgentSession, {
      client,
      featureId: "f1",
      runs: [run(status)],
      profiles: [profile(cli)],
      finished: false,
      onChanged() {},
    }),
  );
}

test("composerPrompt sends when nothing is running or the tool steers live", () => {
  assert.deepEqual(composerPrompt(false, undefined), {
    placeholder: "Send a message...",
    ariaLabel: "Send a message",
  });
  assert.deepEqual(composerPrompt(false, "queue"), {
    placeholder: "Send a message...",
    ariaLabel: "Send a message",
  });
  assert.deepEqual(composerPrompt(true, "steer"), {
    placeholder: "Send a message...",
    ariaLabel: "Send a message",
  });
});

test("composerPrompt queues when a live tool waits or the run must finish first", () => {
  assert.deepEqual(composerPrompt(true, "queue"), {
    placeholder: "Queue a message...",
    ariaLabel: "Queue a message",
  });
  assert.deepEqual(composerPrompt(true, undefined), {
    placeholder: "Queue a message...",
    ariaLabel: "Queue a message",
  });
});

test("AgentSession names the idle composer Send a message, not the agent", () => {
  withStorage(() => {
    const html = renderComposer("succeeded", "claude-code");
    assert.match(html, /placeholder="Send a message\.\.\."/);
    assert.match(html, /aria-label="Send a message"/);
    assert.doesNotMatch(html, /Message Staff Engineer/);
  });
});

test("AgentSession names a live-steer composer Send a message", () => {
  withStorage(() => {
    const html = renderComposer("running", "pi");
    assert.match(html, /placeholder="Send a message\.\.\."/);
    assert.match(html, /aria-label="Send a message"/);
    assert.doesNotMatch(html, /Steer Staff Engineer/);
  });
});

test("AgentSession names a waiting composer Queue a message", () => {
  withStorage(() => {
    const queued = renderComposer("running", "claude-code");
    const betweenRuns = renderComposer("running", "codex");
    assert.match(queued, /placeholder="Queue a message\.\.\."/);
    assert.match(queued, /aria-label="Queue a message"/);
    assert.match(betweenRuns, /placeholder="Queue a message\.\.\."/);
    assert.doesNotMatch(queued, /Message Staff Engineer/);
  });
});

test("AgentSession tells a running pool composer the follow-up is a new run", () => {
  withStorage(() => {
    const html = renderComposer("running", "pool");
    assert.match(html, /as a new run/);
    assert.match(html, /compacted transcript/);
    assert.doesNotMatch(html, /resume|same session/);
  });
});

test("AgentSession tells an idle pool composer the next run carries a compacted transcript", () => {
  withStorage(() => {
    const html = renderComposer("succeeded", "pool");
    assert.match(html, /compacted transcript of this conversation/);
    assert.doesNotMatch(html, /continuing the same conversation/);
  });
});

test("AgentSession composer is a one-line textarea so a long line can grow it", () => {
  withStorage(() => {
    const html = renderComposer("succeeded", "claude-code");
    assert.match(html, /<textarea[^>]*class="input composer-input"/);
    assert.match(html, /rows="1"/);
    assert.doesNotMatch(html, /<input[^>]*class="input composer-input"/);
  });
});

test("AgentSession explains the quiet DeepSeek Harness run", () => {
  withStorage(() => {
    const html = renderComposer("running", "dsh");
    assert.match(html, /No live output from this tool/);
    assert.match(html, /prints one final message when the run ends/);
    assert.match(html, /Working for/);
    assert.match(html, /as a new run with a compacted transcript/);
  });
});

test("AgentSession still describes a running resumable tool as continuing", () => {
  withStorage(() => {
    const html = renderComposer("running", "codex");
    assert.match(html, /the moment the current run ends\./);
    assert.doesNotMatch(html, /as a new run/);
  });
});
