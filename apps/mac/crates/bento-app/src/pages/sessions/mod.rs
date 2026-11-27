//! The Sessions page: every agent conversation in the open project, one opened beside the list
//! at reading width, and a composer that starts an agent with no stage.

mod scenes;
mod view;

use std::hash::{DefaultHasher, Hash, Hasher};

use bento_client::{
    AgentEvent, AgentProfile, Conversation, FeatureChanges, FeatureDetail, FeatureStatus, InterruptResult, MessageResult, MessageRole, NewSession,
    ProjectSession, RunStatus, RunUpdate, StartedSession, TurnState,
};
use rune::{Key, KeyEvent, TextEdit, Tx};
use rune_kit::diff::{self, DiffState};

use crate::data::{self, err};
use crate::model;
use crate::state::{Block, Screen, State, Transcript};

pub use scenes::SCENES;
pub use view::{inspector, toolbar, view};

/// The coding agents a person can pick, as the console lists them (the fake agent left out).
pub const HARNESSES: &[(&str, &str, &str)] = &[
    ("claude-code", "Claude Code", "claude-sonnet-5"),
    ("codex", "Codex CLI", "gpt-5-codex"),
    ("cursor", "Cursor CLI", "claude-sonnet-5"),
    ("opencode", "opencode", "anthropic/claude-sonnet-5"),
    ("pi", "pi", "anthropic/claude-sonnet-5"),
    ("pool", "Poolside (pool)", "poolside/laguna-s-2.1"),
    ("dsh", "DeepSeek Harness", "deepseek-v4-pro"),
    ("antigravity", "Antigravity CLI", "gemini-3.1-pro-high"),
    ("muse", "Muse Code", "muse-spark-1.3"),
    ("fx", "fx", "moonshotai/kimi-k3"),
];

/// Tools whose live session can stop a turn and keep the run open.
const INTERRUPTIBLE: &[&str] = &["claude-code", "codex", "opencode", "pi"];
/// How long Stop rests after an interrupt whose turn end never arrived.
const INTERRUPT_SETTLE: f64 = 15.0;

pub enum List {
    Loading,
    Failed(String),
    Ready(Vec<ProjectSession>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pane {
    Conversation,
    Changes,
}

/// What Stop does, as the console decides it (`stop-action.ts`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopDoes {
    Interrupt,
    End,
    None,
}

/// One conversation, open beside the list.
pub struct Open {
    pub feature: String,
    pub detail: Option<FeatureDetail>,
    pub profiles: Vec<AgentProfile>,
    pub error: Option<String>,
    pub deleted: bool,
    pub transcript: Transcript,
    /// The run whose stream this page holds.
    pub streaming: Option<String>,
    /// Whether the agent is in a turn, as the server holding the run last said.
    pub turn: Option<TurnState>,
    /// The same, read off the transcript until the server says.
    pub turn_from_events: bool,
    /// An interrupt was sent and its turn has not ended; the clock time it was sent.
    pub interrupt_sent: Option<f64>,
    pub tokens: u64,
    pub live_tokens: u64,
    pub composer: TextEdit,
    pub busy: bool,
    /// What the last send or stop said went wrong.
    pub problem: Option<String>,
    pub changes: Option<FeatureChanges>,
    pub pane: Pane,
}

impl Open {
    fn new(feature: &str) -> Open {
        Open {
            feature: feature.to_owned(),
            detail: None,
            profiles: Vec::new(),
            error: None,
            deleted: false,
            transcript: Transcript { feature: feature.to_owned(), loading: true, ..Transcript::default() },
            streaming: None,
            turn: None,
            turn_from_events: true,
            interrupt_sent: None,
            tokens: 0,
            live_tokens: 0,
            composer: TextEdit::new(""),
            busy: false,
            problem: None,
            changes: None,
            pane: Pane::Conversation,
        }
    }

    pub fn latest_run(&self) -> Option<&bento_client::AgentRun> {
        self.detail.as_ref().and_then(|d| d.runs.first())
    }

    pub fn run_active(&self) -> bool {
        self.latest_run().is_some_and(|r| r.status.is_active())
    }

    pub fn agent(&self, profile_id: &str) -> Option<&AgentProfile> {
        self.profiles.iter().find(|p| p.id == profile_id)
    }

