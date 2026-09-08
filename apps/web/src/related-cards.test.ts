import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelatedCard, RelatedGroup } from "@bento/api-client";
import { layoutGroup, RelatedGraph } from "./components/RelatedCards.js";

function related(id: string, extra: Partial<RelatedCard> = {}): RelatedCard {
  return {
    id,
    title: `Card ${id}`,
    status: "active",
    currentStageId: null,
    stageName: null,
    runStatus: null,
    costUsd: null,
    prNumber: null,
    prUrl: null,
    ...extra,
  };
}

function group(children: RelatedCard[]): RelatedGroup {
  return { parent: related("p", { title: "The large one" }), children };
}

function render(g: RelatedGroup, currentId = "p") {
  return renderToStaticMarkup(
    createElement(RelatedGraph, { group: g, currentId, onSelect: () => {} }),
  );
}

/**
 * The acceptance check the investigation names as a bug if it fails: an
 * arrow with a diagonal in it. Orthogonality is a property of how the
 * path is built, so this asserts on the built path data rather than on
 * pixels: M, H and V are the only commands, and none of them can move
 * in two axes at once.
 */
test("every arrow is made only of horizontal and vertical segments", () => {
  const layout = layoutGroup(5);
  assert.equal(layout.links.length, 5);
  for (const link of layout.links) {
    assert.match(link.d, /^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+$/, `diagonal in ${link.d}`);
  }
});

test("the arrows in the rendered view carry no diagonal command either", () => {
  const html = render(group([related("a"), related("b"), related("c")]));
  const paths = [...html.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(paths.length, 3, "one path per part");
  for (const d of paths) {
    assert.ok(!/[LlCcQqSsTtAaZz]/.test(d), `${d} uses a command that can draw a diagonal`);
    assert.ok(!/[hv]/.test(d), `${d} uses a relative command, which the layout never emits`);
  }
});

test("every part is drawn, including one already finished and one in another lane", () => {
  // The whole reason the view reads from the server rather than the
  // board: a part that is done, or that sits in a lane the viewer has
  // scrolled past, must not go missing.
  const html = render(
    group([
      related("a", { title: "Done part", status: "done" }),
      related("b", { title: "Working part", runStatus: "running", stageName: "Implementation" }),
      related("c", { title: "Backlog part" }),
    ]),
  );
  assert.match(html, /Done part/);
  assert.match(html, /Working part/);
  assert.match(html, /Backlog part/);
  assert.match(html, /The large one/, "and the card they were split from");
});

test("a part level with the parent still gets a straight line, not a special case", () => {
  // One child: its centre and the parent's are the same, so the trunk
  // segment has zero length. It must still be one path, not a gap.
  const [only] = layoutGroup(1).links;
  assert.ok(only);
  const parts = only.d.match(/^M [\d.]+ ([\d.]+) H [\d.]+ V ([\d.]+) H [\d.]+$/);
  assert.ok(parts, `unexpected path shape: ${only.d}`);
  assert.equal(parts[1], parts[2], "the line runs straight across");
});

test("the parts stack in the order they were created", () => {
  const boxes = layoutGroup(3).children;
  assert.ok(boxes[0]!.y < boxes[1]!.y);
  assert.ok(boxes[1]!.y < boxes[2]!.y);
  assert.equal(new Set(boxes.map((b) => b.x)).size, 1, "one column");
});

test("exactly one card is marked as the one this view was opened from", () => {
  const html = render(group([related("a"), related("b")]), "a");
  assert.equal(html.match(/data-current=""/g)?.length, 1);
  const marked = html.slice(html.indexOf('data-current=""'));
  assert.match(marked.slice(0, 400), /Card a/, "and it is the card asked for, not the parent");
});
