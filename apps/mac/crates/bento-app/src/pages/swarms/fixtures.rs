//! Headless scenes for the Swarms page. Nothing here reaches a server.

use bento_client::{AgentEvent, MessageRole, RunStatus, SwarmDetail, SwarmRow, ToolPhase};
use serde_json::{Value, json};

use super::{Confirm, Load, Output, PageState, Selection};
use crate::data;
use crate::pages::Scene;
use crate::state::{Screen, State};

pub const SCENES: &[Scene] = &[
    ("swarms", list),
    ("swarms/loading", loading),
    ("swarms/empty", empty),
    ("swarms/error", error),
    ("swarms/detail", detail),
    ("swarms/planner", planner),
    ("swarms/planning", planning),
    ("swarms/waiting", waiting),
    ("swarms/failed-task", failed_task),
    ("swarms/confirm", confirm),
    ("swarms/big", big),
    ("swarms/paused", paused),
    ("swarms/new", new),
];

fn base(s: &mut State) {
    crate::fixtures::board(s);
    s.screen = Screen::Swarms;
    s.swarms = PageState { project: s.project.clone(), ..PageState::default() };
    s.swarms.profiles = serde_json::from_value(json!([
        {"id": "planner", "name": "Swarm Planner", "cli": "claude-code", "model": "claude-opus-5"},
        {"id": "worker", "name": "Swarm Worker", "cli": "codex", "model": "gpt-5"},
    ]))
    .unwrap();
}

const AGO: &str = "2026-11-27T09:00:00.000Z";

