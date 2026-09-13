import type { AgentEvent } from "@bento/core";

export interface ToolActivity {
  id?: string;
  key?: string;
  name: string;
  summary: string;
  input: string;
  output: string;
  phase: "start" | "end";
  failed: boolean;
  stopped?: boolean;
  hasInput: boolean;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (...values: unknown[]) =>
  values.find((value) => typeof value === "string" && value) as string | undefined;
function printable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => record(item).type === "text"))
    return value.map((item) => record(item).text).join("\n");
  return JSON.stringify(value, null, 2);
}

const internalFields = new Set([
  "toolCallId",
  "requestId",
  "conversationId",
  "parsingResult",
  "simpleCommands",
  "skipApproval",
  "adminCommandDenylist",
  "timeoutBehavior",
  "hasInputRedirect",
  "hasOutputRedirect",
  "closeStdin",
  "fileOutputThresholdBytes",
  "contentBlobId",
  "relatedCursorRules",
  "relatedCursorRulePaths",
]);
function fields(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([key, item]) => !internalFields.has(key) && item !== "" && item != null)
    .map(([key, item]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
      const text = printable(item);
      return `${label.charAt(0).toUpperCase() + label.slice(1)}:${text.includes("\n") ? "\n" : " "}${text}`;
    })
    .join("\n");
}

function resultText(value: unknown): string {
  const out = record(value);
  if (typeof out.diffString === "string") return [out.message, out.diffString].filter(Boolean).join("\n\n");
  if (typeof out.content === "string") return out.content;
  if (out.contentBlobId) return `${fields(out)}\nFile content was not included in the recorded event.`;
  if (Array.isArray(out.files))
    return [
      out.totalFiles !== undefined ? `${out.totalFiles} files found` : "Files found",
      ...out.files.map(printable),
    ].join("\n");
  if (Array.isArray(out.todos))
    return out.todos
      .map((item) => {
        const todo = record(item);
        return `${todo.status === "completed" ? "[x]" : "[ ]"} ${string(todo.content, todo.title, todo.text) ?? printable(item)}${todo.status === "in_progress" ? " (in progress)" : ""}`;
      })
      .join("\n");
  return Object.keys(out).length ? fields(out) : printable(value);
}

/** Read persisted raw envelopes too, so old transcripts gain the same useful descriptions. */
export function toolActivity(event: Extract<AgentEvent, { type: "tool" }>): ToolActivity {
  const raw = record(event.raw);
  const cursor = record(record(raw.tool_call)[event.name]);
  const blocks = record(raw.message).content;
  const block = record(
    Array.isArray(blocks)
      ? blocks.find((item) => ["tool_use", "tool_result"].includes(String(record(item).type)))
      : undefined,
  );
  const item = record(raw.item);
  const part = record(raw.part);
  const state = record(part.state);
  const detail = record(event.detail);
  const inputValue =
    cursor.args ??
    block.input ??
    state.input ??
    raw.args ??
    raw.input ??
    (item.command ? { command: item.command } : item.changes ? { changes: item.changes } : detail);
  const args = record(inputValue);
  const result =
    cursor.result ??
    block.content ??
    state.output ??
    raw.result ??
    item.aggregated_output ??
    item.output ??
    (event.phase === "end" ? event.detail : undefined);
  const resultRecord = record(result);
  const success = resultRecord.success;
  const output = success ?? result;
  const out = record(output);
  const failure = resultRecord.error ?? state.error ?? item.error;
  const exitCode = out.exitCode ?? out.exit_code ?? item.exit_code;
  const failed =
    block.is_error === true ||
    raw.is_error === true ||
    raw.isError === true ||
    (failure !== undefined && failure !== null && failure !== false && failure !== "") ||
    resultRecord.rejected != null ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    ["failed", "error"].includes(String(state.status ?? item.status));
  const path = string(
    args.path,
    args.file_path,
    args.filePath,
    args.target_file,
    args.targetFile,
    args.targetDirectory,
    args.directory,
  );
  const command = string(args.command, args.cmd, item.command);
  const pattern = string(
    args.pattern,
    args.query,
    args.search_term,
    args.searchTerm,
    args.glob_pattern,
    args.globPattern,
    args.glob,
  );
  const url = string(args.url);
  const description = string(cursor.description, args.description, state.title);
  const name = string(block.name, part.tool) ?? event.name;
  const friendly = name
    .replace(/ToolCall$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  const verb = /read/i.test(name)
    ? "Read"
    : /write|create.*file/i.test(name)
      ? "Write"
      : /edit|replace|patch/i.test(name)
        ? "Edit"
        : /delete/i.test(name)
          ? "Delete"
          : /glob|list|lsTool/i.test(name)
            ? "Find files"
            : /grep|search/i.test(name)
              ? "Search"
              : friendly.charAt(0).toUpperCase() + friendly.slice(1);
  const changes = Array.isArray(item.changes)
    ? item.changes.map((change) => string(record(change).path)).filter(Boolean)
    : [];
  let summary = command
    ? `Run ${command}`
    : changes.length
      ? `Changed ${changes.join(", ")}`
      : pattern
        ? `${verb} ${pattern}${path ? ` in ${path}` : ""}`
        : path
          ? `${verb} ${path}`
          : url
            ? `${verb} ${url}`
            : (description ?? friendly.charAt(0).toUpperCase() + friendly.slice(1));
  if (path && /read/i.test(name)) {
    const start = args.startLine ?? args.start_line ?? args.offset;
    const end = args.endLine ?? args.end_line;
    if (typeof start === "number")
      summary += ` (line ${start}${typeof end === "number" ? ` to ${end}` : ""})`;
  }
  if (/todo/i.test(name) && Array.isArray(args.todos))
    summary = `Update checklist (${args.todos.length} tasks)`;
  if (/getMcpTools/i.test(name) && typeof args.server === "string")
    summary = `List MCP tools from ${args.server}`;
  if (/await/i.test(name) && typeof args.taskId === "string") summary = `Wait for task ${args.taskId}`;
  const input = Object.keys(args).length ? fields(args) : printable(inputValue);
  const outputParts: string[] = [];
  if (typeof exitCode === "number") outputParts.push(`Exit code: ${exitCode}`);
  if (out.stdout !== undefined) outputParts.push(printable(out.stdout));
  if (out.stderr) outputParts.push(`Standard error:\n${printable(out.stderr)}`);
  if (failure !== undefined) outputParts.push(`Error:\n${printable(failure)}`);
  if (out.stdout === undefined && out.stderr === undefined) outputParts.push(resultText(output));
  const id = string(
    raw.call_id,
    block.id,
    block.tool_use_id,
    item.id,
    part.callID,
    raw.toolCallId,
    raw.tool_use_id,
  );
  return {
    ...(id ? { id } : {}),
    name,
    summary: summary.replace(/\s+/g, " "),
    input: input === "{}" ? "" : input,
    output: outputParts.filter(Boolean).join("\n"),
    phase: event.phase,
    failed,
    hasInput: Object.keys(args).length > 0,
  };
}

export function toolDetail(tool: ToolActivity): string {
  return [
    tool.summary,
    tool.failed
      ? "Failed"
      : tool.phase === "end"
        ? "Completed"
        : tool.stopped
          ? "Result not recorded"
          : "Running…",
    ...(tool.input ? [`Input\n${tool.input}`] : []),
    ...(tool.output ? [`Output\n${tool.output}`] : []),
    ...(!tool.input && !tool.output ? ["This agent did not record inputs or output for this call."] : []),
  ].join("\n\n");
}