    pub fn latest_agent(&self) -> Option<&AgentProfile> {
        self.latest_run().and_then(|r| self.agent(&r.agent_profile_id))
    }

    /// How the latest agent's tool treats a mid-task message: "steer", "queue", or between runs.
    pub fn live_kind(&self) -> Option<&'static str> {
        let cli = self.latest_agent()?.cli.as_str();
        let live = |cli: &str| match cli {
            "pi" | "codex" => Some("steer"),
            "claude-code" | "opencode" => Some("queue"),
            _ => None,
        };
        match self.latest_run().and_then(|r| r.live_session) {
            Some(false) => None,
            Some(true) => live(cli),
            None if matches!(cli, "codex" | "opencode") => None,
            None => live(cli),
        }
    }

    pub fn stop_does(&self) -> StopDoes {
        if self.interrupt_sent.is_some() {
            return StopDoes::None;
        }
        let Some(run) = self.latest_run().filter(|r| r.status.is_active()) else { return StopDoes::None };
        let stage = run.role.as_deref().is_none_or(|r| r == "stage");
        let tool = self.latest_agent().is_some_and(|a| INTERRUPTIBLE.contains(&a.cli.as_str()));
        if !(run.live_session == Some(true) && stage && tool) {
            return StopDoes::End;
        }
        let working = match self.turn {
            Some(t) => t == TurnState::Working,
            None => self.turn_from_events,
        };
        if working { StopDoes::Interrupt } else { StopDoes::None }
    }

    pub fn has_diff(&self) -> bool {
        self.changes.as_ref().is_some_and(|c| c.repositories.iter().any(|r| !r.diff.trim().is_empty()))
    }
}

pub struct Compose {
    pub prompt: TextEdit,
    pub cli: &'static str,
    pub model: TextEdit,
    pub harness_open: bool,
    pub busy: bool,
    pub error: Option<String>,
}

impl Compose {
    /// Starts on the harness and model the newest session ran on, as the console does.
    fn new(recent: Option<(&str, &str)>) -> Compose {
        let cli = recent.and_then(|(cli, _)| HARNESSES.iter().find(|h| h.0 == cli)).map_or(HARNESSES[0].0, |h| h.0);
        let mut prompt = TextEdit::new("");
        prompt.focused = true;
        Compose { prompt, cli, model: TextEdit::new(starting_model(cli, recent)), harness_open: false, busy: false, error: None }
    }

    pub fn label(&self) -> &'static str {
        HARNESSES.iter().find(|h| h.0 == self.cli).map_or(self.cli, |h| h.1)
    }

    pub fn ready(&self) -> bool {
        !self.busy && !self.prompt.text.trim().is_empty() && !self.model.text.trim().is_empty()
    }
}

fn starting_model(cli: &str, recent: Option<(&str, &str)>) -> String {
    match recent {
        Some((c, model)) if c == cli => model.to_owned(),
        _ => HARNESSES.iter().find(|h| h.0 == cli).map_or("", |h| h.2).to_owned(),
    }
}

pub struct PageState {
    pub project: Option<String>,
    pub list: List,
    list_loading: bool,
    list_dirty: bool,
    /// What the board last said about every card's run, so a change refreshes the list.
    board_seen: u64,
    pub open: Option<Open>,
    pub compose: Option<Compose>,
    pub diff: DiffState,
}

impl Default for PageState {
    fn default() -> Self {
        PageState {
            project: None,
            list: List::Loading,
            list_loading: false,
            list_dirty: false,
            board_seen: 0,
            open: None,
            compose: None,
            diff: DiffState::default(),
        }
    }
}

impl PageState {
    /// No conversations yet: the composer is the whole screen.
    pub fn alone(&self) -> bool {
        matches!(&self.list, List::Ready(rows) if rows.is_empty()) && self.open.is_none()
    }

    pub fn sessions(&self) -> &[ProjectSession] {
        match &self.list {
            List::Ready(v) => v,
            _ => &[],
        }
    }
}

pub enum Msg {
    Listed { project: String, result: Result<Vec<ProjectSession>, String> },
    Detail { feature: String, result: Result<(FeatureDetail, Conversation, Vec<AgentProfile>), bento_client::Error> },
    Changes { feature: String, result: Result<FeatureChanges, String> },
    Run { run: String, update: RunUpdate },
    Sent { feature: String, text: String, result: Result<MessageResult, String> },
    Stopped { feature: String, result: Result<Option<InterruptResult>, String> },
    Started(Result<StartedSession, String>),
}

