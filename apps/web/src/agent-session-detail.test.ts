import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BentoClient } from "@bento/api-client";
import { AgentSession } from "./components/AgentSession.js";

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
