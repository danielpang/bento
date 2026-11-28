//! What a swarm and its tasks are called, and what may be done to them. A port of the
//! console's `swarm/status.ts`, `swarm/waiting.ts` and `nodeLanding`, so the two say the same
//! words and offer the same controls. Pure, so it is tested without a server.

use bento_client::{RunStatus, Swarm, SwarmDetail, SwarmTask};
use serde_json::Value;

use crate::model::Status;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SwarmStatus {
    Planning,
    Running,
    Paused,
    Waiting,
    Done,
    Stopped,
    BudgetExhausted,
    TimedOut,
    Failed,
}

/// The table's status in the console's words: blocked is waiting, cancelled is stopped, and a
/// question the swarm itself asked is waiting whatever its tree is doing.
pub fn swarm_status(status: &str, paused_reason: Option<&str>) -> SwarmStatus {
    match status {
        "paused" => SwarmStatus::Paused,
        "budget_exhausted" => SwarmStatus::BudgetExhausted,
        "timed_out" => SwarmStatus::TimedOut,
        "cancelled" => SwarmStatus::Stopped,
        "done" => SwarmStatus::Done,
        "failed" => SwarmStatus::Failed,
        _ if paused_reason == Some("attention") => SwarmStatus::Waiting,
        "blocked" => SwarmStatus::Waiting,
        "running" => SwarmStatus::Running,
        _ => SwarmStatus::Planning,
    }
}

pub fn status_of(swarm: &Swarm) -> SwarmStatus {
    swarm_status(&swarm.status, swarm.paused_reason.as_deref())
}

pub fn swarm_tone(status: SwarmStatus) -> Status {
    match status {
        SwarmStatus::Planning | SwarmStatus::Running => Status::Running,
        SwarmStatus::Done => Status::Succeeded,
        SwarmStatus::Failed => Status::Failed,
        SwarmStatus::Paused | SwarmStatus::Waiting | SwarmStatus::BudgetExhausted | SwarmStatus::TimedOut => Status::Gated,
        SwarmStatus::Stopped => Status::Idle,
    }
}

const BUDGET_LIMIT_LABEL: &str = "Budget limit reached";
const BUDGET_LIMIT_WARNING: &str = "This swarm has reached its budget limit. Raise the limit to start more agents. Work already committed stays on the branch.";
const TIME_LIMIT_WARNING: &str = "This swarm reached its time limit. Work already committed stays on the branch. Raise the limit to continue.";
const AGENT_HOURS_WARNING: &str = "This team has used all of its agent hours. New agents will start when more hours are available.";

pub fn swarm_words(status: SwarmStatus) -> &'static str {
    match status {
        SwarmStatus::Planning => "planning",
        SwarmStatus::Running => "running",
        SwarmStatus::Paused => "paused",
        SwarmStatus::Waiting => "waiting for you",
        SwarmStatus::Done => "done",
        SwarmStatus::Stopped => "stopped",
        SwarmStatus::BudgetExhausted => BUDGET_LIMIT_LABEL,
        SwarmStatus::TimedOut => "out of time",
        SwarmStatus::Failed => "failed",
    }
}

pub fn is_over(status: SwarmStatus) -> bool {
    matches!(status, SwarmStatus::Done | SwarmStatus::Stopped | SwarmStatus::Failed)
}

pub fn can_resume(status: SwarmStatus) -> bool {
    status == SwarmStatus::Paused
}

pub fn can_stop(status: SwarmStatus) -> bool {
    !is_over(status)
}

/// Why a swarm is not starting anything, in a sentence, or None.
pub fn paused_words(status: SwarmStatus, reason: Option<&str>) -> Option<&'static str> {
    match status {
        SwarmStatus::BudgetExhausted => return Some(BUDGET_LIMIT_WARNING),
        SwarmStatus::TimedOut => return Some(TIME_LIMIT_WARNING),
        SwarmStatus::Paused => {}
        _ => return None,
    }
    Some(match reason {
        Some("plan_limit") => AGENT_HOURS_WARNING,
        Some("budget") => BUDGET_LIMIT_WARNING,
        Some("time_limit") => TIME_LIMIT_WARNING,
        Some("attention") => "Something in this swarm is waiting on you.",
        Some("error") => "This swarm stopped on an error. Its plan and everything that was committed are still here.",
        Some("usage_limit") => "Your agents hit their usage limit. This swarm starts again by itself once it resets.",
        _ => "This swarm is paused. Resume it to continue.",
    })
}

