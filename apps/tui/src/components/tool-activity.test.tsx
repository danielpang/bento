import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@bento/core";
import { toolActivity, toolDetail } from "./tool-activity.js";
import {
  conversationEvent,
  conversationLines,
  mergeConversationTools,
  type ConversationEntry,
} from "./conversation-layout.js";

function cursor(
  id: string,
  name: string,
  phase: "start" | "end",
  args: unknown,
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
const entries = (...events: AgentEvent[]) => events.flatMap((event) => conversationEvent(event, "Cursor"));

test("Cursor tools explain files, searches, edits and commands from existing raw events", () => {
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
    const tool = entries(cursor("call", name, "start", args))[0]!.tool!;
    assert.equal(tool.summary, expected);
    assert.doesNotMatch(toolDetail(tool), /call_id|ToolCall/);
  }
  const tool = entries(
    cursor(
      "command",
      "shellToolCall",
      "end",
      { command: "pnpm test" },
      {
        success: { exitCode: 1, stdout: "2 passed", stderr: "1 failed" },
      },
    ),
  )[0]!.tool!;
  assert.equal(tool.failed, true);
  assert.match(toolDetail(tool), /Exit code: 1\n2 passed\nStandard error:\n1 failed/);
});

test("concurrent calls merge their results and collapse into one row without hiding replies", () => {
  const output = mergeConversationTools(
    entries(
      cursor("read-1", "readToolCall", "start", { path: "one.ts" }),
      cursor("read-2", "readToolCall", "start", { path: "two.ts" }),
      cursor("read-2", "readToolCall", "end", undefined, { success: { content: "second file" } }),
      { type: "message", role: "assistant", text: "I found the issue." },
      cursor("read-1", "readToolCall", "end", undefined, { success: { content: "first file" } }),
    ),
  );
  assert.equal(output.filter((entry) => entry.tool).length, 2);
  assert.equal(output[0]!.tool!.summary, "Read one.ts");
  assert.match(output[0]!.detail!, /first file/);
  assert.match(output[1]!.detail!, /second file/);
  const collapsed = conversationLines(output, 100, false);
  assert.equal(collapsed.filter((line) => line.toolGroup).length, 1);
  assert.equal(collapsed.find((line) => line.toolGroup)?.spinning, false);
  assert.match(
    collapsed.map((line) => line.text).join("\n"),
    /Tool calls · 2 calls.*\n[\s\S]*I found the issue/,
  );
  assert.doesNotMatch(collapsed.map((line) => line.text).join("\n"), /one.ts|readToolCall|first file/);
  const key = collapsed.find((line) => line.toolGroup)!.toolGroup!;
  const expanded = conversationLines(output, 100, false, { [key]: true });
  assert.equal(expanded.filter((line) => line.tool).length, 2);
  assert.match(expanded.map((line) => line.text).join("\n"), /✓ Read one.ts/);
});

test("run boundaries isolate IDs, preserve failure counts, and stop showing completed runs as active", () => {
  const run = (id: string, running: boolean): ConversationEntry => ({
    kind: "run",
    id,
    running,
    label: id,
    text: "",
  });
  const output = mergeConversationTools([
    run("old", false),
    ...entries(cursor("same", "readToolCall", "start", { path: "old.ts" })),
    run("new", true),
    ...entries(cursor("same", "readToolCall", "start", { path: "new.ts" })),
    ...entries(cursor("failed", "shellToolCall", "end", { command: "test" }, { error: "Permission denied" })),
  ]);
  const calls = output.flatMap((entry) => (entry.tool ? [entry.tool] : []));
  assert.equal(calls.length, 3);
  assert.notEqual(calls[0]!.key, calls[1]!.key);
  assert.equal(calls[0]!.stopped, true);
  const groups = conversationLines(output, 100, false).filter((line) => line.toolGroup);
  assert.doesNotMatch(groups[0]!.text, /Tool calling/);
  assert.equal(groups[0]!.spinning, false);
  assert.equal(groups[1]!.spinning, true);
  const expanded = conversationLines(output, 100, true).filter((line) => line.toolGroup);
  assert.ok(expanded.every((line) => !line.spinning));
  assert.match(groups[1]!.text, /Tool calling… · 2 calls · 1 failed/);
});

test("Claude call IDs link a tool result to its filename and input", () => {
  const output = mergeConversationTools(
    entries(
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
    ),
  );
  assert.equal(output.length, 1);
  assert.equal(output[0]!.label, "Read index.ts");
  assert.match(output[0]!.detail!, /export const ok = true/);
});

test("Codex and opencode expose their command output, errors and changed files", () => {
  const codex = toolActivity({
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
  assert.equal(codex.summary, "Run npm test");
  assert.match(toolDetail(codex), /3 passed/);
  const files = toolActivity({
    type: "tool",
    name: "file_change",
    phase: "end",
    raw: { item: { changes: [{ path: "a.ts", kind: "update" }] } },
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

test("tool summaries cannot inject terminal controls and absent details stay honest", () => {
  const output = mergeConversationTools(
    entries(cursor("evil", "readToolCall", "end", { path: "safe\x1b[2J.ts" })),
  );
  assert.doesNotMatch(
    conversationLines(output, 100, true)
      .map((line) => line.text)
      .join("\n"),
    /\x1b/,
  );
  assert.match(
    toolDetail(toolActivity({ type: "tool", name: "unknownToolCall", phase: "start" })),
    /did not record inputs or output/,
  );
});
