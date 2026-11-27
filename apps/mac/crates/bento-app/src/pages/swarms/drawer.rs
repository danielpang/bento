//! The inspector for an open swarm: its merge queue, then the selected task (or the planner)
//! as the console's node drawer draws it.

use bento_client::{RunStatus, SwarmDetail, SwarmTask};
use rune::{El, ScrollSpec, Tx, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, Dialog, Kit, Markdown, TextArea};
use serde_json::Value;

use super::view::{act, agent_name, button, chip, dot, key, leaf_counts};
use super::words::{self, Landing, TaskAction};
use super::{Act, Confirm, Load, Output, Selection, open_detail};
use crate::metal::{self, orb};
use crate::model::{Entry, Status, tools_line};
use crate::state::State;
use crate::theme::{Tokens, label, mono};

pub fn inspector(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> Option<El> {
    let d = open_detail(s)?;
    confirm_dialog(s, d, t, k, layer);
    let selection = match &s.swarms.selected {
        None => col()
            .key("drawer-empty")
            .w_full()
            .pt(24.0)
            .center()
            .child(label("Select a task", 13.0, 400.0, t.faint)),
        Some(Selection::Planner) => planner(s, d, t, k),
        Some(Selection::Task(id)) => match d.tasks.iter().find(|x| &x.id == id) {
            Some(task) => task_drawer(s, d, task, t, k),
            None => col(),
        },
    };
    let body = col().key("drawer").w_full().padding(16.0).gap(18.0).child(queue(d, t)).child(selection);
    Some(col().key("drawer-scroll").w_full().h_full().scroll(ScrollSpec::default()).child(body))
}

fn heading(name: &str, t: &Tokens) -> El {
    label(name.to_uppercase(), 11.0, 500.0, t.faint)
}

fn queue(d: &SwarmDetail, t: &Tokens) -> El {
    let waiting = d.landings.iter().filter(|l| matches!(l.status.as_str(), "queued" | "landing" | "conflicted")).count();
    let mut head = row().w_full().gap(8.0).center_y().child(label("Merge queue", 13.0, 600.0, t.text)).child(spacer());
    if waiting > 0 {
        head = head.child(label(format!("Branches: {waiting} waiting"), 11.5, 400.0, t.faint));
    } else if let Some(branch) = &d.swarm.branch_name {
        head = head.child(mono(branch.clone(), 11.0, t.faint).truncate().shrink());
    }
    let mut c = col().key("queue").w_full().gap(8.0).pb(14.0).border_sides([0.0, 0.0, 1.0, 0.0], t.line).child(head);
    if d.landings.is_empty() {
        return c.child(
            label("No branches yet. Accepted work appears here before it is committed to the swarm branch.", 12.0, 400.0, t.faint)
                .wrap()
                .key("queue-empty"),
        );
    }
    for (n, l) in d.landings.iter().enumerate() {
        let (words, tone) = words::landing_label(&l.status);
        let title = d.tasks.iter().find(|x| x.id == l.task_id).map_or_else(|| l.branch_name.clone().unwrap_or_default(), |x| x.title.clone());
        let mut r = col().key(format!("landing-{n}")).w_full().gap(3.0).child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(dot(tone, t))
                .child(label(title, 12.5, 450.0, if l.status == "queued" { t.dim } else { t.text }).truncate().shrink())
                .child(spacer())
                .child(label(words, 11.5, 400.0, t.faint)),
        );
        if let Some(e) = l.error.as_deref().filter(|e| !e.trim().is_empty() && matches!(l.status.as_str(), "failed" | "conflicted")) {
            r = r.child(label(e.lines().next().unwrap_or_default().to_owned(), 11.5, 400.0, t.faint).wrap().max_h(32.0).pl(15.0));
        }
        if l.status == "conflicted" {
            let text = if l.resolver_run_id.is_some() {
                "An agent is reconciling this branch with the swarm's branch. Nothing else is merged until it is settled."
            } else {
                "No agent is on this branch yet. One is asked for each time the swarm is reconciled, and nothing else is merged until this is settled."
            };
            r = r.child(label(text, 11.5, 400.0, t.faint).wrap().pl(15.0));
        }
        c = c.child(r);
    }
    let summary = d.landing_summary;
    if summary.total as usize > d.landings.len() {
        c = c.child(label(format!("{} branches", summary.total), 11.5, 400.0, t.faint));
    }
    c
}

