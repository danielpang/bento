import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { Feature, Stage } from "@bento/api-client";
import { Kanban, boardLanes, kanbanSelection, kanbanViewport, moveKanban } from "./Kanban.js";

const stages = ["Plan", "Build", "Review"].map((name) => ({ id: name.toLowerCase(), name }) as Stage);
const card = (id: string, stage: string | null = null, status = "active") =>
  ({ id, title: `Card ${id}`, currentStageId: stage, status }) as Feature;

test("Kanban includes empty stages and counts finished cards only in Completed", () => {
  const lanes = boardLanes(stages, [
    card("a"),
    card("b", "build"),
    card("c", "review", "done"),
    card("d", "plan", "cancelled"),
  ]);
  assert.deepEqual(
    lanes.map((lane) => [lane.name, lane.cards.map((f) => f.id)]),
    [
      ["Backlog", ["a"]],
      ["Plan", []],
      ["Build", ["b"]],
      ["Review", []],
      ["Completed", ["c", "d"]],
    ],
  );
});

test("column navigation can focus an empty stage without targeting a card in another stage", () => {
  const lanes = boardLanes(stages, [card("a"), card("b", "build")]);
  const empty = moveKanban(lanes, "a", null, "right");
  assert.deepEqual(empty, { laneId: "plan", cardId: null });
  assert.equal(kanbanSelection(lanes, empty.cardId, empty.laneId).feature, undefined);
  assert.deepEqual(moveKanban(lanes, empty.cardId, empty.laneId, "down"), empty);
  assert.deepEqual(moveKanban(lanes, empty.cardId, empty.laneId, "right"), { laneId: "build", cardId: "b" });
});

test("vertical movement stays within its stage; horizontal movement clamps the row", () => {
  const lanes = boardLanes(stages, [card("a", "plan"), card("b", "plan"), card("c", "build")]);
  assert.deepEqual(moveKanban(lanes, "b", "plan", "down"), { laneId: "plan", cardId: "b" });
  assert.deepEqual(moveKanban(lanes, "b", "plan", "first"), { laneId: "plan", cardId: "a" });
  assert.deepEqual(moveKanban(lanes, "a", "plan", "last"), { laneId: "plan", cardId: "b" });
  assert.deepEqual(moveKanban(lanes, "b", "plan", "right"), { laneId: "build", cardId: "c" });
});

test("selected cards follow live stage changes, completion and search across columns", () => {
  const moved = card("selected", "review");
  let lanes = boardLanes(stages, [card("other"), moved]);
  assert.equal(kanbanSelection(lanes, moved.id, "backlog").lane.id, "review");
  lanes = boardLanes(stages, [card("other"), { ...moved, status: "done" }]);
  assert.equal(kanbanSelection(lanes, moved.id, "review").lane.id, "completed");
  assert.equal(kanbanSelection(boardLanes(stages, []), "deleted", "review").feature, undefined);
});

test("column viewport keeps focus visible at narrow and wide widths", () => {
  for (const width of [38, 58, 78, 118, 238]) {
    for (let focused = 0; focused < 8; focused++) {
      const view = kanbanViewport(width, 24, 8, focused);
      assert.ok(view.start <= focused && focused < view.start + view.visible);
      assert.ok(view.columnWidth * view.visible + view.visible - 1 <= width);
    }
  }
  assert.equal(kanbanViewport(238, 24, 8, 0).visible, 8);
});

test("rendered Kanban retains the selected card and stage counts in bounded terminal height", async () => {
  const cards = Array.from({ length: 40 }, (_, i) => card(String(i), "build"));
  for (const [width, height] of [
    [98, 24],
    [38, 4],
  ] as const) {
    const ui = render(
      <Kanban
        lanes={boardLanes(stages, cards)}
        cardId="39"
        laneId="build"
        runStatus={{ "39": "running" }}
        width={width}
        height={height}
      />,
    );
    try {
      const end = Date.now() + 5000;
      while (!ui.lastFrame()?.includes("Card 39")) {
        if (Date.now() > end) throw new Error(`Kanban did not render: ${ui.lastFrame()}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const frame = ui.lastFrame()!;
      assert.match(frame, /KANBAN · 40 cards/);
      assert.match(frame, /› .*Card 39/);
      assert.match(frame, /Stages .* of 5/);
      assert.ok(frame.split("\n").length <= height, frame);
      assert.doesNotMatch(frame, /Card 0\b/);
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  }
});
