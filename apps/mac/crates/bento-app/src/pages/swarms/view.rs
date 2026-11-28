//! The main pane: the list of swarms, or one swarm with its planner and task tree.

use bento_client::{RunStatus, SwarmDetail, SwarmRow, SwarmTask};
use rune::{Align, Cx, El, ScrollSpec, Tx, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, Kit, TextArea};

use super::words::{self, SwarmStatus};
use super::{Act, Load, Selection};
use crate::metal::{self, face, orb, ring};
use crate::model::Status;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

pub fn status_color(st: Status, t: &Tokens) -> rune::color::Color {
    match st {
        Status::Idle => t.idle,
        Status::Running => t.running,
        Status::Gated => t.gated,
        Status::Failed => t.failed,
        Status::Succeeded => t.succeeded,
    }
}

pub fn dot(st: Status, t: &Tokens) -> El {
    el().size(7.0, 7.0).radius(3.5).fill(status_color(st, t))
}

/// A status pill in the swarm's own words.
pub fn chip(words: &str, st: Status, t: &Tokens) -> El {
    row()
        .h(20.0)
        .px(8.0)
        .gap(6.0)
        .radius(10.0)
        .center_y()
        .border(1.0, t.line)
        .child(dot(st, t))
        .child(label(words.to_owned(), 11.0, 450.0, t.dim).truncate())
}

/// The one primary action in a view: a domed copper key. `None` draws it disabled.
pub fn key(name: &str, t: &Tokens, on_press: Option<impl Fn(&mut State, &mut Tx) + 'static>) -> El {
    let k = row()
        .h(30.0)
        .px(14.0)
        .radius(9.0)
        .center()
        .role("button")
        .label(name)
        .child(face(metal::KEY, 0.0, 9.0))
        .child(label(name.to_owned(), 13.0, 600.0, t.on_brand));
    match on_press {
        Some(f) => k.focusable(true).on_press_tx(f),
        None => k.opacity(0.45),
    }
}

pub fn button(name: impl Into<String>, k: &Kit, busy: bool, f: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    Button::new(name).variant(ButtonVariant::Neutral).disabled(busy).on_press_tx(f).build(k)
}

pub fn act(a: Act, task: Option<&str>) -> impl Fn(&mut State, &mut Tx) + 'static {
    let task = task.map(str::to_owned);
    move |s: &mut State, _: &mut Tx| super::act(s, a, task.clone())
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn age(iso: Option<&str>) -> Option<String> {
    let at = words::epoch_ms(iso?)?;
    let seconds = (words::now_ms() - at).max(0) / 1000;
    Some(match seconds {
        s if s < 60 => "just now".into(),
        s if s < 3_600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3_600),
        s => format!("{}d ago", s / 86_400),
    })
}

fn centered(key: &str, text: impl Into<String>, t: &Tokens) -> El {
    col().key(key).w_full().h_full().center().child(label(text, 13.0, 400.0, t.faint).wrap().align(Align::Center).max_w(420.0))
}

pub fn main(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, _layer: &mut Vec<El>) -> El {
    if s.project.is_none() {
        return centered("swarms-none", "Choose a project to see its swarms.", t);
    }
    match &s.swarms.open {
        None => list(s, t, k),
        Some(_) => match &s.swarms.detail {
            Load::Loading => centered("swarm-loading", "Loading the swarm.", t),
            Load::Failed(e) => failed("swarm-error", e, t, k, |s: &mut State, _: &mut Tx| {
                if let Some(id) = s.swarms.open.clone() {
                    super::open_swarm(s, &id);
                }
            }),
            Load::Ready(d) => detail(s, d, t, k),
        },
    }
}

fn failed(key: &str, e: &str, t: &Tokens, k: &Kit, retry: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    col()
        .key(key)
        .w_full()
        .h_full()
        .center()
        .gap(12.0)
        .child(label(e.to_owned(), 13.0, 450.0, t.failed).wrap().align(Align::Center).max_w(440.0).selectable(true))
        .child(button("Retry", k, false, retry).key("retry"))
}