fn entry(e: &Entry, n: usize, t: &Tokens, k: &Kit) -> El {
    match e {
        Entry::User(text) => col()
            .key(format!("user-{n}"))
            .w_full()
            .padding(10.0)
            .radius(8.0)
            .fill(t.raised)
            .child(Markdown::new(text.clone()).build(k).w_full()),
        Entry::Agent(text) => Markdown::new(text.clone()).build(k).key(format!("agent-{n}")).w_full(),
        Entry::System(text) => label(text.clone(), 11.5, 400.0, t.faint).wrap().key(format!("system-{n}")),
        Entry::Tools(names) => row()
            .key(format!("tools-{n}"))
            .gap(6.0)
            .child(el().size(5.0, 5.0).radius(2.5).fill(t.idle).mt(5.0))
            .child(mono(tools_line(names), 11.5, t.faint).wrap().shrink()),
        Entry::Failed(text) => label(text.clone(), 12.0, 450.0, t.failed).wrap().selectable(true).key(format!("failed-{n}")),
    }
}

/// A run's transcript, following the end while it streams.
fn output(out: Option<&Output>, empty: &str, t: &Tokens, k: &Kit) -> El {
    let Some(out) = out else {
        return label(empty.to_owned(), 12.0, 400.0, t.faint).wrap().key("output-empty");
    };
    let mut c = col().w_full().gap(12.0).pr(4.0);
    for (n, e) in out.entries.iter().enumerate() {
        c = c.child(entry(e, n, t, k));
    }
    if !out.draft.is_empty() {
        c = c.child(Markdown::new(out.draft.clone()).streaming(true).build(k).key("draft").w_full().opacity(0.75));
    }
    if out.entries.is_empty() && out.draft.is_empty() && out.ended.is_none() && out.error.is_none() {
        c = c.child(label("Loading the conversation.", 12.0, 400.0, t.faint));
    }
    if let Some(e) = &out.error {
        c = c.child(label(e.clone(), 12.0, 450.0, t.failed).wrap());
    }
    col()
        .key("output")
        .w_full()
        .max_h(380.0)
        .padding(10.0)
        .radius(8.0)
        .fill(t.panel)
        .border(1.0, t.line)
        .scroll(ScrollSpec { stick_bottom: true })
        .child(c)
}

fn planner(s: &State, d: &SwarmDetail, t: &Tokens, k: &Kit) -> El {
    let run = d.planner_run.as_ref();
    let running = run.is_some_and(|r| r.status == RunStatus::Running);
    let active = run.is_some_and(|r| r.status.is_active());
    let name = run.and_then(|r| r.agent.as_ref()).map_or("Planner".to_owned(), |a| a.name.clone());
    let words = run.map_or("Queued", |r| words::planner_words(r.status));
    let tone = match run.map(|r| r.status) {
        Some(RunStatus::Failed) => Status::Failed,
        Some(RunStatus::Succeeded) => Status::Succeeded,
        _ if active => Status::Running,
        _ => Status::Idle,
    };
    let mut c = col()
        .key("planner-drawer")
        .w_full()
        .gap(12.0)
        .child(
            row()
                .gap(10.0)
                .center_y()
                .child(orb(if running { metal::CHROME } else { metal::GUNMETAL }, if running { 1.0 } else { 0.0 }, 18.0))
                .child(label(name, 14.0, 600.0, t.text).truncate().shrink())
                .child(spacer())
                .child(chip(words, tone, t)),
        )
        .child(label("Planner agent", 11.5, 400.0, t.faint));
    if let Some(e) = run.and_then(|r| r.error.clone()).filter(|_| run.is_some_and(|r| r.status == RunStatus::Failed)) {
        c = c.child(label(e, 12.0, 450.0, t.failed).wrap().selectable(true).key("planner-error"));
    }
    let mut bar = row().gap(8.0).flex_wrap();
    if active {
        bar = bar.child(button("Stop", k, s.swarms.busy, act(Act::StopPlanner, None)).key("stop-planner"));
    }
    c = c.child(bar).child(heading("Planner output", t));
    c.child(output(s.swarms.output.as_ref(), "The planner's output appears here once it starts.", t, k))
}

