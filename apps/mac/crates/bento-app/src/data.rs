//! Everything that talks to the server or the sidecar. Work runs on threads and comes back as
//! a `Msg` on the bus; `apply` folds it into state on the UI thread, from `poll`.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use bento_client::{
    AgentEvent, AgentProfile, Board, BoardEvent, BoardUpdate, Client, Conversation, Feature, FeatureDetail, MessageRole, NewFeature, NewProject,
    Project, RunStatus, RunUpdate, StartRun, StreamHandle,
};
use rune::{FileDialogOptions, Tx, Waker};

use crate::model::{self, Entry};
use crate::pages::{self, analytics, artifacts, sessions, settings, swarms};
use crate::sidecar::{self, Sidecar};
use crate::state::{Block, Phase, ProjectRow, Screen, State, Transcript};

pub enum Msg {
    Sidecar(u64, sidecar::Event),
    Projects(Result<Vec<Project>, String>),
    ProjectCreated(Result<Project, String>),
    Board { project: String, result: Result<(Board, Vec<AgentProfile>), String> },
    BoardStream { project: String, update: BoardUpdate },
    Detail { feature: String, result: Result<(FeatureDetail, Conversation), String> },
    RunStream { run: String, update: RunUpdate },
    Created(Result<Feature, String>),
    Acted { feature: String, result: Result<(), String> },
    Sessions(sessions::Msg),
    Artifacts(artifacts::Msg),
    Swarms(swarms::Msg),
    Analytics(analytics::Msg),
    Settings(settings::Msg),
    /// The old server has stopped for a restart.
    Restarted(u64),
}

impl From<sessions::Msg> for Msg {
    fn from(m: sessions::Msg) -> Msg {
        Msg::Sessions(m)
    }
}

impl From<artifacts::Msg> for Msg {
    fn from(m: artifacts::Msg) -> Msg {
        Msg::Artifacts(m)
    }
}

impl From<swarms::Msg> for Msg {
    fn from(m: swarms::Msg) -> Msg {
        Msg::Swarms(m)
    }
}

impl From<analytics::Msg> for Msg {
    fn from(m: analytics::Msg) -> Msg {
        Msg::Analytics(m)
    }
}

impl From<settings::Msg> for Msg {
    fn from(m: settings::Msg) -> Msg {
        Msg::Settings(m)
    }
}

#[derive(Clone)]
pub struct Bus {
    tx: Sender<Msg>,
    waker: Arc<Mutex<Option<Waker>>>,
}

impl Bus {
    pub fn send(&self, m: impl Into<Msg>) {
        let _ = self.tx.send(m.into());
        if let Some(w) = self.waker.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            w();
        }
    }

    fn spawn(&self, work: impl FnOnce() -> Msg + Send + 'static) {
        let bus = self.clone();
        std::thread::spawn(move || bus.send(work()));
    }
}

/// The connection: the bus, the client once the server is up, and the streams and process it
/// owns. Fixture scenes have one too, with no client, so nothing in them reaches a network.
pub struct Conn {
    pub bus: Bus,
    rx: Receiver<Msg>,
    pub client: Option<Client>,
    sidecar: Option<Sidecar>,
    sidecar_gen: u64,
    board_stream: Option<StreamHandle>,
    run_stream: Option<(String, StreamHandle)>,
    page_streams: Vec<(Screen, String, StreamHandle)>,
    board_loading: bool,
    board_dirty: bool,
}

impl Default for Conn {
    fn default() -> Self {
        let (tx, rx) = channel();
        Conn {
            bus: Bus { tx, waker: Arc::new(Mutex::new(None)) },
            rx,
            client: None,
            sidecar: None,
            sidecar_gen: 0,
            board_stream: None,
            run_stream: None,
            page_streams: Vec::new(),
            board_loading: false,
            board_dirty: false,
        }
    }
}

impl Conn {
    pub fn set_waker(&self, waker: Waker) {
        *self.bus.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(waker);
    }

    pub fn streaming_run(&self) -> Option<&str> {
        self.run_stream.as_ref().map(|(id, _)| id.as_str())
    }

    /// Stops the streams and the sidecar. Called as the app quits.
    pub fn shutdown(&mut self) {
        self.board_stream = None;
        self.run_stream = None;
        self.page_streams.clear();
        if let Some(mut s) = self.sidecar.take() {
            s.stop();
        }
    }
}

