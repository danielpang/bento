import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "@bento/core";
import { toolActivity, toolDetail } from "./tool-activity.js";
import { toChatItems } from "./components/AgentSession.js";
import { ToolActivityGroup } from "./components/ToolActivityGroup.js";

function cursor(
  id: string,
  name: string,
  phase: "start" | "end",
  args?: unknown,
  result?: unknown,
): AgentEvent {
  return {
    type: "tool",
    name,
    phase,
    detail: id,
    raw: { call_id: id, tool_call: { [name]: { args, result } } },
  };
}
function calls(events: AgentEvent[], run = "run", running = false) {
  return toChatItems(events, "Cursor", run, running).flatMap((item) =>
    item.kind === "tools" ? item.calls : [],
  );
}

test("recorded Cursor tools describe files, searches, edits and commands", () => {
  for (const [name, args, expected] of [
    ["readToolCall", { path: "src/app.tsx", startLine: 10, endLine: 25 }, "Read src/app.tsx (line 10 to 25)"],
    ["grepToolCall", { pattern: "handleSubmit", path: "src" }, "Search handleSubmit in src"],
    [
      "globToolCall",
      { globPattern: "**/*.test.ts", targetDirectory: "packages" },
      "Find files **/*.test.ts in packages",
    ],
    ["strReplaceToolCall", { path: "app.ts", oldString: "old", newString: "new" }, "Edit app.ts"],
    ["shellToolCall", { command: "pnpm test" }, "Run pnpm test"],
  ] as const) {
    const tool = calls([cursor("call", name, "start", args)])[0]!;
    assert.equal(tool.summary, expected);
    assert.doesNotMatch(toolDetail(tool), /call_id|ToolCall/);
  }
  const tool = calls([
    cursor(
      "cmd",
      "shellToolCall",
      "end",
      { command: "pnpm test" },
      {
        success: { exitCode: 1, stdout: "2 passed", stderr: "1 failed" },
      },
    ),
  ])[0]!;
  assert.equal(tool.failed, true);
  assert.match(toolDetail(tool), /Exit code: 1\n2 passed\nStandard error:\n1 failed/);
});

test("concurrent calls pair their results across assistant messages without reordering the conversation", () => {
  const items = toChatItems(
    [
      cursor("one", "readToolCall", "start", { path: "one.ts" }),
      cursor("two", "readToolCall", "start", { path: "two.ts" }),
      cursor("two", "readToolCall", "end", undefined, { success: { content: "second file" } }),
      { type: "message", role: "assistant", text: "I found the issue." },
      cursor("one", "readToolCall", "end", undefined, { success: { content: "first file" } }),
    ],
    "Cursor",
    "run",
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "tools");
  if (items[0]!.kind !== "tools") throw new Error("Expected tool group");
  assert.equal(items[0]!.calls.length, 2);
  assert.deepEqual(
    items[0]!.calls.map((call) => [call.summary, call.output, call.phase]),
    [
      ["Read one.ts", "first file", "end"],
      ["Read two.ts", "second file", "end"],
    ],
  );
  assert.equal(items[1]!.kind === "message" && items[1]!.text, "I found the issue.");
});

test("IDs are scoped to runs and unmatched calls stop when their run ends", () => {
  const events = [cursor("same", "readToolCall", "start", { path: "a.ts" })];
  const old = calls(events, "old")[0]!;
  const live = calls(events, "new", true)[0]!;
  assert.notEqual(old.key, live.key);
  assert.equal(old.stopped, true);
  assert.equal(live.stopped, false);
  assert.match(toolDetail(old), /Result not recorded/);
  assert.match(toolDetail(live), /Running/);
});

test("Claude results retain the original call's filename and input", () => {
  const result = calls([
    {
      type: "tool",
      name: "Read",
      phase: "start",
      detail: { file_path: "index.ts" },
      raw: {
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "index.ts" } }],
        },
      },
    },
    {
      type: "tool",
      name: "tool_result",
      phase: "end",
      detail: "export const ok = true;",
      raw: {
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "export const ok = true;" }],
        },
      },
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.summary, "Read index.ts");
  assert.match(toolDetail(result[0]!), /export const ok = true/);
});

test("Codex and opencode expose outputs, errors and changed files", () => {
  const command = toolActivity({
    type: "tool",
    name: "command",
    phase: "end",
    raw: {
      item: {
        id: "cmd",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "3 passed",
        exit_code: 0,
      },
    },
  });
  assert.equal(command.summary, "Run npm test");
  assert.match(toolDetail(command), /3 passed/);
  const files = toolActivity({
    type: "tool",
    name: "file_change",
    phase: "end",
    raw: {
      item: { changes: [{ path: "a.ts", kind: "update" }] },
    },
  });
  assert.equal(files.summary, "Changed a.ts");
  const opencode = toolActivity({
    type: "tool",
    name: "bash",
    phase: "end",
    raw: {
      part: {
        callID: "oc",
        tool: "bash",
        state: {
          input: { command: "make" },
          output: "compile error",
          status: "error",
          error: "Build failed",
        },
      },
    },
  });
  assert.equal(opencode.failed, true);
  assert.match(toolDetail(opencode), /compile error/);
  assert.match(toolDetail(opencode), /Build failed/);
});

test("recorded diffs are shown without duplicate file bodies and missing read content is explicit", () => {
  const diff = calls([
    cursor(
      "edit",
      "editToolCall",
      "end",
      { path: "a.ts" },
      {
        success: {
          diffString: "-old\n+new",
          beforeFullFileContent: "before duplicate",
          afterFullFileContent: "after duplicate",
        },
      },
    ),
  ])[0]!;
  assert.equal(diff.output, "-old\n+new");
  const read = calls([
    cursor(
      "read",
      "readToolCall",
      "end",
      { path: "a.ts" },
      {
        success: {
          path: "a.ts",
          contentBlobId: "private-bookkeeping-id",
          fileSize: 42,
        },
      },
    ),
  ])[0]!;
  assert.match(read.output, /File content was not included in the recorded event/);
  assert.doesNotMatch(read.output, /private-bookkeeping-id|contentBlobId/);
  assert.match(
    toolDetail(toolActivity({ type: "tool", name: "unknown", phase: "start" })),
    /did not record inputs or output/,
  );
});

test("groups use native disclosure controls, collapse by default, and expose active and failure counts", () => {
  const tools = calls(
    [
      cursor("read", "readToolCall", "start", { path: "<script>alert(1)</script>" }),
      cursor("shell", "shellToolCall", "end", { command: "make" }, { error: "Permission denied" }),
    ],
    "live",
    true,
  );
  const collapsed = renderToStaticMarkup(
    createElement(ToolActivityGroup, { calls: tools, showDetail: false }),
  );
  assert.match(collapsed, /<details[^>]*><summary/);
  assert.match(collapsed, /Tool calling…/);
  assert.match(collapsed, /2 calls/);
  assert.match(collapsed, /1 failed/);
  assert.doesNotMatch(collapsed, /<script>|chat-tool-call-summary|open=""/);
  const expanded = renderToStaticMarkup(createElement(ToolActivityGroup, { calls: tools, showDetail: true }));
  assert.match(expanded, /open=""/);
  assert.match(expanded, /Read &lt;script&gt;/);
  assert.doesNotMatch(expanded, /<script>/);
});

test("Cursor call IDs are not presented as output when a result was not recorded", () => {
  const tool = calls([cursor("internal-id", "readToolCall", "end", { path: "a.ts" })])[0]!;
  assert.equal(tool.output, "");
  assert.doesNotMatch(toolDetail(tool), /internal-id/);
});
