import assert from "node:assert/strict";
import test from "node:test";
import { searchSwarmNodes } from "./swarm/search.js";

const nodes = [
  { id: "root", parentId: null, title: "Ship checkout" },
  { id: "cart", parentId: "root", title: "Cart work" },
  { id: "task-abc123", parentId: "cart", title: "Calculate line totals" },
  { id: "refund", parentId: "root", title: "Refund totals" },
];

test("node search matches titles and partial IDs without case sensitivity", () => {
  assert.deepEqual([...searchSwarmNodes(nodes, "  TOTALS  ").matchIds], ["task-abc123", "refund"]);
  assert.deepEqual([...searchSwarmNodes(nodes, "ABC123").matchIds], ["task-abc123"]);
  assert.deepEqual([...searchSwarmNodes(nodes, "totals calculate").matchIds], ["task-abc123"]);
  assert.equal(searchSwarmNodes(nodes, "calculate refund").matchIds.size, 0);
});

test("empty and whitespace-only searches never highlight the whole tree", () => {
  for (const query of ["", "  \t ", "not found", "[.*]"]) {
    const search = searchSwarmNodes(nodes, query);
    assert.equal(search.matchIds.size, 0);
    assert.equal(search.revealIds.size, 0);
  }
});

test("search reveals every ancestor of a hidden match without revealing unrelated branches", () => {
  const search = searchSwarmNodes(nodes, "abc123");
  assert.deepEqual([...search.revealIds], ["cart", "root"]);
  assert.deepEqual([...search.matchIds], ["task-abc123"]);
  assert.ok(!search.revealIds.has("refund"));
  assert.ok(!search.revealIds.has("task-abc123"), "matching a plan does not need to open all its own children");
});

test("missing parents and cycles in agent-written trees cannot hang search", () => {
  const search = searchSwarmNodes([
    { id: "a", parentId: "b", title: "Find this node" },
    { id: "b", parentId: "a", title: "Parent" },
    { id: "orphan", parentId: "missing", title: "Find another" },
  ], "find");
  assert.deepEqual([...search.matchIds], ["a", "orphan"]);
  assert.deepEqual([...search.revealIds], ["b", "missing"]);
});