/// The node controls whose answer depends on the swarm.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskAction {
    MarkDone,
    Retry,
    RetryLanding,
    Cancel,
}

/// Why the server refuses this node control on a swarm in this state, or None.
pub fn task_action_refusal(status: SwarmStatus, action: TaskAction) -> Option<&'static str> {
    match status {
        SwarmStatus::Stopped => Some("This swarm was stopped, so its tasks do not change."),
        SwarmStatus::Done if action != TaskAction::MarkDone => Some("This swarm is done. Add a follow up to change its work."),
        _ => None,
    }
}

/// Where a leaf's finished work stands: in the merge queue, failed to merge, or reported and
/// waiting for the planner.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Landing {
    Waiting,
    Failed,
    Review,
}

fn flag_true(task: &SwarmTask, name: &str) -> bool {
    task.flag(name).and_then(Value::as_bool) == Some(true)
}

pub fn node_landing(task: &SwarmTask) -> Option<Landing> {
    if !task.is_leaf() || !matches!(task.status.as_str(), "working" | "landed" | "failed") {
        return None;
    }
    if task.flag("landingError").is_some_and(Value::is_string) {
        return Some(Landing::Failed);
    }
    if task.status == "failed" {
        return None;
    }
    if task.status == "landed" || flag_true(task, "accepted") {
        return Some(Landing::Waiting);
    }
    if task.report.as_deref().is_some_and(|r| !r.trim().is_empty()) {
        return Some(Landing::Review);
    }
    None
}

pub fn review_words(review: Option<&str>) -> &'static str {
    match review {
        Some("reviewing") => "planner reviewing",
        Some("restarting") => "planner restarting",
        Some("stopped") => "planner stopped",
        Some("undecided") => "not reviewed",
        _ => "waiting for review",
    }
}

pub fn review_next_step(review: Option<&str>) -> &'static str {
    match review {
        Some("reviewing") => "The worker finished. The planner is reviewing its report and will accept it or send it back.",
        Some("restarting") => "Swarm worker completed but the planner agent died before it could review the work. Bento will restart planner to verify work.",
        Some("stopped") => "The worker finished. The planner was stopped before deciding on this report, so the report goes to the planner the next time it starts.",
        Some("undecided") => "The worker finished. The planner was handed its report several times and never decided. Mark it done, retry it, or cancel it.",
        _ => "The worker finished. Its report is waiting for the planner, which reviews it as soon as it is free.",
    }
}

fn task_words(status: &str) -> &str {
    match status {
        "landed" => "waiting to merge",
        other => other,
    }
}

fn task_tone(status: &str) -> Status {
    match status {
        "assigned" | "working" | "landed" => Status::Running,
        "done" => Status::Succeeded,
        "failed" => Status::Failed,
        "blocked" => Status::Gated,
        _ => Status::Idle,
    }
}

/// What a node says on the tree and the drawer. "working" is only an agent in a sandbox now.
pub fn diagram_words(task: &SwarmTask, agent_active: bool) -> String {
    if agent_active {
        return "working".into();
    }
    match node_landing(task) {
        Some(Landing::Failed) => return "merge failed".into(),
        Some(Landing::Waiting) => return "waiting to merge".into(),
        Some(Landing::Review) => return review_words(task.review.as_deref()).into(),
        None => {}
    }
    if !task.is_leaf() && task.status == "failed" {
        return "stalled".into();
    }
    match task.status.as_str() {
        "done" => "completed".into(),
        "open" | "assigned" | "working" => "pending".into(),
        other => task_words(other).into(),
    }
}

pub fn diagram_tone(task: &SwarmTask, agent_active: bool) -> Status {
    if agent_active {
        return Status::Running;
    }
    match node_landing(task) {
        Some(Landing::Failed) => return Status::Failed,
        Some(Landing::Waiting) => return task_tone("landed"),
        Some(Landing::Review) => return if task.review.as_deref() == Some("reviewing") { Status::Running } else { Status::Idle },
        None => {}
    }
    if !task.is_leaf() && task.status == "failed" {
        return Status::Gated;
    }
    match task.status.as_str() {
        "open" | "assigned" | "working" => Status::Idle,
        other => task_tone(other),
    }
}