impl Conn {
    /// Runs `work` with a client on a worker thread and posts what it returns to `apply`.
    /// False, running nothing, while there is no server.
    pub fn spawn<M: Into<Msg> + Send + 'static>(&self, work: impl FnOnce(Client) -> M + Send + 'static) -> bool {
        let Some(c) = self.client.clone() else { return false };
        let bus = self.bus.clone();
        std::thread::spawn(move || bus.send(work(c)));
        true
    }

    pub fn base_url(&self) -> Option<&str> {
        self.client.as_ref().map(Client::base_url)
    }

    /// Keeps a page's stream open until the page leaves, the project changes, or the app quits.
    /// A stream already held under `key` is closed.
    pub fn hold(&mut self, page: Screen, key: impl Into<String>, stream: StreamHandle) {
        let key = key.into();
        self.release(page, Some(&key));
        self.page_streams.push((page, key, stream));
    }

    pub fn holds(&self, page: Screen, key: &str) -> bool {
        self.page_streams.iter().any(|(p, k, _)| *p == page && k == key)
    }

    /// Closes the page's stream under `key`, or all of the page's streams.
    pub fn release(&mut self, page: Screen, key: Option<&str>) {
        self.page_streams.retain(|(p, k, _)| *p != page || key.is_some_and(|key| key != k));
    }
}

pub fn err(e: bento_client::Error) -> String {
    match e {
        bento_client::Error::Api { message, .. } => message,
        other => other.to_string(),
    }
}

pub fn data_dir() -> PathBuf {
    match std::env::var_os("BENTO_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".bento"),
    }
}

fn last_project_file() -> PathBuf {
    data_dir().join("mac-app").join("last-project")
}

fn remember_project(id: &str) {
    let path = last_project_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, id);
}