fn ago(minutes: i64) -> String {
    let ms = super::words::now_ms() - minutes * 60_000;
    let secs = ms / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days (Howard Hinnant's algorithm), enough for a fixture clock.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem / 60 % 60, rem % 60)
}

fn swarm(id: &str, title: &str, goal: &str, status: &str, paused: Option<&str>) -> Value {
    json!({
        "id": id, "projectId": "bento", "title": title, "goal": goal, "status": status, "pausedReason": paused,
        "branchName": format!("swarm/{id}"), "plannerProfileId": "planner", "workerProfileId": "worker",
        "budgetUsd": "8", "maxWorkers": 3, "spentMeasuredUsd": "2.41", "spentEstimatedUsd": "0.37",
        "createdAt": ago(42), "archivedAt": null
    })
}

fn row(id: &str, title: &str, goal: &str, status: &str, paused: Option<&str>, counts: (u32, u32, u32)) -> SwarmRow {
    let mut v = swarm(id, title, goal, status, paused);
    v["counts"] = json!({"tasks": counts.0, "done": counts.1, "attention": counts.2});
    serde_json::from_value(v).unwrap()
}

fn rows() -> Vec<SwarmRow> {
    vec![
        row("cursor", "Cursor pagination for run events", "Page the run events route with a cursor so the console loads older events on scroll.", "running", None, (5, 3, 0)),
        row("settings", "Split the settings page", "Split the settings page into Account, Team and Agents, keeping every deep link working.", "paused", Some("usage_limit"), (8, 2, 0)),
        row("flaky", "Fix the flaky landing tests", "Find why the merge queue e2e tests fail one run in ten and fix the cause.", "blocked", None, (4, 1, 2)),
        row("docs", "Document the sandbox drivers", "Write a page per sandbox driver: what it isolates, what it costs, and when auto picks it.", "done", None, (3, 3, 0)),
    ]
}

fn list(s: &mut State) {
    base(s);
    s.swarms.list = Load::Ready(rows());
}

fn loading(s: &mut State) {
    base(s);
}

fn empty(s: &mut State) {
    base(s);
    s.swarms.list = Load::Ready(Vec::new());
}

fn error(s: &mut State) {
    base(s);
    s.swarms.list = Load::Failed("Could not reach the local server: connection refused.".into());
}

fn task(id: &str, parent: Option<&str>, relation: &str, title: &str, node: &str, status: &str, extra: Value) -> Value {
    let mut v = json!({
        "id": id, "parentId": parent, "parentRelation": relation, "position": 0, "title": title,
        "description": "", "nodeType": node, "status": status, "attention": null, "weight": 1,
        "assignedRunId": null, "branchName": if node == "leaf" { Some(format!("swarm/cursor-{id}")) } else { None },
        "flags": {}, "report": null, "canRetryLanding": false
    });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    v
}

fn cursor_detail(status: &str, paused: Option<&str>) -> SwarmDetail {
    let tasks = vec![
        task("codec", None, "contains", "Cursor type and codec", "leaf", "done", json!({"position": 0, "description": "An opaque cursor over (recorded_at, seq), base64 encoded."})),
        task("query", None, "contains", "Events query by cursor", "leaf", "done", json!({"position": 1})),
        task("route", None, "contains", "Route and client method", "leaf", "done", json!({"position": 2})),
        task("scroll", None, "contains", "Console loads older events on scroll", "leaf", "working", json!({
            "position": 3, "assignedRunId": "run-scroll", "report": "Added `loadEarlier` to the run view. Scrolling to the top asks for the page before the oldest event.", "review": "waiting"
        })),
        task("matrix", None, "contains", "Matrix test for the new route", "leaf", "working", json!({
            "position": 4, "assignedRunId": "run-matrix",
            "description": "Add the events route to the foreign tenant matrix and cover the cursor edge cases."
        })),
    ];
    let mut tasks = tasks;
    if status == "blocked" {
        tasks[3]["attention"] = json!("failed");
        tasks[3]["review"] = json!("undecided");
    }
    serde_json::from_value(json!({
        "swarm": swarm("cursor", "Cursor pagination for run events", "Page the run events route with a cursor so the console loads older events on scroll.", status, paused),
        "tasks": tasks,
        "activeRuns": if status == "running" { json!([{"id": "run-matrix", "role": "worker", "status": "running", "swarmTaskId": "matrix", "agentStartedAt": ago(9)}]) } else { json!([]) },
        "agentTimeMs": 1_925_000.0,
        "plannerRun": {"id": "run-planner", "status": "succeeded", "agent": {"name": "Swarm Planner", "cli": "claude-code", "model": "claude-opus-5"}, "queuedAt": AGO},
        "landings": [
            {"id": "l4", "taskId": "scroll", "branchName": "swarm/cursor-scroll", "position": 4, "status": "queued", "attempt": 0},
            {"id": "l3", "taskId": "route", "branchName": "swarm/cursor-route", "position": 3, "status": "landed", "attempt": 1},
            {"id": "l2", "taskId": "query", "branchName": "swarm/cursor-query", "position": 2, "status": "landed", "attempt": 1},
            {"id": "l1", "taskId": "codec", "branchName": "swarm/cursor-codec", "position": 1, "status": "landed", "attempt": 1},
        ],
        "landingSummary": {"total": 4, "committed": 3},
        "pullRequests": []
    }))
    .unwrap()
}

fn worker_output() -> Output {
    let msg = |role, text: &str| AgentEvent::Message { role, text: text.into() };
    let tool = |name: &str| AgentEvent::Tool { name: name.into(), phase: ToolPhase::Start, detail: None, raw: None };
    Output {
        run_id: "run-matrix".into(),
        entries: data::entries(&[
            msg(MessageRole::System, "Swarm Worker started and is working on the task."),
            tool("Read"),
            tool("Read"),
            tool("Grep"),
            msg(MessageRole::Assistant, "The matrix lists every entity route. I will add `GET /api/runs/:id/events/before` and a case for a cursor from another run."),
            tool("Edit"),
            tool("Bash"),
        ]),
        draft: "Running auth.e2e.test.ts".into(),
        ended: None,
        error: None,
    }
}

fn open(s: &mut State, d: SwarmDetail) {
    s.swarms.open = Some(d.swarm.id.clone());
    s.swarms.list = Load::Ready(rows());
    s.swarms.detail = Load::Ready(d);
}

fn detail(s: &mut State) {
    base(s);
    open(s, cursor_detail("running", None));
    s.swarms.selected = Some(Selection::Task("matrix".into()));
    s.swarms.node = Some(("matrix".into(), Load::Ready(serde_json::from_value(json!({"events": [], "runs": [], "commits": [
        {"sha": "9f1c2ab77", "subject": "Cover cursors from another run in the matrix", "at": AGO}
    ]})).unwrap())));
    s.swarms.output = Some(worker_output());
}

fn planner(s: &mut State) {
    detail(s);
    s.swarms.selected = Some(Selection::Planner);
    let msg = |role, text: &str| AgentEvent::Message { role, text: text.into() };
    s.swarms.output = Some(Output {
        run_id: "run-planner".into(),
        entries: data::entries(&[
            msg(MessageRole::User, "Page the run events route with a cursor so the console loads older events on scroll."),
            AgentEvent::Tool { name: "Read".into(), phase: ToolPhase::Start, detail: None, raw: None },
            msg(MessageRole::Assistant, "Five tasks: the cursor type, the query, the route, the console, and the tenant matrix. The first three in order; the last two after the route."),
        ]),
        ended: Some(RunStatus::Succeeded),
        ..Output::default()
    });
}

fn planning(s: &mut State) {
    base(s);
    let mut d = cursor_detail("planning", None);
    d.tasks.clear();
    d.landings.clear();
    d.landing_summary = Default::default();
    d.agent_time_ms = 41_000.0;
    d.planner_run = serde_json::from_value(json!({"id": "run-planner", "status": "running", "agent": {"name": "Swarm Planner", "cli": "claude-code", "model": "claude-opus-5"}, "queuedAt": ago(1), "startedAt": ago(1)})).unwrap();
    d.active_runs = serde_json::from_value(json!([{"id": "run-planner", "role": "planner", "status": "running", "swarmTaskId": null}])).unwrap();
    open(s, d);
}

fn waiting(s: &mut State) {
    base(s);
    open(s, cursor_detail("blocked", None));
    s.swarms.selected = Some(Selection::Task("scroll".into()));
    s.swarms.node = Some(("scroll".into(), Load::Ready(serde_json::from_value(json!({"events": [], "runs": [], "commits": []})).unwrap())));
}

fn failed_task(s: &mut State) {
    base(s);
    let mut d = cursor_detail("running", None);
    d.tasks[4] = serde_json::from_value(task("matrix", None, "contains", "Matrix test for the new route", "leaf", "failed", json!({
        "position": 4, "attention": "failed", "assignedRunId": "run-matrix", "flags": {"retries": 1},
        "description": "Add the events route to the foreign tenant matrix and cover the cursor edge cases."
    })))
    .unwrap();
    d.active_runs.clear();
    open(s, d);
    s.swarms.selected = Some(Selection::Task("matrix".into()));
    let mut out = worker_output();
    out.draft.clear();
    out.entries.push(crate::model::Entry::Failed("auth.e2e.test.ts: 2 failed, 41 passed".into()));
    out.ended = Some(RunStatus::Failed);
    s.swarms.output = Some(out);
}

fn confirm(s: &mut State) {
    failed_task(s);
    s.swarms.confirm = Some(Confirm::StartOver("matrix".into()));
}

fn paused(s: &mut State) {
    base(s);
    open(s, cursor_detail("paused", Some("manual")));
}

/// Forty tasks in plan groups, to see the tree at size.
fn big(s: &mut State) {
    base(s);
    let mut d = cursor_detail("running", None);
    let mut tasks = Vec::new();
    let mut runs = Vec::new();
    let groups = ["Server routes", "Database", "Console", "Mac app", "Tests and docs"];
    for (g, name) in groups.iter().enumerate() {
        let gid = format!("g{g}");
        tasks.push(task(&gid, None, "contains", name, "plan", if g == 0 { "done" } else { "working" }, json!({"position": g})));
        for n in 0..7 {
            let id = format!("t{g}{n}");
            let status = match (g, n) {
                (0, _) => "done",
                (1, 0..=3) => "done",
                (1, 4) | (2, 1) | (3, 0) => "working",
                (2, 3) => "failed",
                (4, _) => "assigned",
                _ => "assigned",
            };
            let mut extra = json!({"position": n});
            if status == "working" {
                extra["assignedRunId"] = json!(format!("run-{id}"));
                runs.push(json!({"id": format!("run-{id}"), "role": "worker", "status": "running", "swarmTaskId": id, "agentStartedAt": ago(3 + n as i64)}));
            }
            if status == "failed" {
                extra["attention"] = json!("failed");
            }
            let (parent, relation) = if g == 4 && n > 0 { (format!("t{g}{}", n - 1), "depends_on") } else { (gid.clone(), "contains") };
            tasks.push(task(&id, Some(&parent), relation, &format!("{name}: step {}", n + 1), "leaf", status, extra));
        }
    }
    d.tasks = serde_json::from_value(Value::Array(tasks)).unwrap();
    d.active_runs = serde_json::from_value(Value::Array(runs)).unwrap();
    d.landings.clear();
    open(s, d);
    s.swarms.selected = Some(Selection::Task("t23".into()));
}

fn new(s: &mut State) {
    list(s);
    s.swarms.creating = Some(super::create::Form::new());
}