pub fn enter(s: &mut State) {
    let p = &mut s.sessions;
    if p.project != s.project {
        *p = PageState { project: s.project.clone(), ..PageState::default() };
    }
    s.sessions.board_seen = board_signature(s);
    refresh_list(s);
    if let Some(feature) = s.sessions.open.as_ref().map(|o| o.feature.clone()) {
        if let Some(o) = s.sessions.open.as_mut() {
            o.streaming = None;
        }
        load_detail(s, &feature);
    }
}

pub fn leave(s: &mut State) {
    if let Some(o) = s.sessions.open.as_mut() {
        o.streaming = None;
    }
}

/// Coalesces: a refresh asked for while one is in flight runs once, after it.
fn refresh_list(s: &mut State) {
    let Some(project) = s.project.clone() else { return };
    let p = &mut s.sessions;
    if p.list_loading {
        p.list_dirty = true;
        return;
    }
    p.list_loading = true;
    p.list_dirty = false;
    let spawned = s.conn.spawn(move |c| Msg::Listed { result: c.list_sessions(&project).map_err(err), project });
    if !spawned {
        s.sessions.list_loading = false;
    }
}

fn load_detail(s: &mut State, feature: &str) {
    let feature = feature.to_owned();
    s.conn.spawn(move |c| {
        let result = c.get_feature(&feature).and_then(|d| Ok((d, c.conversation(&feature)?, c.profiles()?)));
        Msg::Detail { feature, result }
    });
}

fn load_changes(s: &mut State, feature: &str) {
    let feature = feature.to_owned();
    s.conn.spawn(move |c| Msg::Changes { result: c.feature_changes(&feature).map_err(err), feature });
}

pub fn open_session(s: &mut State, feature: &str) {
    s.sessions.compose = None;
    if s.sessions.open.as_ref().is_some_and(|o| o.feature == feature) {
        return;
    }
    s.conn.release(Screen::Sessions, Some("run"));
    s.sessions.open = Some(Open::new(feature));
    s.sessions.diff = DiffState::default();
    load_detail(s, feature);
    load_changes(s, feature);
}

pub fn close(s: &mut State) {
    s.conn.release(Screen::Sessions, Some("run"));
    s.sessions.open = None;
    s.sessions.compose = None;
}

pub fn compose(s: &mut State) {
    let recent = s.sessions.sessions().first().and_then(|x| Some((x.latest_run.agent_cli.clone()?, x.latest_run.agent_model.clone()?)));
    s.conn.release(Screen::Sessions, Some("run"));
    s.sessions.open = None;
    s.sessions.compose = Some(Compose::new(recent.as_ref().map(|(c, m)| (c.as_str(), m.as_str()))));
}

pub fn pick_harness(s: &mut State, label: &str) {
    let Some(c) = s.sessions.compose.as_mut() else { return };
    c.harness_open = false;
    if let Some(h) = HARNESSES.iter().find(|h| h.1 == label) {
        c.cli = h.0;
        let recent = s.sessions.sessions().first().map(|x| (x.latest_run.agent_cli.clone(), x.latest_run.agent_model.clone()));
        let recent = recent.as_ref().and_then(|(c, m)| Some((c.as_deref()?, m.as_deref()?)));
        let model = starting_model(h.0, recent);
        if let Some(c) = s.sessions.compose.as_mut() {
            c.model = TextEdit::new(model);
        }
    }
}

pub fn start(s: &mut State) {
    let Some(project) = s.project.clone() else { return };
    let Some(c) = s.sessions.compose.as_mut() else { return };
    if !c.ready() {
        return;
    }
    let input = NewSession { cli: c.cli.to_owned(), model: c.model.text.trim().to_owned(), prompt: c.prompt.text.trim().to_owned(), title: None };
    c.busy = true;
    c.error = None;
    if !s.conn.spawn(move |client| Msg::Started(client.start_session(&project, &input).map_err(err)))
        && let Some(c) = s.sessions.compose.as_mut()
    {
        c.busy = false;
    }
}