fn last_project() -> Option<String> {
    std::fs::read_to_string(last_project_file()).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

/// `on_ready` runs on every native window creation; the server starts once.
pub fn start_once(s: &mut State) {
    if s.conn.sidecar_gen == 0 && s.conn.client.is_none() {
        settings::load_appearance(s);
        boot(s);
    }
}

/// Starts the server (or attaches to `BENTO_SERVER_URL`).
pub fn boot(s: &mut State) {
    s.phase = Phase::Booting("Starting Bento.".into());
    if let Ok(url) = std::env::var("BENTO_SERVER_URL")
        && !url.trim().is_empty()
    {
        connected(s, &url);
        return;
    }
    if let Some(mut old) = s.conn.sidecar.take() {
        old.stop();
    }
    let launch = match sidecar::resolve(|k| std::env::var(k).ok(), std::env::current_exe().ok().as_deref(), |p| p.exists()) {
        Ok(l) => l,
        Err(e) => {
            s.phase = Phase::Failed(e);
            return;
        }
    };
    s.conn.sidecar_gen += 1;
    let (bus, generation) = (s.conn.bus.clone(), s.conn.sidecar_gen);
    match Sidecar::start(&launch, &settings::sidecar_env(), move |e| bus.send(Msg::Sidecar(generation, e))) {
        Ok(sc) => s.conn.sidecar = Some(sc),
        Err(e) => s.phase = Phase::Failed(e),
    }
}

/// Stops the server off the UI thread, then boots it again with the options saved since. Every
/// stream closes, and the next projects reply opens the last project afresh.
pub fn restart(s: &mut State, message: &str) {
    s.phase = Phase::Booting(message.to_owned());
    s.conn.client = None;
    s.conn.board_stream = None;
    s.conn.run_stream = None;
    s.conn.page_streams.clear();
    s.project = None;
    s.loaded = false;
    s.lanes.clear();
    s.selected = None;
    s.transcript = Transcript::default();
    // Events from the old process carry the old generation, so its exit is not a failure.
    s.conn.sidecar_gen += 1;
    let (old, bus, generation) = (s.conn.sidecar.take(), s.conn.bus.clone(), s.conn.sidecar_gen);
    std::thread::spawn(move || {
        if let Some(mut old) = old {
            old.stop();
        }
        bus.send(Msg::Restarted(generation));
    });
}

fn connected(s: &mut State, url: &str) {
    match Client::new(url) {
        Ok(c) => {
            s.conn.client = Some(c);
            load_projects(s);
        }
        Err(e) => s.phase = Phase::Failed(err(e)),
    }
}

fn load_projects(s: &mut State) {
    let Some(c) = s.conn.client.clone() else { return };
    s.conn.bus.spawn(move || Msg::Projects(c.list_projects().map_err(err)));
}

pub fn select_project(s: &mut State, id: &str) {
    s.picking_project = false;
    if s.project.as_deref() == Some(id) {
        return;
    }
    s.project = Some(id.to_owned());
    s.lanes.clear();
    s.selected = None;
    s.transcript = Transcript::default();
    s.conn.run_stream = None;
    remember_project(id);
    let Some(c) = s.conn.client.clone() else { return };
    let (bus, project) = (s.conn.bus.clone(), id.to_owned());
    s.conn.board_stream = match c.stream_board(id, move |update| bus.send(Msg::BoardStream { project: project.clone(), update })) {
        Ok(h) => Some(h),
        Err(e) => {
            s.toast(err(e));
            None
        }
    };
    s.conn.board_loading = false;
    refetch_board(s);
    pages::project_changed(s);
}

/// Coalesces: a refetch asked for while one is in flight runs once, after it.
pub fn refetch_board(s: &mut State) {
    let (Some(c), Some(project)) = (s.conn.client.clone(), s.project.clone()) else { return };
    if s.conn.board_loading {
        s.conn.board_dirty = true;
        return;
    }
    s.conn.board_loading = true;
    s.conn.board_dirty = false;
    s.conn.bus.spawn(move || {
        let result = c.board(&project).and_then(|b| Ok((b, c.profiles()?))).map_err(err);
        Msg::Board { project, result }
    });
}

pub fn select_card(s: &mut State, id: &str) {
    s.selected = Some(id.to_owned());
    if s.transcript.feature != id {
        s.transcript = Transcript { feature: id.to_owned(), loading: true, ..Transcript::default() };
        s.conn.run_stream = None;
    }
    load_detail(s);
}

fn load_detail(s: &mut State) {
    let (Some(c), Some(feature)) = (s.conn.client.clone(), s.selected.clone()) else { return };
    s.conn.bus.spawn(move || {
        let result = c.get_feature(&feature).and_then(|d| Ok((d, c.conversation(&feature)?))).map_err(err);
        Msg::Detail { feature, result }
    });
}

fn follow_run(s: &mut State, run_id: &str, agent: String) {
    if s.conn.streaming_run() == Some(run_id) {
        return;
    }
    let Some(c) = s.conn.client.clone() else { return };
    s.transcript.live = Some(Block { agent, status: RunStatus::Running, entries: Vec::new() });
    s.transcript.draft.clear();
    let (bus, run) = (s.conn.bus.clone(), run_id.to_owned());
    match c.stream_run(run_id, 0, move |update| bus.send(Msg::RunStream { run: run.clone(), update })) {
        Ok(h) => s.conn.run_stream = Some((run_id.to_owned(), h)),
        Err(e) => s.toast(err(e)),
    }
}

#[derive(Clone, Debug)]
pub enum Action {
    Advance,
    Back,
    Approve,
    Reject,
    Run { profile: String },
    Stop { run: String },
}

pub fn act(s: &mut State, feature: &str, action: Action) {
    let Some(c) = s.conn.client.clone() else { return };
    s.busy = true;
    let feature = feature.to_owned();
    s.conn.bus.spawn(move || {
        let f = &feature;
        let result = match action {
            Action::Advance => c.advance_feature(f).map(drop),
            Action::Back => c.move_feature_back(f).map(drop),
            Action::Approve => c.approve_feature(f).map(drop),
            Action::Reject => c.reject_feature(f, None).map(drop),
            Action::Run { profile } => {
                c.start_run(&StartRun { feature_id: f.clone(), agent_profile_id: profile, stage_id: None, prompt: None }).map(drop)
            }
            Action::Stop { run } => c.cancel_run(&run).map(drop),
        };
        Msg::Acted { feature, result: result.map_err(err) }
    });
}

pub fn send_message(s: &mut State) {
    let text = s.composer.text.trim().to_owned();
    let (Some(c), Some(feature)) = (s.conn.client.clone(), s.selected.clone()) else { return };
    if text.is_empty() {
        return;
    }
    s.composer.clear();
    s.transcript.sent.push(text.clone());
    s.conn.bus.spawn(move || {
        let result = c.message_feature(&feature, &text).map(drop).map_err(err);
        Msg::Acted { feature, result }
    });
}

pub fn create_card(s: &mut State) {
    let (Some(c), Some(project)) = (s.conn.client.clone(), s.project.clone()) else { return };
    let Some(form) = s.new_card.as_mut() else { return };
    let title = form.title.text.trim().to_owned();
    if title.is_empty() || form.busy {
        return;
    }
    let description = form.description.text.trim().to_owned();
    form.busy = true;
    form.error = None;
    s.conn.bus.spawn(move || {
        let mut input = NewFeature::new(project, title);
        if !description.is_empty() {
            input = input.description(description);
        }
        Msg::Created(c.create_feature(&input).map_err(err))
    });
}

pub fn choose_folder(tx: &mut Tx) {
    let options = FileDialogOptions { title: "Choose a git repository".into(), ..Default::default() };
    tx.open_folder(options, |s: &mut State, result, _| match result {
        Ok(Some(path)) => create_project(s, path),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

pub fn create_project(s: &mut State, path: PathBuf) {
    let Some(c) = s.conn.client.clone() else { return };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    s.creating_project = true;
    s.conn.bus.spawn(move || Msg::ProjectCreated(c.create_project(&NewProject::local(name, path.display().to_string())).map_err(err)));
}

/// Drains the bus. True when anything changed.
pub fn drain(s: &mut State) -> bool {
    let mut changed = false;
    while let Ok(m) = s.conn.rx.try_recv() {
        apply(s, m);
        changed = true;
    }
    changed
}

fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Sidecar(generation, _) if generation != s.conn.sidecar_gen => {}
        Msg::Sidecar(_, e) => match e {
            sidecar::Event::Progress(p) => {
                if matches!(s.phase, Phase::Booting(_)) {
                    s.phase = Phase::Booting(p);
                }
            }
            sidecar::Event::Ready(url) => connected(s, &url),
            sidecar::Event::Error(e) => s.phase = Phase::Failed(e),
            sidecar::Event::Exited(_) => {
                let code = s.conn.sidecar.as_mut().and_then(|c| c.exit_code()).flatten();
                if !matches!(s.phase, Phase::Failed(_)) {
                    s.phase = Phase::Failed(match code {
                        Some(c) => format!("The local server stopped (exit code {c})."),
                        None => "The local server stopped.".into(),
                    });
                }
                s.conn.client = None;
                s.conn.board_stream = None;
                s.conn.run_stream = None;
                s.conn.page_streams.clear();
            }
        },
        Msg::Projects(Err(e)) => s.phase = Phase::Failed(e),
        Msg::Projects(Ok(projects)) => {
            s.projects = projects.iter().map(|p| ProjectRow { id: p.id.clone(), name: p.name.clone() }).collect();
            s.phase = Phase::Ready;
            let pick = last_project().filter(|id| s.projects.iter().any(|p| &p.id == id)).or_else(|| s.projects.first().map(|p| p.id.clone()));
            if let Some(id) = pick {
                select_project(s, &id);
            }
        }
        Msg::ProjectCreated(result) => {
            s.creating_project = false;
            match result {
                Ok(p) => {
                    s.projects.push(ProjectRow { id: p.id.clone(), name: p.name.clone() });
                    select_project(s, &p.id);
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Board { project, .. } if s.project.as_deref() != Some(&project) => {}
        Msg::Board { result, .. } => {
            s.conn.board_loading = false;
            match result {
                Ok((board, profiles)) => {
                    s.lanes = model::lanes(&board, &profiles);
                    s.loaded = true;
                    // A run that started on the open card is followed as soon as the board says so.
                    let selected = s.selected.clone().and_then(|id| s.card(&id).cloned());
                    if let Some(card) = selected {
                        let active = card.run_status.is_some_and(RunStatus::is_active);
                        if active && card.run_id.as_deref() != s.conn.streaming_run() {
                            load_detail(s);
                        }
                    } else if s.selected.is_some() {
                        s.selected = None;
                    }
                }
                Err(e) => s.toast(e),
            }
            if s.conn.board_dirty {
                refetch_board(s);
            }
        }
        Msg::BoardStream { project, .. } if s.project.as_deref() != Some(&project) => {}
        Msg::BoardStream { update, .. } => match update {
            BoardUpdate::Event(BoardEvent::RunOutput { feature_id, text: Some(text), .. }) => {
                if let Some(c) = s.lanes.iter_mut().flat_map(|l| l.cards.iter_mut()).find(|c| c.id == feature_id) {
                    c.note = text;
                }
            }
            BoardUpdate::Event(_) | BoardUpdate::Reconnected => refetch_board(s),
            BoardUpdate::Ended(e) => s.toast(err(e)),
        },
        Msg::Detail { feature, .. } if s.selected.as_deref() != Some(&feature) => {}
        Msg::Detail { result: Err(e), .. } => {
            s.transcript.loading = false;
            s.toast(e);
        }
        Msg::Detail { result: Ok((detail, conversation)), .. } => {
            let t = &mut s.transcript;
            t.loading = false;
            t.blocks = conversation
                .blocks
                .iter()
                .map(|b| {
                    let mut entries = Vec::new();
                    for e in &b.events {
                        model::push_event(&mut entries, e);
                    }
                    Block { agent: b.agent_name.clone(), status: b.status, entries }
                })
                .collect();
            t.pending = conversation.pending.iter().map(|p| p.text.clone()).collect();
            t.sent.clear();
            let newest = detail.runs.first().filter(|r| r.status.is_active());
            match newest {
                Some(run) => {
                    let agent = s.lanes.iter().find(|l| l.agent_profile_id.as_deref() == Some(&run.agent_profile_id)).map(|l| l.agent.clone()).unwrap_or_default();
                    let id = run.id.clone();
                    follow_run(s, &id, agent);
                }
                None => {
                    s.transcript.live = None;
                    s.conn.run_stream = None;
                }
            }
        }
        Msg::RunStream { run, .. } if s.conn.streaming_run() != Some(&run) => {}
        Msg::RunStream { update, .. } => {
            let t = &mut s.transcript;
            match update {
                RunUpdate::Event { event, .. } => {
                    if matches!(&event, AgentEvent::Message { role: MessageRole::Assistant, .. }) {
                        t.draft.clear();
                    }
                    if let Some(live) = t.live.as_mut() {
                        model::push_event(&mut live.entries, &event);
                    }
                }
                RunUpdate::Delta(d) if d.channel == "text" => {
                    let offset = d.offset as usize;
                    if offset <= t.draft.len() && t.draft.is_char_boundary(offset) {
                        t.draft.truncate(offset);
                        t.draft.push_str(&d.text);
                    }
                }
                RunUpdate::Done { .. } => {
                    s.conn.run_stream = None;
                    load_detail(s);
                    refetch_board(s);
                }
                RunUpdate::Ended(e) => {
                    s.conn.run_stream = None;
                    s.toast(err(e));
                }
                _ => {}
            }
        }
        Msg::Created(result) => match result {
            Ok(f) => {
                s.new_card = None;
                // A create emits no board event, so the board is fetched here.
                refetch_board(s);
                select_card(s, &f.id);
            }
            Err(e) => {
                if let Some(form) = s.new_card.as_mut() {
                    form.busy = false;
                    form.error = Some(e);
                }
            }
        },
        Msg::Acted { feature, result } => {
            s.busy = false;
            match result {
                Ok(()) => {
                    refetch_board(s);
                    if s.selected.as_deref() == Some(&feature) {
                        load_detail(s);
                    }
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Restarted(generation) => {
            if generation == s.conn.sidecar_gen {
                boot(s);
            }
        }
        m @ (Msg::Sessions(_) | Msg::Artifacts(_) | Msg::Swarms(_) | Msg::Analytics(_) | Msg::Settings(_)) => pages::apply(s, m),
    }
}

/// The transcript's own entries for a block, used by fixtures.
pub fn entries(events: &[AgentEvent]) -> Vec<Entry> {
    let mut out = Vec::new();
    for e in events {
        model::push_event(&mut out, e);
    }
    out
}