fn list(s: &State, t: &Tokens, k: &Kit) -> El {
    let rows = match &s.swarms.list {
        Load::Loading => return centered("swarms-loading", "Loading swarms.", t),
        Load::Failed(e) => return failed("swarms-error", e, t, k, |s: &mut State, _: &mut Tx| super::enter(s)),
        Load::Ready(rows) => rows,
    };
    if rows.is_empty() {
        return col()
            .key("swarms-empty")
            .w_full()
            .h_full()
            .center()
            .gap(10.0)
            .child(orb(metal::GUNMETAL, 0.0, 36.0))
            .child(label("No swarms yet", 16.0, 600.0, t.text))
            .child(
                label("A swarm splits one goal into a tree of tasks, each worked by its own agent, and merges them onto one branch.", 13.0, 400.0, t.dim)
                    .wrap()
                    .align(Align::Center)
                    .max_w(420.0),
            );
    }
    let mut c = col().key("swarm-list").w_full().padding(16.0).gap(10.0);
    for r in rows.iter().filter(|r| r.swarm.archived_at.is_none()) {
        c = c.child(list_row(r, t));
    }
    let archived = rows.iter().filter(|r| r.swarm.archived_at.is_some()).count();
    if archived > 0 {
        c = c.child(label(format!("{archived} archived"), 11.5, 400.0, t.faint).key("archived"));
    }
    col().key("swarm-list-scroll").w_full().h_full().scroll(ScrollSpec::default()).child(c)
}

/// Metal says the swarm is alive (chrome, flowing) or waiting on a person (gold, still).
fn swarm_ring(status: SwarmStatus, radius: f32) -> Option<El> {
    match words::swarm_tone(status) {
        Status::Running => Some(ring(metal::CHROME, 2.0, 1.0, radius)),
        Status::Gated => Some(ring(metal::GOLD, 2.0, 0.0, radius)),
        _ => None,
    }
}

fn progress_bar(fraction: f32, t: &Tokens, live: bool) -> El {
    let fill = if live {
        el().w_frac(fraction.clamp(0.0, 1.0)).h_full().radius(3.0).child(face(metal::CHROME, 1.0, 3.0))
    } else {
        el().w_frac(fraction.clamp(0.0, 1.0)).h_full().radius(3.0).fill(t.dim)
    };
    row().w(120.0).h(6.0).radius(3.0).fill(t.bg).border(1.0, t.line).child(fill)
}

fn list_row(r: &SwarmRow, t: &Tokens) -> El {
    let sw = &r.swarm;
    let status = words::status_of(sw);
    let id = sw.id.clone();
    let mut card = col()
        .key(format!("swarm-{}", sw.id))
        .w_full()
        .padding(14.0)
        .gap(8.0)
        .radius(10.0)
        .fill(t.panel)
        .border(1.0, t.line)
        .role("button")
        .label(sw.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| super::open_swarm(s, &id));
    if let Some(r) = swarm_ring(status, 10.0) {
        card = card.child(r);
    }
    let head = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(label(sw.title.clone(), 13.5, 600.0, t.text).truncate().shrink())
        .child(spacer())
        .child(chip(&capitalise(words::swarm_words(status)), words::swarm_tone(status), t));
    card = card.child(head);
    if !sw.goal.trim().is_empty() {
        card = card.child(label(sw.goal.clone(), 12.0, 400.0, t.dim).wrap().max_h(34.0));
    }
    let counts = r.counts;
    let fraction = if counts.tasks == 0 { 0.0 } else { counts.done as f32 / counts.tasks as f32 };
    let mut foot = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(progress_bar(fraction, t, words::swarm_tone(status) == Status::Running))
        .child(mono(format!("{} / {} tasks", counts.done, counts.tasks), 11.5, t.dim));
    let spent = sw.spent_usd();
    if spent > 0.0 || sw.budget_usd.is_some() {
        let money = match sw.budget_usd {
            Some(b) => format!("{} of {}", words::format_usd(spent), words::format_usd(b)),
            None => words::format_usd(spent),
        };
        foot = foot.child(mono(money, 11.5, t.dim));
    }
    if counts.attention > 0 && words::swarm_tone(status) == Status::Gated {
        foot = foot.child(label(format!("{} need you", counts.attention), 11.5, 450.0, t.gated));
    }
    foot = foot.child(spacer());
    if let Some(when) = age(sw.created_at.as_deref()) {
        foot = foot.child(label(format!("Created {when}"), 11.5, 400.0, t.faint));
    }
    card.child(foot)
}