pub fn send(s: &mut State) {
    let Some(o) = s.sessions.open.as_mut() else { return };
    let text = o.composer.text.trim().to_owned();
    if text.is_empty() || o.busy {
        return;
    }
    o.busy = true;
    o.problem = None;
    let feature = o.feature.clone();
    if !s.conn.spawn(move |c| Msg::Sent { result: c.message_feature(&feature, &text).map_err(err), feature, text })
        && let Some(o) = s.sessions.open.as_mut()
    {
        o.busy = false;
    }
}

pub fn stop(s: &mut State, now: f64) {
    let Some(o) = s.sessions.open.as_mut() else { return };
    let Some(run) = o.latest_run().filter(|r| r.status.is_active()).map(|r| r.id.clone()) else { return };
    let does = o.stop_does();
    if does == StopDoes::None || o.busy {
        return;
    }
    o.busy = true;
    o.problem = None;
    if does == StopDoes::Interrupt {
        o.interrupt_sent = Some(now);
    }
    let feature = o.feature.clone();
    s.conn.spawn(move |c| {
        let result = match does {
            StopDoes::Interrupt => c.interrupt_run(&run).map(Some),
            _ => c.cancel_run(&run).map(|_| None),
        };
        Msg::Stopped { feature, result: result.map_err(err) }
    });
}

fn follow(s: &mut State, run: &str, agent: String) {
    let Some(o) = s.sessions.open.as_mut() else { return };
    if o.streaming.as_deref() == Some(run) && s.conn.holds(Screen::Sessions, "run") {
        return;
    }
    let Some(client) = s.conn.client.clone() else { return };
    o.transcript.live = Some(Block { agent, status: RunStatus::Running, entries: Vec::new() });
    o.transcript.draft.clear();
    o.turn = None;
    o.turn_from_events = true;
    o.live_tokens = 0;
    o.streaming = Some(run.to_owned());
    let (bus, id) = (s.conn.bus.clone(), run.to_owned());
    match client.stream_run(run, 0, move |update| bus.send(Msg::Run { run: id.clone(), update })) {
        Ok(h) => s.conn.hold(Screen::Sessions, "run", h),
        Err(e) => {
            if let Some(o) = s.sessions.open.as_mut() {
                o.streaming = None;
            }
            s.toast(err(e));
        }
    }
}

