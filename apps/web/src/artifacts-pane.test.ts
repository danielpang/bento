import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPaneWidth,
  PANE_DEFAULT,
  PANE_MAX,
  PANE_MIN,
  rememberedPaneWidth,
  rememberPaneWidth,
  type StorageWindow,
} from "./artifacts-pane.js";

function memoryBrowser(initial: Record<string, string> = {}): StorageWindow {
  const items = new Map(Object.entries(initial));
  return {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    } as Storage,
  };
}

test("the file list width stays between its bounds and leaves room for the reader", () => {
  assert.equal(clampPaneWidth(50), PANE_MIN);
  assert.equal(clampPaneWidth(5000), PANE_MAX);
  assert.equal(clampPaneWidth(333.4), 333);
  assert.equal(clampPaneWidth(500, 400), 400);
  assert.equal(clampPaneWidth(500, 100), PANE_MIN, "a narrow split still keeps the list usable");
  assert.equal(clampPaneWidth(Number.NaN), PANE_DEFAULT);
});

test("a dragged width is remembered, and anything unreadable is the default", () => {
  const browser = memoryBrowser();
  assert.equal(rememberedPaneWidth(browser), PANE_DEFAULT);
  rememberPaneWidth(420, browser);
  assert.equal(rememberedPaneWidth(browser), 420);
  assert.equal(rememberedPaneWidth(memoryBrowser({ "bento:artifacts-pane-width": "wide" })), PANE_DEFAULT);
  assert.equal(rememberedPaneWidth(memoryBrowser({ "bento:artifacts-pane-width": "9000" })), PANE_MAX);
  const blocked: StorageWindow = {
    localStorage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    } as unknown as Storage,
  };
  assert.equal(rememberedPaneWidth(blocked), PANE_DEFAULT);
  assert.doesNotThrow(() => rememberPaneWidth(300, blocked));
});
