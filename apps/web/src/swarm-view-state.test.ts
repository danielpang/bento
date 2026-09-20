import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_MODE_KEY,
  SWARM_VIEW_KEY,
  boardHref,
  boardSearch,
  memoryStorage,
  readBoardMode,
  readSwarmId,
  readSwarmView,
  rememberBoardMode,
  rememberSwarmId,
  rememberSwarmView,
  resolveBoardMode,
  resolveSwarmId,
  resolveSwarmView,
  swarmKey,
} from "./swarm/view-state.js";

/**
 * Which board, which swarm, which view, and where each answer is
 * kept.
 *
 * The address is what a person sends to somebody else, so it wins.
 * localStorage is what a person comes back to, so it answers when the
 * address says nothing. These assert both halves of that round trip,
 * including the case that has bitten this console before: a
 * remembered id belonging to something this session cannot see.
 */

const swarms = [
  { id: "sw-1", archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "sw-2", archivedAt: null, createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "sw-old", archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-01-15T00:00:00.000Z" },
];

test("pipeline is the board anybody who never touched the toggle gets", () => {
  assert.equal(resolveBoardMode("", null), "pipeline");
  assert.equal(resolveBoardMode("?feature=abc", null), "pipeline");
  // A mistyped parameter is not a board.
  assert.equal(resolveBoardMode("?board=swarm", null), "pipeline");
  assert.equal(resolveBoardMode("?board=", "swarms"), "swarms");
});

test("the address wins over what this browser remembers", () => {
  assert.equal(resolveBoardMode("?board=swarms", "pipeline"), "swarms");
  assert.equal(resolveBoardMode("?board=pipeline", "swarms"), "pipeline");
  assert.equal(resolveBoardMode("", "swarms"), "swarms");
});

test("the board mode round trips through storage", () => {
  const storage = memoryStorage();
  assert.equal(readBoardMode("", storage), "pipeline");
  rememberBoardMode(storage, "swarms");
  assert.equal(storage.getItem(BOARD_MODE_KEY), "swarms");
  assert.equal(readBoardMode("", storage), "swarms");
  rememberBoardMode(storage, "pipeline");
  assert.equal(readBoardMode("", storage), "pipeline");
});

test("the view round trips the same way, and defaults to the tree", () => {
  const storage = memoryStorage();
  assert.equal(resolveSwarmView("", null), "tree");
  assert.equal(resolveSwarmView("?view=outline", null), "outline");
  assert.equal(resolveSwarmView("?view=nonsense", "outline"), "outline");
  rememberSwarmView(storage, "outline");
  assert.equal(storage.getItem(SWARM_VIEW_KEY), "outline");
  assert.equal(readSwarmView("", storage), "outline");
  // And the address still overrides it for whoever follows a link.
  assert.equal(readSwarmView("?view=tree", storage), "tree");
});

test("a browser that refuses storage still resolves every choice", () => {
  const refusing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readBoardMode("?board=swarms", refusing), "swarms");
  assert.equal(readBoardMode("", refusing), "pipeline");
  assert.equal(readSwarmView("", refusing), "tree");
  rememberBoardMode(refusing, "swarms");
  assert.equal(readBoardMode("", null), "pipeline");
});

test("the last opened swarm is the default, and the newest one when there is none", () => {
  const storage = memoryStorage();
  // Newest last, so a project you have never opened lands on the end
  // of the strip.
  assert.equal(readSwarmId("", storage, "p1", swarms), "sw-2");
  rememberSwarmId(storage, "p1", "sw-1");
  assert.equal(storage.getItem(swarmKey("p1")), "sw-1");
  assert.equal(readSwarmId("", storage, "p1", swarms), "sw-1");
  // Per project: another board's memory is not this one's.
  assert.equal(readSwarmId("", storage, "p2", swarms), "sw-2");
});

test("a remembered swarm that is no longer there falls back rather than hanging", () => {
  assert.equal(resolveSwarmId("", "sw-deleted", swarms), "sw-2");
  assert.equal(resolveSwarmId("?swarm=sw-deleted", "sw-1", swarms), "sw-1");
  assert.equal(resolveSwarmId("", null, []), null);
});

test("an archived swarm opens by link but is never the fallback", () => {
  assert.equal(resolveSwarmId("?swarm=sw-old", null, swarms), "sw-old");
  assert.equal(resolveSwarmId("", "sw-old", swarms), "sw-old");
  const onlyArchived = [swarms[2]!];
  assert.equal(resolveSwarmId("", null, onlyArchived), null);
});

test("the address spells out every choice, and keeps what was already there", () => {
  assert.equal(
    boardSearch("?feature=abc", { mode: "swarms", swarmId: "sw-1", view: "outline" }),
    "?feature=abc&board=swarms&swarm=sw-1&view=outline",
  );
  // Written out even when it is the default, so a link opens the same
  // board for whoever receives it.
  assert.equal(boardSearch("", { mode: "pipeline" }), "?board=pipeline");
  // Deselecting drops the parameter rather than leaving a dead id.
  assert.equal(boardSearch("?board=swarms&swarm=sw-1", { swarmId: null }), "?board=swarms");
  assert.equal(boardHref("/", "?board=swarms", { view: "tree" }), "/?board=swarms&view=tree");
  assert.equal(boardHref("/", "", {}), "/");
});

test("switching one choice leaves the others alone", () => {
  const start = "?board=swarms&swarm=sw-1&view=tree";
  assert.equal(boardSearch(start, { view: "outline" }), "?board=swarms&swarm=sw-1&view=outline");
  assert.equal(boardSearch(start, { mode: "pipeline" }), "?board=pipeline&swarm=sw-1&view=tree");
  // And the round trip reads back what was written.
  assert.equal(resolveSwarmView(boardSearch(start, { view: "outline" }), null), "outline");
  assert.equal(resolveBoardMode(boardSearch(start, { mode: "pipeline" }), "swarms"), "pipeline");
  assert.equal(resolveSwarmId(boardSearch(start, { view: "outline" }), null, swarms), "sw-1");
});