fn tokens_of(e: &AgentEvent) -> u64 {
    match e {
        AgentEvent::Result { input_tokens, output_tokens, .. } => input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0),
        _ => 0,
    }
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Listed { project, .. } if s.project.as_deref() != Some(&project) => s.sessions.list_loading = false,
        Msg::Listed { result, .. } => {
            let p = &mut s.sessions;
            p.list_loading = false;
            match result {
                Ok(rows) => {
                    p.list = List::Ready(rows);
                    if p.alone() && p.compose.is_none() {
                        p.compose = Some(Compose::new(None));
                    }
                }
                // A stale list beats an empty one; only a first load becomes an error.
                Err(e) => match p.list {
                    List::Ready(_) => s.toast(e),
                    _ => p.list = List::Failed(e),
                },
            }
            if s.sessions.list_dirty {
                refresh_list(s);
            }
        }
        Msg::Detail { feature, .. } if s.sessions.open.as_ref().is_none_or(|o| o.feature != feature) => {}
        Msg::Detail { result: Err(e), .. } => {
            let Some(o) = s.sessions.open.as_mut() else { return };
            o.transcript.loading = false;
            if e.is_not_found() {
                o.deleted = true;
            } else if o.detail.is_none() {
                o.error = Some(err(e));
            } else {
                s.toast(err(e));
            }
        }
        Msg::Detail { result: Ok((detail, conversation, profiles)), .. } => {
            let Some(o) = s.sessions.open.as_mut() else { return };
            o.error = None;
            let t = &mut o.transcript;
            t.loading = false;
            t.blocks = conversation
                .blocks
                .iter()
                .map(|b| Block { agent: b.agent_name.clone(), status: b.status, entries: data::entries(&b.events) })
                .collect();
            o.tokens = conversation.blocks.iter().flat_map(|b| &b.events).map(tokens_of).sum();
            t.pending = conversation.pending.iter().map(|p| p.text.clone()).collect();
            t.sent.clear();
            o.profiles = profiles;
            let newest = detail.runs.first().filter(|r| r.status.is_active()).map(|r| (r.id.clone(), r.agent_profile_id.clone()));
            o.detail = Some(detail);
            match newest {
                Some((run, profile)) => {
                    let agent = o.agent(&profile).map(|a| a.name.clone()).unwrap_or_default();
                    follow(s, &run, agent);
                }
                None => {
                    o.transcript.live = None;
                    o.streaming = None;
                    o.interrupt_sent = None;
                    s.conn.release(Screen::Sessions, Some("run"));
                }
            }
        }
        Msg::Changes { feature, .. } if s.sessions.open.as_ref().is_none_or(|o| o.feature != feature) => {}
        Msg::Changes { result, .. } => {
            let p = &mut s.sessions;
            let Some(o) = p.open.as_mut() else { return };
            match result {
                Ok(changes) => {
                    let files = changes.repositories.iter().flat_map(|r| diff::parse(&r.diff)).collect::<Vec<_>>();
                    if p.diff.files().is_empty() {
                        p.diff = DiffState::new(files);
                    } else {
                        p.diff.set_files(files);
                    }
                    o.changes = Some(changes);
                    if !o.has_diff() {
                        o.pane = Pane::Conversation;
                    }
                }
                // Absent changes degrade the inspector, not the conversation.
                Err(_) => o.changes = None,
            }
        }
        Msg::Run { run, .. } if s.sessions.open.as_ref().is_none_or(|o| o.streaming.as_deref() != Some(&run)) => {}
        Msg::Run { update, .. } => {
            let Some(o) = s.sessions.open.as_mut() else { return };
            match update {
                RunUpdate::Event { event, .. } => {
                    match &event {
                        AgentEvent::Message { role: MessageRole::Assistant, .. } => o.transcript.draft.clear(),
                        AgentEvent::Message { role: MessageRole::User, .. } => o.turn_from_events = true,
                        AgentEvent::Result { .. } => {
                            o.turn_from_events = false;
                            o.interrupt_sent = None;
                        }
                        _ => {}
                    }
                    o.live_tokens += tokens_of(&event);
                    if let Some(live) = o.transcript.live.as_mut() {
                        model::push_event(&mut live.entries, &event);
                    }
                }
                RunUpdate::Delta(d) if d.channel == "text" => {
                    let draft = &mut o.transcript.draft;
                    let offset = d.offset as usize;
                    if offset <= draft.len() && draft.is_char_boundary(offset) {
                        draft.truncate(offset);
                        draft.push_str(&d.text);
                    }
                }
                RunUpdate::Turn(turn) => {
                    o.turn = Some(turn);
                    if turn == TurnState::Waiting {
                        o.interrupt_sent = None;
                    }
                }
                RunUpdate::Done { .. } => {
                    o.streaming = None;
                    let feature = o.feature.clone();
                    s.conn.release(Screen::Sessions, Some("run"));
                    load_detail(s, &feature);
                    load_changes(s, &feature);
                    refresh_list(s);
                }
                RunUpdate::Ended(e) => {
                    o.streaming = None;
                    s.toast(err(e));
                }
                _ => {}
            }
        }
        Msg::Sent { feature, .. } if s.sessions.open.as_ref().is_none_or(|o| o.feature != feature) => {}
        Msg::Sent { feature, text, result } => {
            let Some(o) = s.sessions.open.as_mut() else { return };
            o.busy = false;
            match result {
                Ok(sent) => {
                    if o.composer.text.trim() == text {
                        o.composer.clear();
                    }
                    // A live delivery echoes back through the stream; anything else shows now.
                    if sent.live != Some(true) {
                        o.transcript.sent.push(text);
                    }
                    load_detail(s, &feature);
                    refresh_list(s);
                }
                Err(e) => o.problem = Some(e),
            }
        }
        Msg::Stopped { feature, .. } if s.sessions.open.as_ref().is_none_or(|o| o.feature != feature) => {}
        Msg::Stopped { feature, result } => {
            let Some(o) = s.sessions.open.as_mut() else { return };
            o.busy = false;
            match result {
                Ok(Some(r)) if !r.interrupted => o.interrupt_sent = None,
                Ok(Some(_)) => {}
                Ok(None) => {
                    load_detail(s, &feature);
                    refresh_list(s);
                }
                Err(e) => {
                    o.interrupt_sent = None;
                    o.problem = Some(e);
                }
            }
        }
        Msg::Started(result) => {
            let Some(c) = s.sessions.compose.as_mut() else { return };
            match result {
                Ok(started) => {
                    s.sessions.compose = None;
                    refresh_list(s);
                    open_session(s, &started.feature_id);
                }
                Err(e) => {
                    c.busy = false;
                    c.error = Some(e);
                }
            }
        }
    }
}

