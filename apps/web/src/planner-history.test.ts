import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { Window } from "happy-dom";
import type { BentoClient } from "@bento/api-client";
import { SwarmRunOutput } from "./components/SwarmRunOutput.js";

const EARLIEST_SEQ = 2_147_483_647;

type Page = {
  events: { type: "message"; role: "assistant"; text: string }[];
  firstSeq: number | null;
  earlier: number;
};

type Call = { id: string; seq: number; signal?: AbortSignal };

function page(text: string, firstSeq: number | null = 1, earlier = 0): Page {
  return { events: [{ type: "message", role: "assistant", text }], firstSeq, earlier };
}

function harness() {
  const calls: Call[] = [];
  const pending = new Map<number, { resolve: (page: Page) => void; reject: (err: unknown) => void }>();
  const client = {
    streamRun() {
      return () => {};
    },
    getEventsBefore(id: string, seq: number, _limit?: number, signal?: AbortSignal) {
      const index = calls.length;
      calls.push({ id, seq, signal });
      return new Promise<Page>((resolve, reject) => {
        const drop = () => {
          pending.delete(index);
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        };
        if (signal?.aborted) {
          drop();
          return;
        }
        signal?.addEventListener("abort", drop, { once: true });
        pending.set(index, { resolve, reject });
      });
    },
  } as unknown as BentoClient;

  function take(index: number) {
    const entry = pending.get(index);
    assert.ok(entry, `no read waiting at ${index}`);
    pending.delete(index);
    return entry;
  }

  return {
    client,
    calls,
    resolve(index: number, result: Page) {
      take(index).resolve(result);
    },
    reject(index: number, err: unknown) {
      take(index).reject(err);
    },
  };
}

let tail: Promise<void> = Promise.resolve();

/** The drawer test shares one DOM. Cases take it one at a time. */
function serial(body: () => Promise<void>): Promise<void> {
  const previous = tail;
  let release: () => void = () => {};
  tail = new Promise((resolve) => { release = resolve; });
  return previous.then(body, body).finally(release);
}

function installDom(): { window: Window; restore: () => void } {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    DocumentFragment: globalThis.DocumentFragment,
    navigator: globalThis.navigator,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const window = new Window({ url: "https://app.usebento.ai/swarms" });
  const installed = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  // Node's navigator is a getter, so assignment has to go through the descriptor.
  for (const [key, value] of Object.entries(installed)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    window,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
    },
  };
}

function count(html: string, sentence: string): number {
  return html.split(sentence).length - 1;
}

function labeled(container: { querySelectorAll(selector: string): Iterable<{ textContent: string | null; click(): void }> }, label: string) {
  const found = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  assert.ok(found, `missing ${label}`);
  return found;
}

const runs = [1, 2, 3].map((index) => ({
  id: `run-${index}`,
  queuedAt: `2026-09-04T12:0${index}:00.000Z`,
  endedAt: `2026-09-04T12:0${index}:30.000Z`,
}));

test("a failed earlier planner run can be retried while another read is still outstanding", () => serial(async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const history = harness();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(createElement(SwarmRunOutput, {
        client: history.client,
        runId: "run-now",
        agentName: "Staff Engineer",
        plannerRuns: runs,
      }));
    });
    assert.deepEqual(history.calls.map((call) => call.id), ["run-1", "run-2", "run-3"]);
    assert.ok(history.calls.every((call) => call.seq === EARLIEST_SEQ));

    await act(async () => {
      history.resolve(0, page("the first plan"));
      history.reject(1, new Error("offline"));
    });
    let html = container.innerHTML;
    assert.equal(count(html, "Loading earlier planner output..."), 1);
    assert.equal(count(html, "Could not load earlier planner output."), 1);
    assert.equal(count(html, "Try again"), 1);
    assert.equal(count(html, "the first plan"), 1);

    await act(async () => {
      labeled(container, "Try again").click();
    });
    assert.equal(history.calls[2]?.signal?.aborted, true, "the read that had not answered is aborted");
    assert.deepEqual(history.calls.slice(3).map((call) => [call.id, call.seq]), [
      ["run-2", EARLIEST_SEQ],
      ["run-3", EARLIEST_SEQ],
    ]);
    assert.equal(history.calls.filter((call) => call.id === "run-1").length, 1, "a loaded run is not fetched again");

    await act(async () => {
      history.resolve(3, page("the retried plan"));
    });
    html = container.innerHTML;
    assert.equal(count(html, "Could not load earlier planner output."), 0);
    assert.equal(count(html, "Loading earlier planner output..."), 1);
    assert.equal(count(html, "the first plan"), 1);
    assert.equal(count(html, "the retried plan"), 1);
  } finally {
    await act(async () => { root.unmount(); });
    await dom.window.happyDOM.abort();
    dom.restore();
  }
}));

test("load earlier prepends one page, and a failed page stays for retry", () => serial(async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const history = harness();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(createElement(SwarmRunOutput, {
        client: history.client,
        runId: "run-now",
        agentName: "Staff Engineer",
        plannerRuns: [runs[0]!],
      }));
    });
    await act(async () => {
      history.resolve(0, page("later line", 10, 4));
    });
    const load = labeled(container, "Load earlier output");
    await act(async () => {
      load.click();
      load.click();
    });
    assert.deepEqual(history.calls.slice(1).map((call) => call.seq), [10], "a second click does not fetch the same page twice");

    await act(async () => {
      history.reject(1, new Error("offline"));
    });
    let html = container.innerHTML;
    assert.equal(count(html, "later line"), 1);
    assert.equal(count(html, "Could not load earlier planner output."), 1);

    await act(async () => {
      labeled(container, "Try again").click();
    });
    assert.deepEqual(history.calls.slice(2).map((call) => [call.id, call.seq]), [["run-1", 10]]);

    await act(async () => {
      history.resolve(2, page("earlier line", 4, 0));
    });
    html = container.innerHTML;
    assert.ok(html.indexOf("earlier line") < html.indexOf("later line"));
    assert.equal(count(html, "earlier line"), 1);
    assert.equal(count(html, "later line"), 1);
    assert.equal(count(html, "Could not load earlier planner output."), 0);
    assert.equal(container.querySelectorAll("button").length, 0);
  } finally {
    await act(async () => { root.unmount(); });
    await dom.window.happyDOM.abort();
    dom.restore();
  }
}));
