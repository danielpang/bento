//! One tool call as a person reads it, after the console's `tool-activity.ts`: what it did in
//! a phrase, its input and output as text, and whether it failed. Every adapter's native line
//! is read, so old transcripts read the same as new ones.

use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Default)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
    pub summary: String,
    pub input: String,
    pub output: String,
    /// The tool's end arrived.
    pub done: bool,
    pub failed: bool,
    pub has_input: bool,
}

impl ToolCall {
    /// A call from its name alone, as tests write them.
    #[cfg(test)]
    pub fn named(name: &str) -> ToolCall {
        activity(name, false, None, None)
    }
}

const INTERNAL_FIELDS: &[&str] = &[
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
];

static NULL: Value = Value::Null;

/// `a ?? b ?? c`: the first that is present and not null.
fn first<'a>(values: &[&'a Value]) -> &'a Value {
    values.iter().copied().find(|v| !v.is_null()).unwrap_or(&NULL)
}

/// The first non-empty string among `values`.
fn string(values: &[&Value]) -> Option<String> {
    values.iter().find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
}

fn record(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

fn printable(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(items) if items.iter().all(|i| i["type"] == "text") => {
            items.iter().map(|i| i["text"].as_str().map_or_else(|| i["text"].to_string(), str::to_owned)).collect::<Vec<_>>().join("\n")
        }
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// "filePath" reads "file Path", "exit_code" reads "exit code".
fn spaced(key: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for c in key.chars() {
        if c.is_ascii_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = c.is_ascii_lowercase();
        out.push(if c == '_' || c == '-' { ' ' } else { c });
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "filePath" reads "File path", as the console labels a field.
fn field_label(key: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for c in key.chars() {
        if c.is_ascii_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = c.is_ascii_lowercase();
        out.push(if c == '_' { ' ' } else { c });
    }
    capitalized(&out)
}

fn fields(m: &Map<String, Value>) -> String {
    m.iter()
        .filter(|(k, v)| !INTERNAL_FIELDS.contains(&k.as_str()) && !v.is_null() && v.as_str() != Some(""))
        .map(|(k, v)| {
            let text = printable(v);
            let sep = if text.contains('\n') { "\n" } else { " " };
            format!("{}:{sep}{text}", field_label(k))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn result_text(v: &Value) -> String {
    let Some(out) = record(v) else { return printable(v) };
    if let Some(diff) = out.get("diffString").and_then(Value::as_str) {
        return [out.get("message").and_then(Value::as_str).unwrap_or(""), diff].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    }
    if let Some(content) = out.get("content").and_then(Value::as_str) {
        return content.to_owned();
    }
    if out.get("contentBlobId").is_some_and(|b| !b.is_null() && b != "") {
        return format!("{}\nFile content was not included in the recorded event.", fields(out));
    }
    if let Some(files) = out.get("files").and_then(Value::as_array) {
        let head = match out.get("totalFiles") {
            Some(n) if !n.is_null() => format!("{} files found", printable(n).trim_matches('"')),
            _ => "Files found".to_owned(),
        };
        return std::iter::once(head).chain(files.iter().map(printable)).collect::<Vec<_>>().join("\n");
    }
    if let Some(todos) = out.get("todos").and_then(Value::as_array) {
        return todos
            .iter()
            .map(|t| {
                let mark = if t["status"] == "completed" { "[x]" } else { "[ ]" };
                let text = string(&[&t["content"], &t["title"], &t["text"]]).unwrap_or_else(|| printable(t));
                let doing = if t["status"] == "in_progress" { " (in progress)" } else { "" };
                format!("{mark} {text}{doing}")
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    if out.is_empty() { printable(v) } else { fields(out) }
}

fn has(name: &str, words: &[&str]) -> bool {
    let lower = name.to_lowercase();
    words.iter().any(|w| lower.contains(w))
}

fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("")
}

/// One tool event as a call. `end` is the tool's end phase.
pub fn activity(event_name: &str, end: bool, detail: Option<&Value>, raw: Option<&Value>) -> ToolCall {
    let raw = raw.unwrap_or(&NULL);
    let detail = detail.unwrap_or(&NULL);
    let cursor = &raw["tool_call"][event_name];
    let block = raw["message"]["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "tool_use" || b["type"] == "tool_result"))
        .unwrap_or(&NULL);
    let (item, part) = (&raw["item"], &raw["part"]);
    let state = &part["state"];
    let command_input;
    let input_value = match first(&[&cursor["args"], &block["input"], &state["input"], &raw["args"], &raw["input"]]) {
        v if !v.is_null() => v,
        _ if truthy(&item["command"]) => {
            command_input = serde_json::json!({ "command": item["command"] });
            &command_input
        }
        _ if truthy(&item["changes"]) => {
            command_input = serde_json::json!({ "changes": item["changes"] });
            &command_input
        }
        _ => detail,
    };
    let empty = Map::new();
    let args = record(input_value).unwrap_or(&empty);
    let arg = |k: &str| args.get(k).unwrap_or(&NULL);
    let result = match first(&[&cursor["result"], &block["content"], &state["output"], &raw["result"], &item["aggregated_output"], &item["output"]]) {
        v if !v.is_null() => v,
        _ if end && *detail != raw["call_id"] => detail,
        _ => &NULL,
    };
    let output = first(&[&result["success"], result]);
    let failure = first(&[&result["error"], &state["error"], &item["error"]]);
    let exit_code = first(&[&output["exitCode"], &output["exit_code"], &item["exit_code"]]).as_i64();
    let status = first(&[&state["status"], &item["status"]]);
    let failed = block["is_error"] == true
        || raw["is_error"] == true
        || raw["isError"] == true
        || truthy(failure)
        || !result["rejected"].is_null()
        || exit_code.is_some_and(|c| c != 0)
        || status == "failed"
        || status == "error";
    let path = string(&[arg("path"), arg("file_path"), arg("filePath"), arg("target_file"), arg("targetFile"), arg("targetDirectory"), arg("directory")]);
    let command = string(&[arg("command"), arg("cmd"), &item["command"]]);
    let pattern = string(&[arg("pattern"), arg("query"), arg("search_term"), arg("searchTerm"), arg("glob_pattern"), arg("globPattern"), arg("glob")]);
    let url = string(&[arg("url")]);
    let description = string(&[&cursor["description"], arg("description"), &state["title"]]);
    let name = string(&[&block["name"], &part["tool"]]).unwrap_or_else(|| event_name.to_owned());
    let friendly = spaced(name.strip_suffix("ToolCall").unwrap_or(&name));
    let verb = if has(&name, &["read"]) {
        "Read".to_owned()
    } else if has(&name, &["write"]) || (has(&name, &["create"]) && name.to_lowercase().split("create").nth(1).is_some_and(|r| r.contains("file"))) {
        "Write".to_owned()
    } else if has(&name, &["edit", "replace", "patch"]) {
        "Edit".to_owned()
    } else if has(&name, &["delete"]) {
        "Delete".to_owned()
    } else if has(&name, &["glob", "list", "lstool"]) {
        "Find files".to_owned()
    } else if has(&name, &["grep", "search"]) {
        "Search".to_owned()
    } else {
        capitalized(&friendly)
    };
    let changes: Vec<String> = item["changes"].as_array().map(|c| c.iter().filter_map(|c| string(&[&c["path"]])).collect()).unwrap_or_default();
    let mut summary = if let Some(command) = &command {
        format!("Run {command}")
    } else if !changes.is_empty() {
        format!("Changed {}", changes.join(", "))
    } else if let Some(pattern) = &pattern {
        match &path {
            Some(p) => format!("{verb} {pattern} in {p}"),
            None => format!("{verb} {pattern}"),
        }
    } else if let Some(p) = &path {
        format!("{verb} {p}")
    } else if let Some(u) = &url {
        format!("{verb} {u}")
    } else {
        description.unwrap_or_else(|| capitalized(&friendly))
    };
    if path.is_some() && has(&name, &["read"]) {
        let start = first(&[arg("startLine"), arg("start_line"), arg("offset")]);
        let end_line = first(&[arg("endLine"), arg("end_line")]);
        if start.is_number() {
            summary += &match end_line.is_number() {
                true => format!(" (line {start} to {end_line})"),
                false => format!(" (line {start})"),
            };
        }
    }
    if has(&name, &["todo"])
        && let Some(todos) = arg("todos").as_array()
    {
        summary = format!("Update checklist ({} tasks)", todos.len());
    }
    if has(&name, &["getmcptools"])
        && let Some(server) = arg("server").as_str()
    {
        summary = format!("List MCP tools from {server}");
    }
    if has(&name, &["await"])
        && let Some(task) = arg("taskId").as_str()
    {
        summary = format!("Wait for task {task}");
    }
    let input = if args.is_empty() { printable(input_value) } else { fields(args) };
    let mut parts: Vec<String> = Vec::new();
    if let Some(code) = exit_code {
        parts.push(format!("Exit code: {code}"));
    }
    let (stdout, stderr) = (output.get("stdout"), output.get("stderr"));
    if let Some(out) = stdout {
        parts.push(printable(out));
    }
    if let Some(err) = stderr.filter(|e| truthy(e)) {
        parts.push(format!("Standard error:\n{}", printable(err)));
    }
    if !failure.is_null() {
        parts.push(format!("Error:\n{}", printable(failure)));
    }
    if stdout.is_none() && stderr.is_none() {
        parts.push(result_text(output));
    }
    let id = string(&[&raw["call_id"], &block["id"], &block["tool_use_id"], &item["id"], &part["callID"], &raw["toolCallId"], &raw["tool_use_id"]]);
    ToolCall {
        id,
        name,
        summary: summary.split_whitespace().collect::<Vec<_>>().join(" "),
        input: if input == "{}" { String::new() } else { input },
        output: parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n"),
        done: end,
        failed,
        has_input: !args.is_empty(),
    }
}

/// Folds a call into the run's calls: an end merges into the start it answers.
pub fn merge(into: &mut ToolCall, call: ToolCall) {
    let summary = if call.has_input { call.summary } else { std::mem::take(&mut into.summary) };
    // A claude-code result carries no input of its own, only the output again.
    let input = if call.has_input && !call.input.is_empty() { call.input } else { std::mem::take(&mut into.input) };
    let output = if call.output.is_empty() { std::mem::take(&mut into.output) } else { call.output };
    let name = if call.has_input { call.name } else { std::mem::take(&mut into.name) };
    *into = ToolCall { name, summary, input, output, ..call };
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_code_calls_read_as_the_console_writes_them() {
        let start = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls  -la","description":"List"}}]}});
        let mut call = activity("Bash", false, Some(&start["message"]["content"][0]["input"]), Some(&start));
        assert_eq!(call.summary, "Run ls -la");
        assert_eq!(call.id.as_deref(), Some("t1"));
        assert_eq!(call.input, "Command: ls  -la\nDescription: List");
        assert!(!call.done && !call.failed);
        let end = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"<tool_use_error>File does not exist.</tool_use_error>","is_error":true}]}});
        let result = activity("tool_result", true, Some(&end["message"]["content"][0]["content"]), Some(&end));
        assert_eq!(result.id.as_deref(), Some("t1"));
        merge(&mut call, result);
        assert_eq!(call.summary, "Run ls -la");
        assert!(call.done && call.failed);
        assert_eq!(call.output, "<tool_use_error>File does not exist.</tool_use_error>");
        assert!(call.input.starts_with("Command:"));
    }

    #[test]
    fn reads_name_their_file_and_lines() {
        let raw = json!({"message":{"content":[{"type":"tool_use","id":"r","name":"Read","input":{"file_path":"src/a.ts","offset":10}}]}});
        assert_eq!(activity("Read", false, None, Some(&raw)).summary, "Read src/a.ts (line 10)");
        let codex = json!({"item":{"id":"c1","command":"pnpm test","exit_code":2,"aggregated_output":"1 failed"}});
        let c = activity("command_execution", true, None, Some(&codex));
        assert_eq!(c.summary, "Run pnpm test");
        assert!(c.failed);
        assert_eq!(c.output, "Exit code: 2\n1 failed");
        assert_eq!(ToolCall::named("Grep").summary, "Grep");
        assert_eq!(field_label("filePath"), "File Path");
    }
}