/// Every card's newest run, as the board last fetched it. The board stream refetches on every
/// run change, so this moving is the signal to refresh the list without a second stream.
fn board_signature(s: &State) -> u64 {
    let mut h = DefaultHasher::new();
    for c in s.lanes.iter().flat_map(|l| &l.cards) {
        (&c.id, &c.title, &c.run_id, c.run_status.map(|r| r as u8)).hash(&mut h);
    }
    h.finish()
}

pub fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    if s.screen != Screen::Sessions {
        return false;
    }
    let mut changed = false;
    if let Some(o) = s.sessions.open.as_mut()
        && let Some(sent) = o.interrupt_sent
    {
        if t - sent >= INTERRUPT_SETTLE {
            o.interrupt_sent = None;
            changed = true;
        } else {
            tx.wake_after(std::time::Duration::from_secs_f64(INTERRUPT_SETTLE - (t - sent)));
        }
    }
    let seen = board_signature(s);
    if seen != s.sessions.board_seen {
        s.sessions.board_seen = seen;
        refresh_list(s);
        // The open card's run moved on the board: a new run, or one this page is not following.
        if let Some(o) = s.sessions.open.as_ref()
            && let Some(card) = s.card(&o.feature)
        {
            let following = o.streaming.is_some() && card.run_id == o.streaming;
            let known = card.run_id.as_deref() == o.latest_run().map(|r| r.id.as_str()) && card.run_status == o.latest_run().map(|r| r.status);
            if !following && !known {
                let feature = o.feature.clone();
                load_detail(s, &feature);
                load_changes(s, &feature);
            }
        }
        changed = true;
    }
    changed
}

pub fn on_key(s: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if ev.key == Key::Escape {
        if let Some(c) = &s.sessions.compose {
            if c.harness_open || c.busy || !c.prompt.text.trim().is_empty() || s.sessions.alone() {
                return false;
            }
            s.sessions.compose = None;
            return true;
        }
        if s.sessions.open.is_some() {
            close(s);
            return true;
        }
        return false;
    }
    if s.sessions.open.as_ref().is_some_and(|o| o.pane == Pane::Changes) {
        return s.sessions.diff.key(ev, tx);
    }
    false
}

/// "Code Reviewer" wears CR, the way a chat list draws its contacts.
pub fn initials(name: &str) -> String {
    let s: String = name.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect::<String>().to_uppercase();
    if s.is_empty() { "A".into() } else { s }
}

/// A run's status as a phrase, as the console says it.
pub fn run_words(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Queued => "waiting to start",
        RunStatus::Starting => "starting",
        RunStatus::Running => "working",
        RunStatus::Succeeded => "finished",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "stopped",
        RunStatus::Unknown => "",
    }
}

pub fn feature_word(status: FeatureStatus) -> &'static str {
    match status {
        FeatureStatus::Done => "completed",
        FeatureStatus::Gated => "pending approval",
        FeatureStatus::Backlog => "backlog",
        FeatureStatus::Active => "active",
        FeatureStatus::Cancelled => "cancelled",
        FeatureStatus::Unknown => "",
    }
}

/// Seconds since the epoch for an ISO 8601 UTC stamp such as `2026-11-27T10:00:00.000Z`.
pub fn unix_of(iso: &str) -> Option<i64> {
    let (date, time) = iso.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = time.trim_end_matches('Z').split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec = t.next().and_then(|s| s.split('.').next()?.parse::<i64>().ok()).unwrap_or(0);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + min * 60 + sec)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// "now", "4m", "2h", "yesterday", "3d", then the date.
pub fn ago(iso: &str, now: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let Some(at) = unix_of(iso) else { return String::new() };
    let d = (now - at).max(0);
    match d {
        0..60 => "now".into(),
        60..3600 => format!("{}m", d / 60),
        3600..86_400 => format!("{}h", d / 3600),
        86_400..172_800 => "yesterday".into(),
        172_800..604_800 => format!("{}d", d / 86_400),
        _ => {
            let (_, rest) = iso.split_once('-').unwrap_or_default();
            let mut p = rest.split(['-', 'T']);
            let m = p.next().and_then(|m| m.parse::<usize>().ok()).unwrap_or(1).clamp(1, 12);
            let day = p.next().and_then(|d| d.parse::<u32>().ok()).unwrap_or(1);
            format!("{} {day}", MONTHS[m - 1])
        }
    }
}

