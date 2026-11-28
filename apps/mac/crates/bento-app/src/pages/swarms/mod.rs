//! The Swarms page: the project's swarms, then one swarm live (its planner, its task tree and
//! its merge queue), with the selected task in the inspector. Everything after the first fetch
//! arrives over the swarm's event stream, the project's board stream (for the list) and the
//! selected run's stream; nothing polls the server.

mod create;
mod drawer;
mod fixtures;
mod view;
mod words;

use bento_client::{AgentEvent, AgentProfile, MessageReceipt, MessageRole, RunStatus, RunUpdate, SwarmDetail, SwarmRow, SwarmUpdate, TaskDetail};
use rune::{Cx, El, Key, KeyEvent, TextEdit, Tx};
use rune_kit::Kit;

use crate::data;
use crate::model::{self, Entry};
use crate::state::{Screen, State};
use crate::theme::Tokens;

pub use fixtures::SCENES;

/// Something that arrives once, may fail, and may be refetched while shown.
#[derive(Default)]
pub enum Load<T> {
    #[default]
    Loading,
    Failed(String),
    Ready(T),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Selection {
    Planner,
    Task(String),
}

/// One run's transcript in the inspector: the selected task's worker, or the planner.
#[derive(Default)]
pub struct Output {
    pub run_id: String,
    pub entries: Vec<Entry>,
    pub draft: String,
    /// None while the run is live; how it ended once the stream says so.
    pub ended: Option<RunStatus>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Confirm {
    StartOver(String),
    MarkDone { task: String, unmerged: bool },
}

#[derive(Default)]
pub struct PageState {
    project: Option<String>,
    list: Load<Vec<SwarmRow>>,
    list_loading: bool,
    list_dirty: bool,
    open: Option<String>,
    detail: Load<SwarmDetail>,
    detail_loading: bool,
    detail_dirty: bool,
    selected: Option<Selection>,
    node: Option<(String, Load<TaskDetail>)>,
    output: Option<Output>,
    profiles: Vec<AgentProfile>,
    planner_text: TextEdit,
    task_text: TextEdit,
    /// What the last message to a task did: "Sent." or "Queued.", or the error.
    task_note: Option<(bool, String)>,
    /// Plan nodes whose fold differs from the default.
    toggled: Vec<String>,
    creating: Option<create::Form>,
    busy: bool,
    confirm: Option<Confirm>,
    /// Seconds on the frame clock the elapsed figures were last drawn at.
    ticked: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum Act {
    Start,
    Pause,
    Stop,
    RetryPlanner,
    StopPlanner,
    StopWorker,
    MarkDone,
    Retry,
    StartOver,
    RetryLanding,
    Cancel,
}

pub enum Msg {
    List { project: String, result: Result<Vec<SwarmRow>, String> },
    /// The project's board stream said a swarm changed.
    ListChanged { project: String },
    Detail { swarm: String, result: Result<Box<SwarmDetail>, String> },
    Stream { swarm: String, update: SwarmUpdate },
    Node { swarm: String, task: String, result: Result<TaskDetail, String> },
    Run { run: String, update: RunUpdate },
    Profiles(Result<Vec<AgentProfile>, String>),
    Acted { swarm: String, act: Act, result: Result<(), String> },
    Messaged { swarm: String, task: Option<String>, result: Result<MessageReceipt, String> },
    /// The new swarm's id.
    Created(Result<String, String>),
}

impl PageState {
    pub fn detail(&self) -> Option<&SwarmDetail> {
        self.detail.ready()
    }
}

fn open_detail(s: &State) -> Option<&SwarmDetail> {
    s.swarms.detail().filter(|d| s.swarms.open.as_deref() == Some(d.swarm.id.as_str()))
}

pub fn enter(s: &mut State) {
    let p = &mut s.swarms;
    if p.project != s.project {
        *p = PageState { project: s.project.clone(), profiles: std::mem::take(&mut p.profiles), ..PageState::default() };
    }
    let Some(project) = s.project.clone() else { return };
    let bus = s.conn.bus.clone();
    if let Some(client) = s.conn.client.clone() {
        let id = project.clone();
        match client.stream_board(&project, move |u| {
            if let bento_client::BoardUpdate::Event(
                bento_client::BoardEvent::SwarmUpdated { .. } | bento_client::BoardEvent::SwarmTaskUpdated { .. },
            )
            | bento_client::BoardUpdate::Reconnected = u
            {
                bus.send(Msg::ListChanged { project: id.clone() });
            }
        }) {
            Ok(h) => s.conn.hold(Screen::Swarms, "list", h),
            Err(e) => s.toast(data::err(e)),
        }
    }
    load_list(s);
    s.conn.spawn(|c| Msg::Profiles(c.profiles().map_err(data::err)));
    if let Some(id) = s.swarms.open.clone() {
        follow_swarm(s, &id);
        load_detail(s);
        restart_output(s);
    }
}

pub fn leave(s: &mut State) {
    s.swarms.confirm = None;
    s.swarms.creating = None;
}

fn load_list(s: &mut State) {
    let Some(project) = s.project.clone() else { return };
    if s.swarms.list_loading {
        s.swarms.list_dirty = true;
        return;
    }
    let p = project.clone();
    if s.conn.spawn(move |c| Msg::List { project: p, result: c.list_swarms(&project).map_err(data::err) }) {
        s.swarms.list_loading = true;
        s.swarms.list_dirty = false;
    }
}

fn load_detail(s: &mut State) {
    let Some(id) = s.swarms.open.clone() else { return };
    if s.swarms.detail_loading {
        s.swarms.detail_dirty = true;
        return;
    }
    let swarm = id.clone();
    if s.conn.spawn(move |c| Msg::Detail { swarm, result: c.get_swarm(&id).map(Box::new).map_err(data::err) }) {
        s.swarms.detail_loading = true;
        s.swarms.detail_dirty = false;
    }
}

fn load_node(s: &mut State) {
    let (Some(swarm), Some(Selection::Task(task))) = (s.swarms.open.clone(), s.swarms.selected.clone()) else { return };
    let (sw, t) = (swarm.clone(), task.clone());
    s.conn.spawn(move |c| Msg::Node { swarm: sw, task: t, result: c.swarm_task(&swarm, &task).map_err(data::err) });
}

fn follow_swarm(s: &mut State, id: &str) {
    let Some(client) = s.conn.client.clone() else { return };
    let (bus, swarm) = (s.conn.bus.clone(), id.to_owned());
    match client.stream_swarm(id, move |update| bus.send(Msg::Stream { swarm: swarm.clone(), update })) {
        Ok(h) => s.conn.hold(Screen::Swarms, "swarm", h),
        Err(e) => s.toast(data::err(e)),
    }
}

pub fn open_swarm(s: &mut State, id: &str) {
    let p = &mut s.swarms;
    if p.open.as_deref() != Some(id) {
        p.open = Some(id.to_owned());
        p.detail = Load::Loading;
        p.detail_loading = false;
        p.selected = None;
        p.node = None;
        p.output = None;
        p.task_note = None;
        s.conn.release(Screen::Swarms, Some("run"));
    }
    follow_swarm(s, id);
    load_detail(s);
}

pub fn close_swarm(s: &mut State) {
    let p = &mut s.swarms;
    p.open = None;
    p.selected = None;
    p.node = None;
    p.output = None;
    p.confirm = None;
    s.conn.release(Screen::Swarms, Some("swarm"));
    s.conn.release(Screen::Swarms, Some("run"));
    load_list(s);
}

pub fn select(s: &mut State, sel: Option<Selection>) {
    if s.swarms.selected == sel {
        return;
    }
    s.swarms.selected = sel.clone();
    s.swarms.task_note = None;
    s.swarms.task_text.clear();
    s.swarms.node = match &sel {
        Some(Selection::Task(id)) => Some((id.clone(), Load::Loading)),
        _ => None,
    };
    load_node(s);
    restart_output(s);
}

/// The run whose transcript the inspector shows for the selection: the agent working the task
/// now, else its last worker attempt; the planner's newest run for the planner.
fn output_run(s: &State) -> Option<String> {
    let d = open_detail(s)?;
    match s.swarms.selected.as_ref()? {
        Selection::Planner => d.planner_run.as_ref().map(|r| r.id.clone()),
        Selection::Task(id) => {
            let active = d.active_runs.iter().find(|r| r.swarm_task_id.as_deref() == Some(id.as_str()));
            let task = d.tasks.iter().find(|t| &t.id == id)?;
            let attempts = s.swarms.node.as_ref().filter(|(t, _)| t == id).and_then(|(_, l)| l.ready()).and_then(|n| n.runs.first());
            active.map(|r| r.id.clone()).or_else(|| task.assigned_run_id.clone()).or_else(|| attempts.map(|r| r.id.clone()))
        }
    }
}

/// Streams the selection's run from its first event, unless that run is already showing.
fn restart_output(s: &mut State) {
    let run = output_run(s);
    if run.as_deref() == s.swarms.output.as_ref().map(|o| o.run_id.as_str()) {
        return;
    }
    s.conn.release(Screen::Swarms, Some("run"));
    s.swarms.output = None;
    let (Some(run), Some(client)) = (run, s.conn.client.clone()) else { return };
    let (bus, id) = (s.conn.bus.clone(), run.clone());
    match client.stream_run(&run, 0, move |update| bus.send(Msg::Run { run: id.clone(), update })) {
        Ok(h) => {
            s.conn.hold(Screen::Swarms, "run", h);
            s.swarms.output = Some(Output { run_id: run, ..Output::default() });
        }
        Err(e) => s.swarms.output = Some(Output { run_id: run, error: Some(data::err(e)), ..Output::default() }),
    }
}

pub fn act(s: &mut State, act: Act, task: Option<String>) {
    let Some(swarm) = s.swarms.open.clone() else { return };
    if s.swarms.busy {
        return;
    }
    let sw = swarm.clone();
    let started = s.conn.spawn(move |c| {
        let t = task.as_deref().unwrap_or_default();
        let result = match act {
            Act::Start => c.start_swarm(&swarm),
            Act::Pause => c.pause_swarm(&swarm),
            Act::Stop => c.cancel_swarm(&swarm),
            Act::RetryPlanner => c.retry_planner(&swarm),
            Act::StopPlanner => c.stop_planner(&swarm),
            Act::StopWorker => c.stop_swarm_task(&swarm, t),
            Act::MarkDone => c.mark_swarm_task_done(&swarm, t),
            Act::Retry => c.retry_swarm_task(&swarm, t, false),
            Act::StartOver => c.retry_swarm_task(&swarm, t, true),
            Act::RetryLanding => c.retry_swarm_landing(&swarm, t),
            Act::Cancel => c.cancel_swarm_task(&swarm, t),
        };
        Msg::Acted { swarm: sw, act, result: result.map_err(data::err) }
    });
    s.swarms.busy = started;
}

pub fn send_planner(s: &mut State) {
    let text = s.swarms.planner_text.text.trim().to_owned();
    let Some(swarm) = s.swarms.open.clone() else { return };
    if text.is_empty() || s.swarms.busy {
        return;
    }
    let sw = swarm.clone();
    if s.conn.spawn(move |c| Msg::Messaged { swarm: sw, task: None, result: c.message_swarm(&swarm, None, &text).map_err(data::err) }) {
        s.swarms.busy = true;
    }
}

pub fn send_task(s: &mut State) {
    let text = s.swarms.task_text.text.trim().to_owned();
    let (Some(swarm), Some(Selection::Task(task))) = (s.swarms.open.clone(), s.swarms.selected.clone()) else { return };
    if text.is_empty() || s.swarms.busy {
        return;
    }
    let (sw, t) = (swarm.clone(), task.clone());
    if s.conn.spawn(move |c| Msg::Messaged { swarm: sw, task: Some(t), result: c.message_swarm(&swarm, Some(&task), &text).map_err(data::err) }) {
        s.swarms.busy = true;
        s.swarms.task_note = None;
    }
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::List { project, .. } if s.project.as_deref() != Some(&project) => {}
        Msg::List { result, .. } => {
            s.swarms.list_loading = false;
            match result {
                Ok(rows) => s.swarms.list = Load::Ready(rows),
                // A refetch that fails keeps the list it had, and says so once.
                Err(e) if s.swarms.list.ready().is_some() => s.toast(e),
                Err(e) => s.swarms.list = Load::Failed(e),
            }
            if s.swarms.list_dirty {
                load_list(s);
            }
        }
        Msg::ListChanged { project } => {
            if s.project.as_deref() == Some(&project) && s.screen == Screen::Swarms {
                load_list(s);
            }
        }
        Msg::Detail { swarm, .. } if s.swarms.open.as_deref() != Some(&swarm) => {}
        Msg::Detail { result, .. } => {
            s.swarms.detail_loading = false;
            match result {
                Ok(d) => {
                    s.swarms.detail = Load::Ready(*d);
                    if let Some(Selection::Task(id)) = &s.swarms.selected
                        && !open_detail(s).is_some_and(|d| d.tasks.iter().any(|t| &t.id == id))
                    {
                        select(s, None);
                    }
                    restart_output(s);
                }
                Err(e) if s.swarms.detail.ready().is_some() => s.toast(e),
                Err(e) => s.swarms.detail = Load::Failed(e),
            }
            if s.swarms.detail_dirty {
                load_detail(s);
            }
        }
        Msg::Stream { swarm, .. } if s.swarms.open.as_deref() != Some(&swarm) => {}
        Msg::Stream { update, .. } => match update {
            SwarmUpdate::Changed(event) => {
                load_detail(s);
                let task = match &event {
                    bento_client::BoardEvent::SwarmTaskUpdated { task_id, .. } => task_id.clone(),
                    _ => None,
                };
                if let Some(Selection::Task(selected)) = &s.swarms.selected
                    && task.as_deref().is_none_or(|t| t == selected)
                {
                    load_node(s);
                }
            }
            SwarmUpdate::Reconnected => {
                load_detail(s);
                load_node(s);
            }
            SwarmUpdate::Ended(e) => s.toast(data::err(e)),
        },
        Msg::Node { swarm, task, .. }
            if s.swarms.open.as_deref() != Some(&swarm) || s.swarms.selected != Some(Selection::Task(task.clone())) => {}
        Msg::Node { task, result, .. } => {
            let keep = matches!(&s.swarms.node, Some((t, Load::Ready(_))) if *t == task);
            match result {
                Ok(n) => s.swarms.node = Some((task, Load::Ready(n))),
                Err(e) if keep => s.toast(e),
                Err(e) => s.swarms.node = Some((task, Load::Failed(e))),
            }
            restart_output(s);
        }
        Msg::Run { run, update } => {
            let Some(out) = s.swarms.output.as_mut().filter(|o| o.run_id == run) else { return };
            match update {
                RunUpdate::Event { event, .. } => {
                    if matches!(&event, AgentEvent::Message { role: MessageRole::Assistant, .. }) {
                        out.draft.clear();
                    }
                    model::push_event(&mut out.entries, &event);
                }
                RunUpdate::Delta(d) if d.channel == "text" => {
                    let offset = d.offset as usize;
                    if offset <= out.draft.len() && out.draft.is_char_boundary(offset) {
                        out.draft.truncate(offset);
                        out.draft.push_str(&d.text);
                    }
                }
                RunUpdate::Done { status } => {
                    out.ended = Some(status);
                    out.draft.clear();
                    s.conn.release(Screen::Swarms, Some("run"));
                }
                RunUpdate::Ended(e) => {
                    out.error = Some(data::err(e));
                    s.conn.release(Screen::Swarms, Some("run"));
                }
                _ => {}
            }
        }
        Msg::Profiles(Ok(p)) => s.swarms.profiles = p,
        Msg::Profiles(Err(_)) => {}
        Msg::Acted { swarm, result, act } => {
            s.swarms.busy = false;
            match result {
                Ok(()) => {
                    if s.swarms.open.as_deref() == Some(&swarm) {
                        load_detail(s);
                        load_node(s);
                    }
                    if matches!(act, Act::StopWorker | Act::StopPlanner | Act::StartOver | Act::Retry) {
                        restart_output(s);
                    }
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Created(result) => create::created(s, result),
        Msg::Messaged { swarm, task, result } => {
            s.swarms.busy = false;
            let here = s.swarms.open.as_deref() == Some(&swarm);
            match (result, task) {
                (Ok(_), None) => {
                    if here {
                        s.swarms.planner_text.clear();
                        load_detail(s);
                    }
                }
                (Ok(receipt), Some(_)) => {
                    if here {
                        s.swarms.task_text.clear();
                        s.swarms.task_note = Some((true, if receipt.live { "Sent." } else { "Queued." }.into()));
                    }
                }
                (Err(e), Some(_)) if here => s.swarms.task_note = Some((false, e)),
                (Err(e), _) => s.toast(e),
            }
        }
    }
}

pub fn view(s: &State, cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    create::dialog(s, t, k, layer);
    view::main(s, cx, t, k, layer)
}

pub fn inspector(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> Option<El> {
    drawer::inspector(s, t, k, layer)
}

pub fn toolbar(s: &State, _cx: &mut Cx<State>, t: &Tokens, _k: &Kit) -> Option<El> {
    if s.project.is_none() || s.swarms.open.is_some() {
        return None;
    }
    let open: Option<fn(&mut State, &mut Tx)> = s.conn.client.as_ref().map(|_| (|s: &mut State, _: &mut Tx| create::open(s)) as fn(&mut State, &mut Tx));
    Some(view::key("New swarm", t, open).key("new-swarm"))
}

/// The tree's rows in order, for moving the selection with the arrow keys.
fn neighbour(s: &State, step: isize) -> Option<Selection> {
    let d = open_detail(s)?;
    let mut order = vec![Selection::Planner];
    order.extend(view::visible_rows(d, &s.swarms.toggled).into_iter().map(|(i, _)| Selection::Task(d.tasks[i].id.clone())));
    let at = s.swarms.selected.as_ref().and_then(|sel| order.iter().position(|o| o == sel));
    let next = match at {
        Some(i) => i.checked_add_signed(step)?,
        None if step > 0 => 0,
        None => order.len().checked_sub(1)?,
    };
    order.get(next).cloned()
}

pub fn on_key(s: &mut State, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    match ev.key {
        Key::Escape if s.swarms.confirm.is_some() => s.swarms.confirm = None,
        Key::Escape if s.swarms.creating.as_ref().is_some_and(|f| !f.busy()) => s.swarms.creating = None,
        Key::Escape if s.swarms.selected.is_some() => select(s, None),
        Key::Escape if s.swarms.open.is_some() => close_swarm(s),
        Key::Down | Key::Up if s.swarms.open.is_some() => {
            let step = if ev.key == Key::Down { 1 } else { -1 };
            match neighbour(s, step) {
                Some(sel) => select(s, Some(sel)),
                None => return false,
            }
        }
        _ => return false,
    }
    true
}

/// Redraws once a second while an agent's elapsed clock is on screen.
pub fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    if s.screen != Screen::Swarms || !open_detail(s).is_some_and(|d| !d.active_runs.is_empty()) {
        return false;
    }
    tx.wake_after(std::time::Duration::from_secs(1));
    if t - s.swarms.ticked >= 1.0 {
        s.swarms.ticked = t;
        return true;
    }
    false
}
