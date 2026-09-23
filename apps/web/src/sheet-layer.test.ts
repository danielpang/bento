import assert from "node:assert/strict";
import test from "node:test";
import { sheetLift, shouldBlockSheetScroll } from "./sheet-layer.js";

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
