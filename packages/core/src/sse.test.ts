import assert from "node:assert/strict";
import test from "node:test";
import { SseParser } from "./sse.js";

test("SSE frames parse across arbitrary chunk boundaries", () => {
  const parser = new SseParser();
  const frames = [
    ...parser.push("event: run_delta\ndata: {\"a\""),
    ...parser.push(":1}\n\nevent: done\nid: 4\ndata: ok\n\n"),
  ];
  assert.deepEqual(frames, [
    { event: "run_delta", id: "", data: '{"a":1}' },
    { event: "done", id: "4", data: "ok" },
  ]);
});

/**
 * The spec details the first two hand-rolled parsers got wrong:
 * continuation data lines join with a newline, and exactly one
 * leading space after the colon is stripped, no more.
 */
test("SSE multi-line data joins with newlines and keeps its spacing", () => {
  const parser = new SseParser();
  const [frame] = parser.push("data: line one\ndata:  indented\ndata:last\n\n");
  assert.deepEqual(frame, { event: "message", id: "", data: "line one\n indented\nlast" });
});

test("a partial frame stays buffered until its terminator arrives", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: run_event\ndata: {}\n"), []);
  assert.equal(parser.push("\n").length, 1);
});