/// The tree in reading order: each node, then its children by position, with its depth.
pub fn tree_rows(d: &SwarmDetail) -> Vec<(usize, usize)> {
    let tasks = &d.tasks;
    let known = |id: &str| tasks.iter().any(|t| t.id == id);
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); tasks.len()];
    let mut roots = Vec::new();
    for (i, task) in tasks.iter().enumerate() {
        match task.parent_id.as_deref().filter(|p| known(p) && *p != task.id) {
            Some(p) => {
                let parent = tasks.iter().position(|t| t.id == p).unwrap_or(i);
                children[parent].push(i);
            }
            None => roots.push(i),
        }
    }
    let by_position = |v: &mut Vec<usize>| v.sort_by_key(|&i| tasks[i].position);
    by_position(&mut roots);
    children.iter_mut().for_each(by_position);
    let mut out = Vec::with_capacity(tasks.len());
    let mut seen = vec![false; tasks.len()];
    let mut stack: Vec<(usize, usize)> = roots.into_iter().rev().map(|i| (i, 0)).collect();
    while let Some((i, depth)) = stack.pop() {
        if std::mem::replace(&mut seen[i], true) {
            continue;
        }
        out.push((i, depth));
        stack.extend(children[i].iter().rev().map(|&c| (c, depth + 1)));
    }
    out
}

/// Whether a plan node's children are hidden: a finished group starts folded, and a press
/// on its arrow flips that.
pub fn folded(task: &SwarmTask, toggled: &[String]) -> bool {
    !task.is_leaf() && (task.status == "done") != toggled.contains(&task.id)
}

/// The rows on screen: the tree without the children of folded groups.
pub fn visible_rows(d: &SwarmDetail, toggled: &[String]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut hide_below: Option<usize> = None;
    for (i, depth) in tree_rows(d) {
        if hide_below.is_some_and(|h| depth > h) {
            continue;
        }
        hide_below = folded(&d.tasks[i], toggled).then_some(depth);
        out.push((i, depth));
    }
    out
}

/// Leaves done and leaves planned under a node (or the whole swarm for None).
pub fn leaf_counts(d: &SwarmDetail, under: Option<&str>) -> (usize, usize) {
    let inside = |task: &SwarmTask| -> bool {
        let Some(root) = under else { return true };
        let mut at = task.parent_id.as_deref();
        let mut hops = 0;
        while let Some(p) = at {
            if p == root {
                return true;
            }
            hops += 1;
            if hops > d.tasks.len() {
                break;
            }
            at = d.tasks.iter().find(|t| t.id == p).and_then(|t| t.parent_id.as_deref());
        }
        false
    };
    let leaves: Vec<&SwarmTask> = d.tasks.iter().filter(|t| t.is_leaf() && t.status != "cancelled" && inside(t)).collect();
    (leaves.iter().filter(|t| t.status == "done").count(), leaves.len())
}

pub fn agent_name(s: &State, id: Option<&str>, fallback: &str) -> String {
    id.and_then(|id| s.swarms.profiles.iter().find(|p| p.id == id)).map_or_else(|| fallback.to_owned(), |p| p.name.clone())
}