/// The console's drawer rules for one node: which controls, which is primary, and the
/// sentence under "Next step".
pub struct Controls {
    pub primary: Option<(String, Act)>,
    pub more: Vec<(String, Act)>,
    pub stop: bool,
    pub refusal: Option<&'static str>,
    pub next_step: Option<String>,
    pub worker_active: bool,
    pub unmerged: bool,
}

pub fn controls(d: &SwarmDetail, task: &SwarmTask) -> Controls {
    let status = words::status_of(&d.swarm);
    let leaf = task.is_leaf();
    let active = words::agent_active(d, &task.id);
    let landing = words::node_landing(task);
    let mqf = landing == Some(Landing::Failed);
    let starting_over = task.flag("startingOver").and_then(Value::as_bool) == Some(true);
    let mut refusal = None;
    let mut allowed = |a: TaskAction, offered: bool| {
        if !offered {
            return false;
        }
        match words::task_action_refusal(status, a) {
            Some(r) => {
                refusal.get_or_insert(r);
                false
            }
            None => true,
        }
    };
    let st = task.status.as_str();
    let can_mark_done = allowed(TaskAction::MarkDone, leaf && st != "done");
    let can_retry = allowed(TaskAction::Retry, leaf && !mqf && !starting_over && !matches!(st, "cancelled" | "done" | "landed"));
    let can_retry_landing = allowed(TaskAction::RetryLanding, task.can_retry_landing);
    let can_start_over = allowed(TaskAction::Retry, leaf && !starting_over && !matches!(st, "cancelled" | "done"));
    let can_cancel = allowed(TaskAction::Cancel, st != "cancelled");
    let worker_active = leaf && st == "working" && (active || landing.is_none());
    let retries = task.flag("retries").and_then(Value::as_u64).unwrap_or(0);
    let so_far = |name: &str| if retries > 0 { format!("{name} ({retries} so far)") } else { name.to_owned() };

    #[derive(PartialEq)]
    enum P {
        StartOver,
        Landing,
        Retry,
    }
    let primary = if can_start_over && st == "failed" {
        Some(P::StartOver)
    } else if can_retry_landing {
        Some(P::Landing)
    } else if (st == "failed" || (st == "assigned" && task.assigned_run_id.is_some())) && can_retry {
        Some(P::Retry)
    } else {
        None
    };
    let mut more = Vec::new();
    if can_start_over && primary != Some(P::StartOver) {
        more.push((so_far("Retry task"), Act::StartOver));
    }
    if can_mark_done {
        more.push(("Mark done".into(), Act::MarkDone));
    }
    if can_retry_landing && primary != Some(P::Landing) {
        more.push(("Retry merge queue".into(), Act::RetryLanding));
    }
    if can_retry && primary != Some(P::Retry) {
        more.push((if can_start_over { "Retry in the same sandbox".into() } else { so_far("Retry") }, Act::Retry));
    }
    if can_cancel {
        more.push(("Cancel task".into(), Act::Cancel));
    }
    let blocker = words::leaf_start_blocker(task, d, true);
    let assigned_waiting = leaf && st == "assigned" && task.assigned_run_id.is_none() && !starting_over;
    let review = (leaf && landing == Some(Landing::Review) && !active).then(|| words::review_next_step(task.review.as_deref()));
    let next_step = if starting_over {
        Some("Restarting. The old sandbox is being removed, then a new agent starts on a fresh branch from the swarm's.".into())
    } else if mqf {
        Some("merge queue failure, see agent worker for more details".into())
    } else if leaf && landing == Some(Landing::Waiting) {
        Some("Waiting to merge. If the sandbox holding this branch is asleep, Bento starts it first, which can take a minute.".into())
    } else if let Some(r) = review {
        Some(r.into())
    } else if let (true, Some(b)) = (assigned_waiting, blocker) {
        Some(b)
    } else if primary == Some(P::StartOver) {
        Some("Start this task over in a new sandbox, or open More actions for other options.".into())
    } else if primary == Some(P::Retry) {
        (st == "assigned").then(|| "Start a new worker attempt.".into())
    } else if worker_active {
        Some(if active { "The worker is running. Open Worker logs to follow its progress." } else { "Waiting for an agent to start." }.into())
    } else if !more.is_empty() {
        Some("Open More actions for other options.".into())
    } else {
        Some("No action is available for this node.".into())
    };
    let primary = primary.map(|p| match p {
        P::StartOver => (so_far("Retry task"), Act::StartOver),
        P::Landing => ("Retry merge queue".into(), Act::RetryLanding),
        P::Retry => (so_far("Retry worker"), Act::Retry),
    });
    Controls {
        primary,
        more,
        stop: leaf && active,
        refusal,
        next_step,
        worker_active,
        unmerged: leaf && (landing.is_some() || st == "landed"),
    }
}

