import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BentoClient } from "@bento/api-client";
import {
  AgentSession,
  isLongQuietRun,
  runDuration,
  withNoLiveTranscriptNote,
  type ChatItem,
} from "./components/AgentSession.js";

const client = {} as unknown as BentoClient;
const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

/** A minimal, spec-compliant Storage that never remembers anything. */
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

function storageWith(saved: string): Storage {
  return { ...storageWithout(), getItem: () => saved };
}

function withStorage(storage: Storage, run: () => void) {
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  try {
    run();
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
  }
}

test("AgentSession opens with detail shown when defaultShowDetail is set and nothing is saved", () => {
  withStorage(storageWithout(), () => {
    const html = renderToStaticMarkup(
      createElement(AgentSession, {
        client,
        featureId: "f1",
        runs: [],
        profiles: [],
        finished: false,
        onChanged() {},
        defaultShowDetail: true,
      }),
    );
    assert.match(html, /aria-pressed="true"/);
  });
});

test("AgentSession opens with detail hidden when defaultShowDetail is absent and nothing is saved", () => {
  withStorage(storageWithout(), () => {
    const html = renderToStaticMarkup(
      createElement(AgentSession, {
        client,
        featureId: "f1",
        runs: [],
        profiles: [],
        finished: false,
        onChanged() {},
      }),
    );
    assert.match(html, /aria-pressed="false"/);
  });
});

test("AgentSession prefers a saved preference over defaultShowDetail", () => {
  withStorage(storageWith("0"), () => {
    const html = renderToStaticMarkup(
      createElement(AgentSession, {
        client,
        featureId: "f1",
        runs: [],
        profiles: [],
        finished: false,
        onChanged() {},
        defaultShowDetail: true,
      }),
    );
    assert.match(html, /aria-pressed="false"/);
  });
});

test("AgentSession keeps detail shown when the saved preference is on", () => {
  withStorage(storageWith("1"), () => {
    const html = renderToStaticMarkup(
      createElement(AgentSession, {
        client,
        featureId: "f1",
        runs: [],
        profiles: [],
        finished: false,
        onChanged() {},
        defaultShowDetail: false,
      }),
    );
    assert.match(html, /aria-pressed="true"/);
  });
});

test("AgentSession showDetail overrides a saved preference for durable previews", () => {
  withStorage(storageWith("0"), () => {
    const html = renderToStaticMarkup(
      createElement(AgentSession, {
        client,
        featureId: "f1",
        runs: [],
        profiles: [],
        finished: false,
        onChanged() {},
        showDetail: true,
      }),
    );
    assert.match(html, /aria-pressed="true"/);
  });
});

test("the quiet-run clock crosses its warning threshold at 30 minutes", () => {
  const startedAt = "2026-08-26T00:00:00.000Z";
  const start = new Date(startedAt).getTime();
  assert.equal(runDuration(startedAt, start + 4 * 60_000 + 12_000), "4m 12s");
  assert.equal(isLongQuietRun(startedAt, start + 30 * 60_000 - 1), false);
  assert.equal(isLongQuietRun(startedAt, start + 30 * 60_000), true);
});

test("the Harness explanation sits immediately before its final answer", () => {
  const items: ChatItem[] = [
    { key: "user", kind: "message", role: "user", text: "Implement it", speaker: "you" },
    { key: "result", kind: "result", ok: true },
    { key: "answer", kind: "message", role: "assistant", text: "Implemented", speaker: "Harness" },
  ];
  const noted = withNoLiveTranscriptNote(items, "run", "DeepSeek Harness");
  assert.deepEqual(
    noted.map((item) => item.key),
    ["user", "result", "run-quiet-note", "answer"],
  );
  assert.match(noted[2]?.kind === "message" ? noted[2].text : "", /DeepSeek Harness printed its final message/);
  assert.deepEqual(items.map((item) => item.key), ["user", "result", "answer"], "the source transcript is not mutated");
  const unlabeled = withNoLiveTranscriptNote(items, "run");
  assert.match(unlabeled[2]?.kind === "message" ? unlabeled[2].text : "", /This tool printed its final message/);
});