/// What the header offers and says, from the console's own rules.
pub struct Header {
    pub status_label: String,
    pub tone: Status,
    pub primary: Option<(&'static str, Act)>,
    pub sentence: Option<String>,
    pub planner_active: bool,
    pub waiting_for_plan: bool,
}

pub fn header(d: &SwarmDetail) -> Header {
    let status = words::status_of(&d.swarm);
    let planner = d.planner_run.as_ref();
    let planner_active = planner.is_some_and(|r| r.status.is_active());
    let plan_ready = d.tasks.iter().any(|t| t.is_leaf() && t.status != "cancelled");
    let open_leaves = d.tasks.iter().any(|t| t.is_leaf() && t.status == "open" && t.attention.is_none());
    let needs_approval = !planner_active
        && ((status == SwarmStatus::Planning && plan_ready)
            || (open_leaves && matches!(status, SwarmStatus::Running | SwarmStatus::Waiting | SwarmStatus::Done)));
    let waiting_for_plan = status == SwarmStatus::Planning && !plan_ready;
    let planner_failed = waiting_for_plan && planner.is_some_and(|r| r.status == RunStatus::Failed);
    let primary = if needs_approval {
        Some(("Approve plan", Act::Start))
    } else if words::can_resume(status) {
        Some(("Resume work", Act::Start))
    } else if planner_failed {
        Some(("Retry planner", Act::RetryPlanner))
    } else {
        None
    };
    let next_step = if waiting_for_plan {
        Some(match planner.map(|r| r.status) {
            Some(RunStatus::Failed) => "Planner failed. Open its output below, then retry.",
            Some(RunStatus::Queued) => "Your planner is queued. The plan will appear here after it starts.",
            Some(RunStatus::Starting) => "Preparing a workspace for the planner. Your plan will appear here once it starts.",
            _ if planner_active => "Planner is building the task tree. Review the plan here before starting work.",
            _ => "The plan is not ready. Message the planner to finish it.",
        })
    } else if needs_approval {
        Some("Review the diagram, then approve the plan to start ready workers.")
    } else {
        None
    };
    let still = if status == SwarmStatus::Waiting {
        Some("This swarm is waiting for you. Open the highlighted tasks in the diagram to see what each one needs.".to_owned())
    } else {
        words::idle_words(d)
    };
    let sentence = words::paused_words(status, d.swarm.paused_reason.as_deref())
        .map(str::to_owned)
        .or(next_step.map(str::to_owned))
        .or(still);
    let stalled = planner_failed || status == SwarmStatus::Failed;
    Header {
        status_label: capitalise(if stalled { "stalled" } else { words::swarm_words(status) }),
        tone: if stalled { Status::Gated } else { words::swarm_tone(status) },
        primary,
        sentence,
        planner_active,
        waiting_for_plan,
    }
}

fn stat(name: &str, value: String, sub: String, t: &Tokens) -> El {
    col()
        .key(format!("stat-{}", name.to_lowercase().replace(' ', "-")))
        .gap(2.0)
        .min_w(96.0)
        .child(label(name.to_owned(), 11.0, 500.0, t.faint))
        .child(if name == "Agents" { label(value, 13.0, 500.0, t.text).truncate() } else { mono(value, 13.0, t.text) })
        .child(label(sub, 11.0, 400.0, t.faint).truncate())
}

fn detail(s: &State, d: &SwarmDetail, t: &Tokens, k: &Kit) -> El {
    let sw = &d.swarm;
    let status = words::status_of(sw);
    let h = header(d);
    let busy = s.swarms.busy;

    let back = Button::new("All swarms")
        .variant(ButtonVariant::Ghost)
        .on_press(|s: &mut State| super::close_swarm(s))
        .build(k)
        .key("back");
    let mut actions = row().gap(8.0).center_y();
    if status == SwarmStatus::Planning && h.planner_active {
        actions = actions.child(button("Pause planner", k, busy, act(Act::Pause, None)).key("pause"));
    } else if matches!(status, SwarmStatus::Running | SwarmStatus::Waiting) {
        actions = actions.child(button("Pause work", k, busy, act(Act::Pause, None)).key("pause"));
    }
    if words::can_stop(status) {
        actions = actions.child(button("Stop swarm", k, busy, act(Act::Stop, None)).key("stop"));
    }
    if let Some((name, a)) = h.primary {
        actions = actions.child(key(name, t, (!busy).then(|| act(a, None))).key("primary"));
    }
    let title = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(label(sw.title.clone(), 16.0, 600.0, t.text).truncate().shrink())
        .child(chip(&h.status_label, h.tone, t).key("swarm-status"))
        .child(spacer())
        .child(actions);
    let mut meta = row().gap(12.0).center_y().child(back);
    if let Some(branch) = &sw.branch_name {
        meta = meta.child(mono(branch.clone(), 11.5, t.dim).truncate().shrink());
    }
    if let Some(when) = age(sw.created_at.as_deref()) {
        meta = meta.child(label(format!("Created {when}"), 11.5, 400.0, t.faint));
    }
    let mut head = col().key("swarm-head").w_full().gap(8.0).child(title).child(meta);
    if !sw.goal.trim().is_empty() {
        head = head.child(label(sw.goal.clone(), 12.5, 400.0, t.dim).wrap().max_h(54.0).selectable(true).key("goal"));
    }
    if let Some(sentence) = &h.sentence {
        let (st, color) = if h.tone == Status::Gated { (Status::Gated, t.text) } else { (Status::Idle, t.dim) };
        head = head.child(
            row()
                .key("swarm-sentence")
                .w_full()
                .gap(8.0)
                .padding(10.0)
                .radius(8.0)
                .fill(t.panel)
                .border(1.0, t.line)
                .child(dot(st, t).mt(5.0))
                .child(label(sentence.clone(), 12.5, 400.0, color).wrap().shrink()),
        );
    }
    head = head.child(stats(s, d, t));

    let tree = tree(s, d, t);
    col()
        .key("swarm")
        .w_full()
        .h_full()
        .padding(16.0)
        .gap(14.0)
        .child(head)
        .child(col().key("tree-scroll").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec::default()).child(tree))
        .child(composer(s, d, k, t))
}