/// Runs an action, asking first for the two the console confirms.
fn press(a: Act, task: &str, unmerged: bool) -> impl Fn(&mut State, &mut Tx) + 'static {
    let task = task.to_owned();
    move |s: &mut State, tx: &mut Tx| match a {
        Act::StartOver => s.swarms.confirm = Some(Confirm::StartOver(task.clone())),
        Act::MarkDone => s.swarms.confirm = Some(Confirm::MarkDone { task: task.clone(), unmerged }),
        _ => act(a, Some(&task))(s, tx),
    }
}

fn task_drawer(s: &State, d: &SwarmDetail, task: &SwarmTask, t: &Tokens, k: &Kit) -> El {
    let active = words::agent_active(d, &task.id);
    let busy = s.swarms.busy;
    let words = words::diagram_words(task, active);
    let tone = words::diagram_tone(task, active);
    let ctl = controls(d, task);
    let lead = if active { orb(metal::CHROME, 1.0, 14.0) } else { dot(tone, t) };
    let kicker = if task.is_leaf() { "Swarm task" } else { "Plan node" };
    let mut c = col()
        .key("task-drawer")
        .w_full()
        .gap(12.0)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(label(kicker, 11.5, 500.0, t.faint))
                .child(spacer())
                .child(row().gap(6.0).center_y().child(lead).child(label(words, 12.0, 450.0, t.dim)).key("task-status")),
        )
        .child(label(task.title.clone(), 14.0, 600.0, t.text).wrap().selectable(true).key("task-title"));

    let mut facts = col().gap(4.0);
    if let Some(branch) = &task.branch_name {
        facts = facts.child(row().gap(8.0).child(label("Branch", 11.5, 400.0, t.faint)).child(mono(branch.clone(), 11.5, t.dim).truncate().shrink()));
    }
    if task.is_leaf() {
        let agent = agent_name(s, task.agent_profile_id.as_deref().or(d.swarm.worker_profile_id.as_deref()), "Swarm Worker");
        facts = facts.child(row().gap(8.0).child(label("Agent", 11.5, 400.0, t.faint)).child(label(agent, 11.5, 450.0, t.dim)));
    } else {
        let (done, total) = leaf_counts(d, Some(&task.id));
        facts = facts.child(label(format!("{done} of {total} done"), 11.5, 400.0, t.dim));
    }
    if let Some(l) = d.landings.iter().find(|l| l.task_id == task.id) {
        let (words, tone) = words::landing_label(&l.status);
        facts = facts.child(row().gap(8.0).center_y().child(label("Merge queue", 11.5, 400.0, t.faint)).child(dot(tone, t)).child(label(words, 11.5, 450.0, t.dim)));
    }
    c = c.child(facts.key("task-facts"));

    let note = if !task.is_leaf() && task.status == "failed" && !active {
        Some("A task below this plan failed. Open it to fix or retry it.")
    } else if words::node_landing(task) == Some(Landing::Failed) {
        None
    } else {
        words::attention_note(task.attention.as_deref())
    };
    if let Some(note) = note {
        c = c.child(
            row()
                .key("attention-note")
                .w_full()
                .gap(8.0)
                .padding(10.0)
                .radius(8.0)
                .fill(t.panel)
                .border(1.0, t.gated)
                .child(dot(Status::Gated, t).mt(5.0))
                .child(label(note, 12.0, 400.0, t.text).wrap().shrink()),
        );
    }

    let mut actions = col()
        .key("task-actions")
        .w_full()
        .gap(8.0)
        .child(label(if ctl.worker_active { "Current activity" } else { "Next step" }, 12.5, 600.0, t.text));
    if let Some(n) = &ctl.next_step {
        actions = actions.child(label(n.clone(), 12.0, 400.0, t.dim).wrap());
    }
    if let Some(r) = ctl.refusal {
        actions = actions.child(label(r, 11.5, 400.0, t.faint).wrap());
    }
    let mut bar = row().gap(8.0).flex_wrap().center_y();
    if let Some((name, a)) = &ctl.primary {
        bar = bar.child(key(name, t, (!busy).then(|| press(*a, &task.id, ctl.unmerged))).key("task-primary"));
    }
    if ctl.stop {
        bar = bar.child(button("Stop", k, busy, act(Act::StopWorker, Some(&task.id))).key("stop-worker"));
    }
    actions = actions.child(bar);
    if !ctl.more.is_empty() {
        let mut more = row().key("more-actions").gap(8.0).flex_wrap();
        for (n, (name, a)) in ctl.more.iter().enumerate() {
            more = more.child(button(name.clone(), k, busy, press(*a, &task.id, ctl.unmerged)).key(format!("more-{n}")));
        }
        actions = actions.child(label("More actions", 11.5, 500.0, t.faint)).child(more);
    }
    c = c.child(actions);

    c = c.child(heading("Description", t));
    c = c.child(if task.description.trim().is_empty() {
        label("The planner left this one to its title.", 12.0, 400.0, t.faint)
    } else {
        label(task.description.clone(), 12.5, 400.0, t.dim).wrap().selectable(true).key("description")
    });
    if let Some(report) = task.report.as_deref().filter(|r| !r.trim().is_empty()) {
        c = c.child(heading("Report", t)).child(Markdown::new(report.to_owned()).build(k).key("report").w_full());
    }
    if task.is_leaf() {
        c = c.child(heading("Worker logs", t));
        if let Some(e) = task.flag("landingError").and_then(Value::as_str) {
            c = c.child(
                col()
                    .gap(4.0)
                    .child(label("merge queue failure, see agent worker for more details", 12.0, 600.0, t.failed))
                    .child(label("The worker finished its attempt. Its branch could not be merged into the swarm branch.", 12.0, 400.0, t.dim).wrap())
                    .child(mono(e.to_owned(), 11.0, t.faint).wrap().selectable(true)),
            );
        }
        c = c.child(output(s.swarms.output.as_ref(), "Worker logs will appear here when this task starts.", t, k));
        c = c.child(compose(s, task, t, k));
    }
    c.child(commits(s, task, t))
}

