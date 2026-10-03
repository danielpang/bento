import assert from "node:assert/strict";
import test from "node:test";
import { readProjectSelection, rememberProjectSelection } from "./project-selection.js";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

function browser(localStorage = storage(), href = "https://bento.test/") {
  const location = { href };
  return {
    location,
    localStorage,
    sessionStorage: storage(),
    history: {
      state: { existing: true },
      replaceState: (_state: unknown, _unused: string, next: string | URL | null | undefined) => { location.href = String(next); },
    },
  } as Pick<Window, "location" | "history" | "localStorage" | "sessionStorage">;
}

test("desktop windows retain their own project through reloads and native navigation", () => {
  const shared = storage();
  const first = browser(shared);
  const second = browser(shared);
  rememberProjectSelection("first", true, first);
  rememberProjectSelection("second", true, second);
  assert.equal(readProjectSelection(true, first), "first");
  assert.equal(readProjectSelection(true, second), "second");
  first.location.href = "https://bento.test/sessions";
  second.location.href = "https://bento.test/spend";
  assert.equal(readProjectSelection(true, first), "first");
  assert.equal(readProjectSelection(true, second), "second");
  assert.equal(readProjectSelection(true, browser(shared)), "second");
});

test("an explicit project opens independently and follows later selection without losing feature links", () => {
  const window = browser(storage(), "https://bento.test/?project=requested&feature=card#details");
  window.sessionStorage.setItem("bento:projectId", "previous");
  assert.equal(readProjectSelection(true, window), "requested");
  rememberProjectSelection("visible", true, window);
  assert.equal(readProjectSelection(true, window), "visible");
  assert.equal(window.location.href, "https://bento.test/?project=visible&feature=card#details");
  assert.deepEqual(window.history.state, { existing: true });
  rememberProjectSelection(null, true, window);
  assert.equal(readProjectSelection(true, window), null);
  assert.equal(window.location.href, "https://bento.test/?feature=card#details");
});

test("unavailable session storage still uses the default and can retain the selection in the URL", () => {
  const window = browser();
  window.localStorage.setItem("bento:projectId", "default");
  Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Storage unavailable"); } });
  assert.equal(readProjectSelection(true, window), "default");
  rememberProjectSelection("selected", true, window);
  assert.equal(readProjectSelection(true, window), "selected");
});

test("browser tabs retain the existing last-used-project behavior", () => {
  const shared = storage();
  const first = browser(shared, "https://bento.test/?feature=card");
  const second = browser(shared);
  rememberProjectSelection("first", false, first);
  rememberProjectSelection("second", false, second);
  assert.equal(readProjectSelection(false, first), "second");
  assert.equal(first.location.href, "https://bento.test/?feature=card");
  assert.equal(first.sessionStorage.length, 0);
});