fn stats(s: &State, d: &SwarmDetail, t: &Tokens) -> El {
    let sw = &d.swarm;
    let (done, total) = leaf_counts(d, None);
    let leaves = || d.tasks.iter().filter(|x| x.is_leaf());
    let open = leaves().filter(|x| x.status == "open").count();
    let blocked = leaves().filter(|x| x.status == "blocked").count();
    let workers = d.active_runs.iter().filter(|r| r.role.as_deref() == Some("worker")).count();
    let mut r = row()
        .key("swarm-stats")
        .w_full()
        .gap(20.0)
        .flex_wrap()
        .child(stat("Tasks", format!("{done} / {total}"), format!("{open} open · {blocked} blocked"), t))
        .child(stat("Agent time", words::format_elapsed(d.agent_time_ms), "Not counting waits".into(), t));
    let spent = sw.spent_usd();
    if spent > 0.0 || sw.budget_usd.is_some() {
        let sub = sw.budget_usd.map_or("No budget cap".to_owned(), |b| format!("{} budget", words::format_usd(b)));
        r = r.child(stat("Spend estimate", words::format_usd(spent), sub, t));
    }
    let active = if workers > 0 { format!("{workers} active") } else { "None active".into() };
    r = r.child(stat("Workers", sw.max_workers.to_string(), active, t));
    let planner = agent_name(s, sw.planner_profile_id.as_deref(), d.planner_run.as_ref().and_then(|p| p.agent.as_ref()).map_or("Swarm Planner", |a| a.name.as_str()));
    let worker = agent_name(s, sw.worker_profile_id.as_deref(), "Swarm Worker");
    r.child(stat("Agents", planner, worker, t))
}

fn tree(s: &State, d: &SwarmDetail, t: &Tokens) -> El {
    let mut c = col().key("tree").w_full().gap(6.0).pr(4.0).child(planner_card(s, d, t));
    let rows = visible_rows(d, &s.swarms.toggled);
    let compact = d.tasks.len() > 12;
    if rows.is_empty() {
        let h = header(d);
        let text = if h.waiting_for_plan { "The task tree appears here as the planner writes it." } else { "This swarm has no tasks." };
        return c.child(label(text, 12.5, 400.0, t.faint).key("tree-empty").mt(8.0));
    }
    c = c.child(label("TASKS", 11.0, 500.0, t.faint).mt(10.0).mb(2.0));
    for (n, (i, depth)) in rows.into_iter().enumerate() {
        c = c.child(task_row(s, d, &d.tasks[i], depth, n, compact, t));
    }
    c
}