fn commits(s: &State, task: &SwarmTask, t: &Tokens) -> El {
    let mut c = col().key("commits").w_full().gap(6.0).child(heading("Commits", t));
    match s.swarms.node.as_ref().filter(|(id, _)| *id == task.id).map(|(_, l)| l) {
        None | Some(Load::Loading) => c = c.child(label("Loading.", 12.0, 400.0, t.faint)),
        Some(Load::Failed(e)) => c = c.child(label(e.clone(), 12.0, 450.0, t.failed).wrap()),
        Some(Load::Ready(n)) if n.commits.is_empty() => {
            c = c.child(
                label("No commits carry this task's trailer yet. They appear here once its agent has committed, and stay after the branch lands.", 12.0, 400.0, t.faint)
                    .wrap(),
            )
        }
        Some(Load::Ready(n)) => {
            for (i, commit) in n.commits.iter().enumerate() {
                c = c.child(
                    row()
                        .key(format!("commit-{i}"))
                        .w_full()
                        .gap(8.0)
                        .child(mono(commit.sha.chars().take(7).collect::<String>(), 11.5, t.faint))
                        .child(label(commit.subject.clone(), 12.0, 400.0, t.dim).truncate().shrink()),
                );
            }
        }
    }
    c
}

fn compose(s: &State, task: &SwarmTask, t: &Tokens, k: &Kit) -> El {
    if matches!(task.status.as_str(), "done" | "cancelled") {
        return col();
    }
    let send = |s: &mut State, _: &mut Tx| super::send_task(s);
    let field = TextArea::new(&s.swarms.task_text)
        .label("Message the worker")
        .placeholder("Message the worker")
        .width(None)
        .auto_grow(1, 4)
        .on_edit(|s: &mut State| &mut s.swarms.task_text)
        .on_submit(send)
        .build(k)
        .key("task-composer");
    let empty = s.swarms.task_text.text.trim().is_empty();
    let mut c = col()
        .key("task-compose")
        .w_full()
        .gap(6.0)
        .child(field)
        .child(row().w_full().justify_end().child(Button::new("Send").variant(ButtonVariant::Neutral).disabled(empty || s.swarms.busy).on_press_tx(send).build(k).key("task-send")));
    if let Some((ok, note)) = &s.swarms.task_note {
        c = c.child(label(note.clone(), 11.5, 450.0, if *ok { t.faint } else { t.failed }).wrap().key("task-note"));
    }
    c
}

