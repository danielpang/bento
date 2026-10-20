import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASCOT_MAX_CARDS, showBoardMascots } from "./board-mascots.js";
import { BoardMascots } from "./components/BoardMascots.js";
import { BOIL_FRAMES, sketchMascot } from "./mascot-sketch.js";

test("the mascots come out only on a quiet, unfiltered board with the drawer closed", () => {
  assert.equal(showBoardMascots({ cards: 0, drawerOpen: false, narrowed: false }), true);
  assert.equal(showBoardMascots({ cards: MASCOT_MAX_CARDS, drawerOpen: false, narrowed: false }), true);
  assert.equal(showBoardMascots({ cards: MASCOT_MAX_CARDS + 1, drawerOpen: false, narrowed: false }), false);
  assert.equal(showBoardMascots({ cards: 1, drawerOpen: true, narrowed: false }), false);
  assert.equal(showBoardMascots({ cards: 1, drawerOpen: false, narrowed: true }), false);
});

test("the mascots are decoration: hidden from assistive technology, and they ask both questions", () => {
  const html = renderToStaticMarkup(createElement(BoardMascots));
  assert.match(html, /^<div class="board-mascots" aria-hidden="true">/);
  assert.match(html, /What are we working on\?/);
  assert.match(html, /What should we build\?/);
});

test("the mascots are sketched like the videos: seeded, and boiling across distinct frames", () => {
  const a = sketchMascot("orange", 95, 140, 0.9, 1);
  const b = sketchMascot("orange", 95, 140, 0.9, 1);
  assert.deepEqual(a, b);
  assert.equal(a.frames.length, BOIL_FRAMES);
  assert.equal(new Set(a.frames.map((frame) => frame.ink[0]!.d)).size, BOIL_FRAMES);
  // Two passes per outline, the second thinner, and the body hatched.
  assert.equal(a.frames[0]!.ink.length, 2);
  assert.ok(a.frames[0]!.ink[1]!.width < a.frames[0]!.ink[0]!.width);
  assert.match(a.frames[0]!.hatch, /^M/);
});