fn planner_card(s: &State, d: &SwarmDetail, t: &Tokens) -> El {
    let selected = s.swarms.selected == Some(Selection::Planner);
    let run = d.planner_run.as_ref();
    let active = run.is_some_and(|r| r.status.is_active());
    let running = run.is_some_and(|r| r.status == RunStatus::Running);
    let name = run.and_then(|r| r.agent.as_ref()).map_or("Planner".to_owned(), |a| a.name.clone());
    let detail = run.and_then(|r| r.agent.as_ref()).map_or("Preparing the plan".to_owned(), |a| format!("{} · {}", a.cli, a.model));
    let status = match run {
        Some(r) if r.status == RunStatus::Failed => chip("Stopped", Status::Failed, t),
        Some(r) => chip(words::planner_words(r.status), if active { Status::Running } else if r.status == RunStatus::Succeeded { Status::Succeeded } else { Status::Idle }, t),
        None => chip("Queued", Status::Idle, t),
    };
    let mut card = row()
        .key("planner")
        .w_full()
        .padding(12.0)
        .gap(12.0)
        .center_y()
        .radius(12.0)
        .fill(if selected { t.raised } else { t.panel })
        .border(1.0, if selected { t.dim } else { t.line })
        .role("button")
        .label("Planner agent")
        .focusable(true)
        .on_press(|s: &mut State| super::select(s, Some(Selection::Planner)));
    if running {
        card = card.child(ring(metal::CHROME, 2.0, 1.0, 12.0));
    }
    card = card
        .child(orb(if running { metal::CHROME } else { metal::GUNMETAL }, if running { 1.0 } else { 0.0 }, 28.0))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(label("Planner agent", 11.0, 500.0, t.faint))
                .child(label(name, 13.0, 600.0, t.text).truncate())
                .child(label(detail, 11.5, 400.0, t.faint).truncate()),
        );
    if let Some(r) = run.filter(|r| r.status.is_active()) {
        let since = if r.status == RunStatus::Queued { None } else { r.started_at.as_deref().or(r.queued_at.as_deref()) };
        let text = match since.and_then(words::epoch_ms) {
            Some(at) => words::format_elapsed((words::now_ms() - at) as f64),
            None => "Waiting for a run slot".into(),
        };
        card = card.child(mono(text, 11.5, t.faint));
    }
    card.child(status)
}

fn task_row(s: &State, d: &SwarmDetail, task: &SwarmTask, depth: usize, n: usize, compact: bool, t: &Tokens) -> El {
    let id = task.id.clone();
    let selected = s.swarms.selected.as_ref() == Some(&Selection::Task(task.id.clone()));
    let active = words::agent_active(d, &task.id);
    let attention = task.attention.is_some();
    let words = words::diagram_words(task, active);
    let tone = words::diagram_tone(task, active);
    let mut r = row()
        .key(format!("task-{n}"))
        .w_full()
        .pl(12.0 + depth as f32 * 20.0)
        .pr(10.0)
        .py(if compact { 5.0 } else { 8.0 })
        .gap(10.0)
        .center_y()
        .radius(8.0)
        .fill(if selected { t.raised } else { t.panel })
        .border(1.0, if selected { t.dim } else { t.line })
        .role("button")
        .label(task.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| super::select(s, Some(Selection::Task(id.clone()))));
    if active {
        r = r.child(ring(metal::CHROME, 2.0, 1.0, 8.0));
    } else if attention {
        r = r.child(ring(metal::GOLD, 2.0, 0.0, 8.0));
    }
    let lead = if active { orb(metal::CHROME, 1.0, 12.0) } else { el().size(12.0, 12.0).center().child(dot(tone, t)) };
    let plan = !task.is_leaf();
    if plan {
        let id = task.id.clone();
        let arrow = if folded(task, &s.swarms.toggled) { "▸" } else { "▾" };
        r = r.child(
            el().key("fold")
                .size(16.0, 16.0)
                .center()
                .role("button")
                .label(if arrow == "▸" { "Show tasks" } else { "Hide tasks" })
                .on_press(move |s: &mut State| {
                    let toggled = &mut s.swarms.toggled;
                    match toggled.iter().position(|x| *x == id) {
                        Some(i) => {
                            toggled.remove(i);
                        }
                        None => toggled.push(id.clone()),
                    }
                })
                .child(label(arrow, 14.0, 500.0, t.dim)),
        );
    }
    let mut title_line = row().gap(6.0).center_y();
    if task.parent_relation.as_deref() == Some("depends_on") {
        title_line = title_line.child(label("↳", 12.0, 400.0, t.faint));
    }
    title_line = title_line.child(label(task.title.clone(), 13.0, if plan { 600.0 } else { 500.0 }, t.text).truncate().shrink());
    let mut body = col().grow(1.0).shrink().gap(2.0).child(title_line);
    let sub = if plan {
        let (done, total) = leaf_counts(d, Some(&task.id));
        Some(label(format!("{done} of {total} done"), 11.5, 400.0, t.faint))
    } else if let Some(words) = words::diagram_attention(task, active) {
        Some(label(words.to_owned(), 11.5, 450.0, t.gated))
    } else if active {
        let agent = agent_name(s, task.agent_profile_id.as_deref().or(d.swarm.worker_profile_id.as_deref()), "Swarm Worker");
        let elapsed = words::agent_started_at(d, &task.id).and_then(words::epoch_ms).map(|at| words::format_elapsed((words::now_ms() - at) as f64));
        Some(mono(elapsed.map_or(agent.clone(), |e| format!("{agent} · {e}")), 11.5, t.dim))
    } else {
        None
    };
    if let Some(sub) = sub {
        body = body.child(sub.truncate());
    }
    r.child(lead).child(body).child(chip(&words, tone, t))
}