fn confirm_dialog(s: &State, d: &SwarmDetail, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let Some(confirm) = &s.swarms.confirm else { return };
    let (title, text, label_text, a, task) = match confirm {
        Confirm::StartOver(task) => (
            "Retry this task",
            "Retrying starts this task over. Any agent on it is stopped, its branch leaves the merge queue, its sandbox is removed, and a new agent in a new sandbox does the work again on a fresh branch from the swarm's.".to_owned(),
            "Retry task",
            Act::StartOver,
            task.clone(),
        ),
        Confirm::MarkDone { task, unmerged } => {
            let counts = "Marking this done counts its weight towards every plan above it, and towards the swarm's own ring.";
            let text = if *unmerged {
                format!("{counts} This task's branch has not been merged into the swarm's branch, and it will not be: marking it done takes it out of the merge queue.")
            } else {
                counts.to_owned()
            };
            ("Mark this task done", text, "Mark done", Act::MarkDone, task.clone())
        }
    };
    let name = d.tasks.iter().find(|x| x.id == task).map(|x| x.title.clone()).unwrap_or_default();
    let go = move |s: &mut State, tx: &mut Tx| {
        s.swarms.confirm = None;
        act(a, Some(&task))(s, tx);
    };
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut State| s.swarms.confirm = None).build(k).key("confirm-cancel"))
        .child(key(label_text, t, Some(go)).key("confirm-go"));
    Dialog::new("swarm-confirm", title)
        .description(name)
        .width(460.0)
        .fit()
        .open(true)
        .on_close(|s: &mut State| s.swarms.confirm = None)
        .child(col().w_full().px(16.0).child(label(text, 12.5, 400.0, t.dim).wrap()))
        .child(buttons)
        .build(k, layer);
}
