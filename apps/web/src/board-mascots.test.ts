import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASCOT_MAX_CARDS, showBoardMascots } from "./board-mascots.js";
import { BoardMascots } from "./components/BoardMascots.js";

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
