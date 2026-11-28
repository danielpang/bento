//! The drawer's Details tab: the branch, the stage's requirements and a re-check, what the card
//! cost, its runs, and every move it made, in the console's words.

use bento_client::{AgentRun, FeatureEvent, FeatureStatus, GateCheck, RunStatus};
use rune::{El, ScrollSpec, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, Kit};

use super::{Review, recheck};
use crate::model::{LaneKind, REVIEW_RULE};
use crate::pages::artifacts::{Load, created_label};
use crate::pages::sessions::{ago, now_unix, run_words, token_count};
use crate::state::State;
use crate::theme::{Tokens, label, mono};

/// Names for requirement types, as the console's `CRITERION_NAMES`.
fn criterion_name(kind: &str) -> &'static str {
    match kind {
        "manual" => "A person approves",
        "run_succeeded" => "The agent finished",
        "agent_judge" => "An agent verifies the work is complete",
        "command" => "A command succeeds",
        "checks_pass" => "GitHub checks pass",
        "pr_comments_resolved" => "No unresolved review comments",
        _ => "A requirement this version does not recognize",
    }
}

/// Who or what moved the card, as `historyTriggerLabel` says it.
fn trigger_label(e: &FeatureEvent) -> String {
    let name = e.actor_name.as_deref().map(str::trim).unwrap_or("");
    let mail = e.actor_email.as_deref().map(str::trim).unwrap_or("");
    let actor = if !name.is_empty() && name != mail { Some(name) } else { Some(mail).filter(|m| !m.is_empty()) };
    match (e.trigger.as_str(), actor) {
        ("manual", Some(a)) => format!("by {a}"),
        ("manual", None) => "by a person".into(),
        ("manual_back", Some(a)) => format!("sent back by {a}"),
        ("manual_back", None) => "sent back".into(),
        ("gate_auto", _) => "by a gate".into(),
        ("gate_auto_back", _) => "returned by a gate".into(),
        ("agent_run", _) => "by an agent".into(),
        ("linear_auto", _) => "on arrival from Linear".into(),
        ("system", _) => "automatic".into(),
        (other, _) => other.to_owned(),
    }
}

/// The pipeline's stages, in order, by id and name.
fn stages(s: &State) -> Vec<(&str, &str)> {
    s.lanes
        .iter()
        .filter_map(|l| match &l.kind {
            LaneKind::Stage(id) => Some((id.as_str(), l.name.as_str())),
            _ => None,
        })
        .collect()
}

fn stage_name<'a>(id: Option<&str>, stages: &[(&str, &'a str)]) -> &'a str {
    match id {
        None => "Backlog",
        Some(id) => stages.iter().find(|(s, _)| *s == id).map_or("a removed stage", |(_, n)| n),
    }
}

/// A history row's sentence, as the console's `describeEvent`.
fn describe(e: &FeatureEvent, stages: &[(&str, &str)]) -> String {
    if e.kind == "stage_moved" {
        if e.to_stage_id.is_none() && e.from_stage_id.is_some() && !e.trigger.ends_with("_back") {
            let last = stages.last().map(|(id, _)| *id);
            let from = stage_name(e.from_stage_id.as_deref(), stages);
            return if last.is_some() && e.from_stage_id.as_deref() != last { format!("Completed from {from}") } else { format!("Finished {from}") };
        }
        return format!("{} to {}", stage_name(e.from_stage_id.as_deref(), stages), stage_name(e.to_stage_id.as_deref(), stages));
    }
    format!("Status {} to {}", e.from_status.as_deref().unwrap_or("new"), e.to_status.as_deref().unwrap_or("unknown"))
}

/// What the card's finished runs cost, as the console's `CardSpend`.
fn spend(runs: &[AgentRun]) -> Option<String> {
    let finished: Vec<&AgentRun> = runs.iter().filter(|r| r.status.is_terminal() && r.role.as_deref() != Some("judge")).collect();
    if finished.is_empty() {
        return None;
    }
    let measured: Vec<f64> = finished.iter().filter_map(|r| r.cost_usd).collect();
    if measured.is_empty() {
        return Some("Cost not reported.".into());
    }
    let total: f64 = measured.iter().sum();
    let silent = finished.len() - measured.len();
    Some(if silent > 0 { format!("${total:.2}. May be higher because some agents don't report cost.") } else { format!("${total:.2}") })
}

fn heading(name: &str, t: &Tokens) -> El {
    label(name.to_uppercase(), 11.0, 500.0, t.faint)
}

