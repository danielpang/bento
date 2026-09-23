import assert from "node:assert/strict";
import test from "node:test";
import { nearestVerticalScroller, sheetLift, shouldBlockSheetScroll } from "./sheet-layer.js";

test("a closed keyboard leaves the sheet at its resting size", () => {
  assert.equal(sheetLift({ innerHeight: 800, offsetTop: 0, height: 800 }), null);
  assert.equal(sheetLift({ innerHeight: 800, offsetTop: 0, height: 720 }), null);
});

test("an open keyboard pins the sheet to the visible region above the keys", () => {
  assert.deepEqual(sheetLift({ innerHeight: 800, offsetTop: 0, height: 460 }), {
    bottom: 340,
    height: 460,
  });
});

test("a panned visual viewport still ends the sheet at the top of the keyboard", () => {
  assert.deepEqual(sheetLift({ innerHeight: 800, offsetTop: 80, height: 420 }), {
    bottom: 300,
    height: 420,
  });
});

test("a drag on the sheet does not scroll the page behind it", () => {
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -40,
      scroller: null,
    }),
    true,
  );
  assert.equal(
    shouldBlockSheetScroll({
      inside: false,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -20,
      scroller: null,
    }),
    true,
  );
});

test("a transcript with room left keeps the drag", () => {
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -30,
      scroller: { scrollTop: 10, clientHeight: 200, scrollHeight: 800 },
    }),
    false,
  );
});

test("a transcript at its end does not chain into the board", () => {
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -12,
      scroller: { scrollTop: 600, clientHeight: 200, scrollHeight: 800 },
    }),
    true,
  );
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: 12,
      scroller: { scrollTop: 0, clientHeight: 200, scrollHeight: 800 },
    }),
    true,
  );
});

test("a dialog portaled out of the sheet scrolls when it has room", () => {
  assert.equal(
    shouldBlockSheetScroll({
      inside: false,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -40,
      scroller: { scrollTop: 20, clientHeight: 400, scrollHeight: 900 },
    }),
    false,
  );
  assert.equal(
    shouldBlockSheetScroll({
      inside: false,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -40,
      scroller: { scrollTop: 500, clientHeight: 400, scrollHeight: 900 },
    }),
    true,
  );
});

test("a drag outside the sheet cannot use a scroller behind it", () => {
  const board = box("board", null, true);
  const sheet = box("sheet", board, false);
  const page = box("page", board, true);
  assert.equal(pick(page, sheet, -40), null);
  assert.equal(
    shouldBlockSheetScroll({
      inside: false,
      editable: false,
      lockOutside: true,
      deltaX: 0,
      deltaY: -40,
      scroller: null,
    }),
    true,
  );
});

test("a dialog keeps its own scroller and does not reach the page", () => {
  const page = box("page", null, true);
  const dialog = box("dialog", page, false);
  const form = box("form", dialog, true);
  assert.equal(pick(form, dialog, -40), form);
});

test("a nested scroller at its edge hands the drag to the sheet", () => {
  const sheet = box("sheet", null, true);
  const inner = box("inner", sheet, true);
  inner.scrollTop = inner.scrollHeight - inner.clientHeight;
  assert.equal(pick(inner, sheet, -30), sheet);
  sheet.scrollTop = sheet.scrollHeight - sheet.clientHeight;
  assert.equal(pick(inner, sheet, -30), sheet);
});

test("typing and sideways pans are left to the control under the finger", () => {
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: true,
      lockOutside: true,
      deltaX: 0,
      deltaY: -20,
      scroller: null,
    }),
    false,
  );
  assert.equal(
    shouldBlockSheetScroll({
      inside: true,
      editable: false,
      lockOutside: true,
      deltaX: 40,
      deltaY: -8,
      scroller: null,
    }),
    false,
  );
});

interface Box {
  parent: Box | null;
  scrolling: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

function box(_name: string, parent: Box | null, scrolling: boolean): Box {
  return { parent, scrolling, scrollTop: 0, clientHeight: 200, scrollHeight: 800 };
}

function pick(start: Box, boundary: Box, deltaY: number): Box | null {
  return nearestVerticalScroller({
    start,
    boundary,
    deltaY,
    parent: (node) => node.parent,
    canScroll: (node) => node.scrolling && node.scrollHeight > node.clientHeight + 1,
    hasRoom: (node, dy) => {
      if (dy === 0) return false;
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if (dy > 0 && atTop) return false;
      if (dy < 0 && atBottom) return false;
      return true;
    },
  });
}