pub fn attention_words(attention: Option<&str>) -> Option<&'static str> {
    Some(match attention? {
        "long_running" => "Still running",
        "question" => "Waiting for user approval",
        "failed" => "failed",
        "conflict" => "Merge conflict",
        "budget" => BUDGET_LIMIT_LABEL,
        "plan_limit" => "Out of Bento agent hours, enable overage billing to continue",
        _ => "Planner notified of long run task",
    })
}

pub fn attention_note(attention: Option<&str>) -> Option<&'static str> {
    Some(match attention? {
        "long_running" => "The agent has been running past the warning threshold. Check worker logs to verify.",
        "question" => "Planner is waiting for user response before continuing.",
        "failed" => "The worker failed. Retry the task to start another attempt.",
        "conflict" => "This branch cannot be merged yet. An agent will try to resolve the conflict. If it conflicts again, the task will fail.",
        "budget" => BUDGET_LIMIT_WARNING,
        "plan_limit" => AGENT_HOURS_WARNING,
        _ => "This agent is taking longer than expected. The planner has been notified. Check the logs for progress.",
    })
}

/// The attention chip on the tree, unless it repeats the status words.
pub fn diagram_attention(task: &SwarmTask, agent_active: bool) -> Option<&'static str> {
    let attention = task.attention.as_deref();
    if attention == Some("long_running") && !agent_active {
        return None;
    }
    let words = attention_words(attention)?;
    (words != diagram_words(task, agent_active)).then_some(words)
}

/// Tasks whose agent process is in a sandbox right now.
pub fn agent_active(detail: &SwarmDetail, task_id: &str) -> bool {
    detail.active_runs.iter().any(|r| r.status == RunStatus::Running && r.swarm_task_id.as_deref() == Some(task_id))
}

/// When the agent on a task started, the earliest of its running agents.
pub fn agent_started_at<'a>(detail: &'a SwarmDetail, task_id: &str) -> Option<&'a str> {
    detail
        .active_runs
        .iter()
        .filter(|r| r.status == RunStatus::Running && r.swarm_task_id.as_deref() == Some(task_id))
        .filter_map(|r| r.agent_started_at.as_deref().or(r.started_at.as_deref()))
        .min_by_key(|at| epoch_ms(at).unwrap_or(i64::MAX))
}

fn status_word_of_parent(task: &SwarmTask) -> &str {
    match task.status.as_str() {
        "assigned" | "open" => "not started",
        "working" => "in progress",
        "landed" => "waiting to merge",
        other => other,
    }
}

/// Why an assigned leaf is not started, or None when nothing visible holds it.
pub fn leaf_start_blocker(task: &SwarmTask, detail: &SwarmDetail, with_swarm: bool) -> Option<String> {
    if !task.is_leaf() || task.status != "assigned" {
        return None;
    }
    let mut seen = vec![task.id.as_str()];
    let mut current = task;
    while let Some(parent_id) = current.parent_id.as_deref() {
        if seen.contains(&parent_id) {
            break;
        }
        seen.push(parent_id);
        let Some(parent) = detail.tasks.iter().find(|t| t.id == parent_id) else { break };
        if current.parent_relation.as_deref().unwrap_or("contains") == "depends_on" && parent.status != "done" {
            return Some(format!("Waiting for \"{}\" to finish first. It is {}.", parent.title, status_word_of_parent(parent)));
        }
        current = parent;
    }
    if !with_swarm {
        return None;
    }
    match status_of(&detail.swarm) {
        SwarmStatus::Paused => Some("The swarm is paused. Resume it to start this task.".into()),
        SwarmStatus::Planning => Some("The plan has not been approved yet. Approve it to start this task.".into()),
        SwarmStatus::BudgetExhausted => Some("The swarm reached its budget. Raise it to start this task.".into()),
        SwarmStatus::TimedOut => Some("The swarm reached its time limit. Raise it to start this task.".into()),
        _ if task.agent_profile_id.is_none() && detail.swarm.worker_profile_id.is_none() => {
            Some("This swarm has no worker agent. Choose one in Settings, or pick an agent for this task.".into())
        }
        _ => None,
    }
}