/// 64.6K, 1.2M.
pub fn token_count(n: u64) -> String {
    match n {
        0..1000 => n.to_string(),
        1000..1_000_000 => format!("{:.1}K", n as f64 / 1000.0),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(status: &str, live: Option<bool>, role: Option<&str>) -> bento_client::AgentRun {
        serde_json::from_value(json!({"id": "r", "featureId": "f", "agentProfileId": "a", "status": status, "liveSession": live, "role": role})).unwrap()
    }

    fn open(cli: &str, r: bento_client::AgentRun) -> Open {
        let mut o = Open::new("f");
        o.profiles = serde_json::from_value(json!([{"id": "a", "name": "Agent", "cli": cli, "model": "m"}])).unwrap();
        let mut d: FeatureDetail = serde_json::from_value(json!({"id": "f", "projectId": "p", "title": "t", "status": "active"})).unwrap();
        d.runs = vec![r];
        o.detail = Some(d);
        o
    }

    #[test]
    fn stop_interrupts_a_working_live_agent_rests_while_it_waits_and_ends_the_rest() {
        let mut o = open("claude-code", run("running", Some(true), Some("stage")));
        assert_eq!(o.stop_does(), StopDoes::Interrupt);
        o.turn_from_events = false;
        assert_eq!(o.stop_does(), StopDoes::None);
        o.turn = Some(TurnState::Working);
        assert_eq!(o.stop_does(), StopDoes::Interrupt);
        o.interrupt_sent = Some(1.0);
        assert_eq!(o.stop_does(), StopDoes::None);
        assert_eq!(open("fake", run("running", Some(true), None)).stop_does(), StopDoes::End);
        assert_eq!(open("claude-code", run("running", Some(false), None)).stop_does(), StopDoes::End);
        assert_eq!(open("claude-code", run("running", Some(true), Some("judge"))).stop_does(), StopDoes::End);
        assert_eq!(open("claude-code", run("succeeded", Some(true), None)).stop_does(), StopDoes::None);
    }

    #[test]
    fn live_kind_follows_the_runs_record() {
        assert_eq!(open("codex", run("running", None, None)).live_kind(), None);
        assert_eq!(open("codex", run("running", Some(true), None)).live_kind(), Some("steer"));
        assert_eq!(open("claude-code", run("running", None, None)).live_kind(), Some("queue"));
        assert_eq!(open("claude-code", run("running", Some(false), None)).live_kind(), None);
        assert_eq!(open("fake", run("running", Some(true), None)).live_kind(), None);
    }

    #[test]
    fn times_read_as_a_chat_list_does() {
        let at = unix_of("2026-11-27T10:00:00.000Z").unwrap();
        assert_eq!(at, 1_795_773_600);
        assert_eq!(ago("2026-11-27T10:00:00.000Z", at + 30), "now");
        assert_eq!(ago("2026-11-27T10:00:00.000Z", at + 240), "4m");
        assert_eq!(ago("2026-11-27T10:00:00.000Z", at + 7200), "2h");
        assert_eq!(ago("2026-11-27T10:00:00.000Z", at + 90_000), "yesterday");
        assert_eq!(ago("2026-11-27T10:00:00.000Z", at + 3 * 86_400), "3d");
        assert_eq!(ago("2026-07-29T23:42:00Z", at), "Jul 29");
        assert_eq!(token_count(64_612), "64.6K");
        assert_eq!(token_count(512), "512");
        assert_eq!(initials("Software Engineer"), "SE");
        assert_eq!(initials(""), "A");
    }

    #[test]
    fn the_composer_starts_where_the_newest_session_did() {
        let c = Compose::new(Some(("codex", "gpt-5.5")));
        assert_eq!((c.cli, c.model.text.as_str()), ("codex", "gpt-5.5"));
        let c = Compose::new(Some(("fake", "fake-1")));
        assert_eq!((c.cli, c.model.text.as_str()), ("claude-code", "claude-sonnet-5"));
        assert!(!c.ready());
    }
}