fn section(key: &str, name: &str, t: &Tokens) -> El {
    col().key(key.to_owned()).w_full().gap(8.0).child(heading(name, t))
}

fn faint(text: impl Into<String>, t: &Tokens) -> El {
    label(text, 12.5, 400.0, t.faint).wrap()
}

fn check(c: &GateCheck, t: &Tokens) -> El {
    let (mark, color) = match c.status.as_str() {
        "passed" => ("✓", t.succeeded),
        "failed" => ("●", t.failed),
        _ => ("●", t.gated),
    };
    let detail = c.detail.as_ref().and_then(|d| d.message.clone()).unwrap_or_else(|| "Not evaluated yet".into());
    row()
        .key(format!("check-{}", c.id))
        .w_full()
        .gap(10.0)
        .items_start()
        .child(label(mark, 12.0, 700.0, color).w(12.0))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(label(criterion_name(&c.criterion.kind), 12.5, 500.0, t.text).wrap())
                .child(label(detail, 12.0, 400.0, t.dim).wrap().selectable(true)),
        )
}

fn requirements(s: &State, r: &Review, t: &Tokens, k: &Kit) -> Option<El> {
    let f = &r.detail.as_ref()?.feature;
    let stage = f.current_stage_id.as_deref()?;
    if matches!(f.status, FeatureStatus::Done | FeatureStatus::Cancelled) {
        return None;
    }
    let manual = s.lanes.iter().find(|l| l.kind == LaneKind::Stage(stage.to_owned())).is_some_and(|l| l.rule == REVIEW_RULE);
    let mut c = section("requirements", "Requirements", t);
    match &r.gate {
        Load::Loading => {}
        Load::Failed { message, .. } => c = c.child(super::changes::failed(message, t)),
        Load::Ready(g) if !g.checks.is_empty() => {
            for x in &g.checks {
                c = c.child(check(x, t));
            }
        }
        Load::Ready(_) if manual => {
            c = c.child(faint("You decide on this card: Approve moves it on, Reject sends it back. There are no automatic requirements.", t));
        }
        Load::Ready(_) => {
            c = c.child(faint("Nothing has been evaluated yet. The requirements are checked when a run finishes, or when you press Re-check requirements.", t));
        }
    }
    if !manual {
        let again = Button::new("Re-check requirements")
            .variant(ButtonVariant::Neutral)
            .disabled(r.rechecking || s.busy)
            .on_press(recheck)
            .build(k)
            .key("recheck");
        c = c.child(row().child(again));
    }
    Some(c)
}

fn dot(color: rune::color::Color) -> El {
    el().size(7.0, 7.0).radius(3.5).fill(color)
}

fn run_row(r: &Review, run: &AgentRun, now: i64, t: &Tokens) -> El {
    let color = match run.status {
        RunStatus::Succeeded => t.succeeded,
        RunStatus::Failed => t.failed,
        RunStatus::Cancelled | RunStatus::Unknown => t.idle,
        _ => t.running,
    };
    let agent = r.agent_name(&run.agent_profile_id).unwrap_or("agent");
    let mut tail = run.queued_at.as_deref().map(|q| ago(q, now)).unwrap_or_default();
    if let Some(cost) = run.cost_usd {
        tail = format!("{tail} · ${cost:.2}");
    }
    let mut c = col().key(format!("run-{}", run.id)).w_full().gap(3.0).child(
        row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(dot(color))
            .child(label(format!("{agent} {}", run_words(run.status)), 12.5, 400.0, t.text).truncate().shrink())
            .child(spacer())
            .child(label(tail, 11.5, 400.0, t.faint)),
    );
    if let Some(e) = run.error.as_deref().filter(|e| run.status == RunStatus::Failed && !e.trim().is_empty()) {
        c = c.child(label(e.to_owned(), 11.5, 400.0, t.failed).wrap().selectable(true).pl(15.0).max_h(80.0));
    }
    c
}