/// The header's sentence for a running swarm with nothing running, or None.
pub fn idle_words(detail: &SwarmDetail) -> Option<String> {
    if status_of(&detail.swarm) != SwarmStatus::Running || !detail.active_runs.is_empty() {
        return None;
    }
    if detail.landings.iter().any(|l| matches!(l.status.as_str(), "queued" | "landing" | "conflicted")) {
        return None;
    }
    let leaves: Vec<&SwarmTask> = detail.tasks.iter().filter(|t| t.is_leaf()).collect();
    let reviews = leaves.iter().filter(|t| node_landing(t) == Some(Landing::Review)).count();
    let failed = leaves.iter().filter(|t| t.status == "failed").count();
    let assigned: Vec<&&SwarmTask> = leaves.iter().filter(|t| t.status == "assigned" && !flag_true(t, "startingOver")).collect();
    let held = assigned.iter().filter(|t| leaf_start_blocker(t, detail, false).is_some()).count();
    let no_worker = assigned.len() > held
        && detail.swarm.worker_profile_id.is_none()
        && assigned.iter().any(|t| t.agent_profile_id.is_none() && leaf_start_blocker(t, detail, false).is_none());
    let plural = |n: usize, one: &str, many: String| match n {
        0 => None,
        1 => Some(one.to_owned()),
        _ => Some(many),
    };
    let reasons: Vec<String> = [
        plural(reviews, "1 report is waiting for the planner to review it", format!("{reviews} reports are waiting for the planner to review them")),
        plural(failed, "1 failed task can be retried from its drawer", format!("{failed} failed tasks can be retried from their drawers")),
        plural(held, "1 task is waiting for a task it depends on", format!("{held} tasks are waiting for tasks they depend on")),
        no_worker.then(|| "no worker agent is set, so ready tasks cannot start (choose one in Settings)".to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if reasons.is_empty() {
        return Some("No agent is running and nothing is waiting to merge. The swarm starts the next ready task on its next pass.".into());
    }
    Some(format!("No agent is running right now: {}.", reasons.join("; ")))
}

/// What the merge queue calls a row, and its hue.
pub fn landing_label(status: &str) -> (&'static str, Status) {
    match status {
        "landing" => ("Merging", Status::Running),
        "queued" => ("Waiting", Status::Idle),
        "landed" => ("Committed", Status::Succeeded),
        "conflicted" => ("Conflict", Status::Gated),
        "failed" => ("Failed", Status::Failed),
        _ => ("Withdrawn", Status::Idle),
    }
}

pub fn planner_words(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Queued => "Queued",
        RunStatus::Starting => "Starting",
        RunStatus::Running => "Planning",
        RunStatus::Succeeded => "Plan written",
        _ => "Stopped",
    }
}

pub fn format_elapsed(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0.0 {
        return "0s".into();
    }
    let seconds = (ms / 1000.0).floor() as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {}s", seconds % 60);
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

pub fn format_usd(usd: f64) -> String {
    if !usd.is_finite() {
        return "$0.00".into();
    }
    if usd > 0.0 && usd < 0.005 {
        return "<$0.01".into();
    }
    format!("${usd:.2}")
}

/// Milliseconds since the epoch for the server's ISO timestamps ("2026-11-27T15:23:58.271Z").
pub fn epoch_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &iso[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        rest = &frac[digits.len()..];
        ms = format!("{digits:0<3}")[..3].parse().ok()?;
    }
    let offset_min = match rest {
        "" | "Z" => 0,
        tz if tz.len() == 6 && (tz.starts_with('+') || tz.starts_with('-')) => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            sign * (tz[1..3].parse::<i64>().ok()? * 60 + tz[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3_600 + mi * 60 + s - offset_min * 60) * 1000) + ms)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(json: Value) -> SwarmTask {
        let mut base = serde_json::json!({"id": "t", "title": "T", "nodeType": "leaf", "status": "assigned", "flags": {}});
        for (k, v) in json.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn detail(swarm_status: &str, tasks: Vec<SwarmTask>) -> SwarmDetail {
        let mut d: SwarmDetail = serde_json::from_value(serde_json::json!({
            "swarm": {"id": "s", "projectId": "p", "title": "S", "status": swarm_status, "workerProfileId": "w"},
        }))
        .unwrap();
        d.tasks = tasks;
        d
    }

    #[test]
    fn table_words_become_console_words() {
        assert_eq!(swarm_status("blocked", None), SwarmStatus::Waiting);
        assert_eq!(swarm_status("running", Some("attention")), SwarmStatus::Waiting);
        assert_eq!(swarm_status("cancelled", None), SwarmStatus::Stopped);
        assert_eq!(swarm_status("draft", None), SwarmStatus::Planning);
        assert_eq!(swarm_status("paused", Some("attention")), SwarmStatus::Paused);
        assert_eq!(swarm_words(SwarmStatus::Waiting), "waiting for you");
        assert_eq!(swarm_tone(SwarmStatus::BudgetExhausted), Status::Gated);
        assert_eq!(paused_words(SwarmStatus::Paused, Some("manual")), Some("This swarm is paused. Resume it to continue."));
        assert_eq!(paused_words(SwarmStatus::Running, None), None);
    }

    #[test]
    fn refusals_follow_the_routes() {
        assert!(task_action_refusal(SwarmStatus::Stopped, TaskAction::MarkDone).is_some());
        assert!(task_action_refusal(SwarmStatus::Done, TaskAction::MarkDone).is_none());
        assert!(task_action_refusal(SwarmStatus::Done, TaskAction::Retry).is_some());
        assert!(task_action_refusal(SwarmStatus::Failed, TaskAction::Retry).is_none());
    }

    #[test]
    fn a_reported_leaf_waits_for_review_and_says_where_it_stands() {
        let t = task(serde_json::json!({"status": "working", "report": "Done.", "review": "undecided", "attention": "failed"}));
        assert_eq!(node_landing(&t), Some(Landing::Review));
        assert_eq!(diagram_words(&t, false), "not reviewed");
        assert_eq!(diagram_words(&t, true), "working");
        assert_eq!(diagram_attention(&t, false), Some("failed"));
        let accepted = task(serde_json::json!({"status": "working", "flags": {"accepted": true}}));
        assert_eq!(diagram_words(&accepted, false), "waiting to merge");
        let bad = task(serde_json::json!({"status": "failed", "flags": {"landingError": "x"}}));
        assert_eq!((diagram_words(&bad, false).as_str(), diagram_tone(&bad, false)), ("merge failed", Status::Failed));
        assert_eq!(diagram_words(&task(serde_json::json!({"nodeType": "plan", "status": "failed"})), false), "stalled");
        assert_eq!(diagram_words(&task(serde_json::json!({})), false), "pending");
        assert_eq!(diagram_words(&task(serde_json::json!({"status": "done"})), false), "completed");
    }

    #[test]
    fn idle_running_swarm_says_what_it_waits_on() {
        let first = task(serde_json::json!({"id": "a", "status": "working", "report": "r"}));
        let blocked = task(serde_json::json!({"id": "b", "parentId": "a", "parentRelation": "depends_on"}));
        let d = detail("running", vec![first, blocked]);
        assert_eq!(
            idle_words(&d).unwrap(),
            "No agent is running right now: 1 report is waiting for the planner to review it; 1 task is waiting for a task it depends on."
        );
        assert_eq!(
            leaf_start_blocker(&d.tasks[1], &d, true).unwrap(),
            "Waiting for \"T\" to finish first. It is in progress."
        );
        assert!(idle_words(&detail("blocked", vec![])).is_none());
    }

    #[test]
    fn timestamps_and_figures() {
        assert_eq!(epoch_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(epoch_ms("2026-11-27T15:23:58.271Z"), Some(1_795_793_038_271));
        assert_eq!(epoch_ms("2026-11-27T16:23:58.271+01:00"), Some(1_795_793_038_271));
        assert_eq!(epoch_ms("nope"), None);
        assert_eq!(format_elapsed(75_279.0), "1m 15s");
        assert_eq!(format_elapsed(3_725_000.0), "1h 2m");
        assert_eq!(format_usd(0.001), "<$0.01");
        assert_eq!(format_usd(5.0), "$5.00");
    }
}