fn composer(s: &State, d: &SwarmDetail, k: &Kit, t: &Tokens) -> El {
    let send = |s: &mut State, _: &mut Tx| super::send_planner(s);
    let field = TextArea::new(&s.swarms.planner_text)
        .label("Message the planner")
        .placeholder("Give feedback on the plan")
        .width(None)
        .auto_grow(1, 5)
        .on_edit(|s: &mut State| &mut s.swarms.planner_text)
        .on_submit(send)
        .build(k)
        .key("planner-composer");
    let empty = s.swarms.planner_text.text.trim().is_empty();
    let status = words::status_of(&d.swarm);
    let run = d.planner_run.as_ref().map(|r| r.status);
    let helper = if status == SwarmStatus::Paused {
        "Your message waits until the swarm resumes."
    } else if run == Some(RunStatus::Running) {
        "Your message reaches the planner when its current turn ends."
    } else if matches!(run, Some(RunStatus::Queued | RunStatus::Starting)) {
        "Your message waits for this planner run to start."
    } else {
        "Your message starts another planner turn."
    };
    let send_button = Button::new("Send").variant(ButtonVariant::Neutral).disabled(empty || s.swarms.busy).on_press_tx(send).build(k).key("planner-send");
    col()
        .key("planner-compose")
        .w_full()
        .gap(6.0)
        .child(row().w_full().gap(8.0).items_end().child(col().grow(1.0).shrink().child(field)).child(send_button))
        .child(label(helper, 11.5, 400.0, t.faint))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_reads_in_order_and_finished_groups_fold() {
        let d: SwarmDetail = serde_json::from_value(serde_json::json!({
            "swarm": {"id": "s", "projectId": "p", "title": "S", "status": "running"},
            "tasks": [
                {"id": "b", "parentId": null, "position": 1, "title": "B", "nodeType": "plan", "status": "done"},
                {"id": "a", "parentId": null, "position": 0, "title": "A", "nodeType": "plan", "status": "working"},
                {"id": "a2", "parentId": "a", "position": 1, "title": "A2", "nodeType": "leaf", "status": "assigned"},
                {"id": "a1", "parentId": "a", "position": 0, "title": "A1", "nodeType": "leaf", "status": "done"},
                {"id": "b1", "parentId": "b", "position": 0, "title": "B1", "nodeType": "leaf", "status": "done"},
                {"id": "x", "parentId": "gone", "position": 2, "title": "X", "nodeType": "leaf", "status": "assigned"}
            ]
        }))
        .unwrap();
        let ids = |rows: Vec<(usize, usize)>| rows.into_iter().map(|(i, depth)| (d.tasks[i].id.clone(), depth)).collect::<Vec<_>>();
        let all = ids(tree_rows(&d));
        let want = [("a", 0), ("a1", 1), ("a2", 1), ("b", 0), ("b1", 1), ("x", 0)];
        assert_eq!(all, want.map(|(i, n)| (i.to_owned(), n)));
        assert_eq!(ids(visible_rows(&d, &[])).len(), 5);
        assert_eq!(ids(visible_rows(&d, &["b".into(), "a".into()])).len(), 4);
        assert_eq!(leaf_counts(&d, Some("a")), (1, 2));
        assert_eq!(leaf_counts(&d, None), (2, 4));
    }
}