pub fn tab(s: &State, card: &str, t: &Tokens, k: &Kit) -> El {
    let frame = |c: El| col().key("drawer-details").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec::default()).child(c);
    let Some(r) = s.review.of(card) else { return frame(faint("Loading the conversation.", t)) };
    let mut c = col().w_full().gap(20.0).pr(4.0).pb(12.0);
    let detail = r.detail.as_ref();
    if let Some(branch) = detail.and_then(|d| d.feature.branch_name.clone()) {
        c = c.child(section("branch", "Branch", t).child(mono(branch, 12.0, t.text).wrap().selectable(true)));
    }
    if let Some(req) = requirements(s, r, t, k) {
        c = c.child(req);
    }
    let runs = detail.map_or(&[][..], |d| &d.runs[..]);
    let cost = spend(runs).unwrap_or_else(|| "Not reported".into());
    let tokens = if r.tokens == 0 { "Not reported".to_owned() } else { token_count(r.tokens) };
    let fact = |name: &str, value: String| row().w_full().gap(12.0).child(label(name.to_owned(), 12.0, 400.0, t.faint).w(56.0)).child(label(value, 12.5, 400.0, t.text).wrap().grow(1.0).shrink());
    c = c.child(col().key("spend").w_full().gap(6.0).child(fact("Cost", cost)).child(fact("Tokens", tokens)));
    if !runs.is_empty() {
        let now = now_unix();
        let mut list = section("runs", "Runs", t);
        for run in runs {
            list = list.child(run_row(r, run, now, t));
        }
        c = c.child(list);
    }
    let stages = stages(s);
    let mut history = section("history", "History", t);
    history = match &r.history {
        Load::Loading => history,
        Load::Failed { .. } => history.child(faint("History could not be loaded.", t)),
        Load::Ready(events) if events.is_empty() => history.child(faint("No history yet. Stage changes and approvals will appear here.", t)),
        Load::Ready(events) => events.iter().fold(history, |h, e| {
            h.child(
                col()
                    .key(format!("history-{}", e.id))
                    .w_full()
                    .gap(2.0)
                    .child(label(created_label(&e.at), 11.0, 400.0, t.faint))
                    .child(row().w_full().gap(6.0).flex_wrap().child(label(describe(e, &stages), 12.5, 400.0, t.text)).child(label(trigger_label(e), 12.5, 400.0, t.faint))),
            )
        }),
    };
    frame(c.child(history))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, from: Option<&str>, to: Option<&str>, trigger: &str) -> FeatureEvent {
        FeatureEvent {
            id: "e".into(),
            kind: kind.into(),
            from_stage_id: from.map(Into::into),
            to_stage_id: to.map(Into::into),
            from_status: Some("active".into()),
            to_status: Some("gated".into()),
            trigger: trigger.into(),
            actor_name: None,
            actor_email: Some("dana@example.com".into()),
            run_id: None,
            at: "2026-11-27T06:30:54.000Z".into(),
        }
    }

    #[test]
    fn history_reads_as_the_console_writes_it() {
        let stages = [("s1", "Plan"), ("s2", "Build")];
        assert_eq!(describe(&event("stage_moved", None, Some("s1"), "manual"), &stages), "Backlog to Plan");
        assert_eq!(describe(&event("stage_moved", Some("s2"), None, "gate_auto"), &stages), "Finished Build");
        assert_eq!(describe(&event("stage_moved", Some("s1"), None, "manual"), &stages), "Completed from Plan");
        assert_eq!(describe(&event("stage_moved", Some("s1"), None, "manual_back"), &stages), "Plan to Backlog");
        assert_eq!(describe(&event("status_changed", None, None, "system"), &stages), "Status active to gated");
        assert_eq!(trigger_label(&event("stage_moved", None, None, "manual")), "by dana@example.com");
        assert_eq!(trigger_label(&event("stage_moved", None, None, "gate_auto_back")), "returned by a gate");
        assert_eq!(criterion_name("command"), "A command succeeds");
    }

    #[test]
    fn spend_is_a_floor_when_an_agent_reports_nothing() {
        let run = |status: &str, cost: Option<f64>, role: Option<&str>| -> AgentRun {
            serde_json::from_value(serde_json::json!({"id": "r", "featureId": "f", "agentProfileId": "a", "status": status, "costUsd": cost, "role": role})).unwrap()
        };
        assert_eq!(spend(&[run("running", None, None)]), None);
        assert_eq!(spend(&[run("failed", None, None)]).as_deref(), Some("Cost not reported."));
        assert_eq!(spend(&[run("succeeded", Some(0.5), None), run("succeeded", Some(0.25), None)]).as_deref(), Some("$0.75"));
        assert_eq!(
            spend(&[run("succeeded", Some(0.5), None), run("failed", None, None), run("succeeded", None, Some("judge"))]).as_deref(),
            Some("$0.50. May be higher because some agents don't report cost.")
        );
    }
}
