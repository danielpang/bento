//! What a person does with a card, beside its conversation: the actions bar, pull requests, the
//! agent's questions, Stop, and the dialogs behind Reject, Delete, Undo and Move.

mod actions;
mod pulls;
mod scenes;
pub mod questions;
pub mod stop;

use std::hash::{DefaultHasher, Hash, Hasher};

use bento_client::{
    AgentEvent, AgentProfile, CardDetail, CardRunRow, InterruptResult, Pipeline, ProjectRepository, PullRequestState, Published, RunQuestion, RunUpdate,
    Stage, StartedSession,
};
use rune::{El, TextEdit, Tx};
use rune_kit::Kit;

use crate::data::{self, err};
use crate::model::{Card, Status};
use crate::state::{Screen, State};
use crate::theme::Tokens;

pub use actions::{actions, dialogs};
pub use scenes::SCENES;
pub use questions::Questions;
use questions::Place;
use stop::{RunFacts, StopDoes, Turn};

const STREAM: &str = "card-run";
/// The line a run's transcript (and so the board card) carries when the agent asks.
const ASKING: &str = "The agent is asking";

pub enum Dialog {
    Reject(Box<TextEdit>),
    Delete,
    Rollback,
    Move,
}

/// The New card dialog's choice of starting an agent at once, kept between cards.
pub struct StartNow {
    pub on: bool,
    pub cli: &'static str,
    pub model: TextEdit,
    pub harness_open: bool,
}

impl Default for StartNow {
    fn default() -> Self {
        let cli = crate::pages::sessions::HARNESSES[0].0;
        StartNow { on: false, cli, model: TextEdit::new(crate::pages::sessions::starting_model(cli, None)), harness_open: false }
    }
}

#[derive(Default)]
pub struct CardState {
    /// The card everything below is about.
    pub feature: Option<String>,
    pub detail: Option<CardDetail>,
    pub stages: Vec<Stage>,
    pub profiles: Vec<AgentProfile>,
    /// None until read, or when the read failed.
    pub can_publish: Option<bool>,
    /// None until read, or when the read failed: an empty list and a missing one differ.
    pub repos: Option<Vec<ProjectRepository>>,
    pub load_failed: bool,
    pub merge: Vec<PullRequestState>,
    pub checks: Vec<PullRequestState>,
    pub ended: Vec<PullRequestState>,
    pub questions: Questions,
    pub turn: Turn,
    /// The run whose stream this holds, for its turns and questions.
    pub streaming: Option<String>,
    pub stopping: bool,
    pub publishing: bool,
    /// What the last publish said, when it did not simply work; true for a failure.
    pub notes: Vec<(String, bool)>,
    pub dialog: Option<Dialog>,
    pub more: bool,
    /// Cards known to have a question waiting on a person.
    pub asking: Vec<String>,
    pub start_now: StartNow,
    /// Takes an edit aimed at a field that has gone.
    pub scratch: TextEdit,
    seen: u64,
}

impl CardState {
    pub fn latest_run(&self) -> Option<&CardRunRow> {
        self.detail.as_ref().and_then(|d| d.runs.first())
    }

    pub fn run_active(&self) -> bool {
        self.latest_run().is_some_and(|r| r.status.is_active())
    }

    pub fn profile(&self, id: &str) -> Option<&AgentProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn stage(&self) -> Option<&Stage> {
        let id = self.detail.as_ref()?.feature.current_stage_id.as_deref()?;
        self.stages.iter().find(|s| s.id == id)
    }

    pub fn stop_does(&self) -> StopDoes {
        let run = self.latest_run().map(|r| RunFacts {
            active: r.status.is_active(),
            live_session: r.live_session,
            role: r.role.as_deref(),
            cli: self.profile(&r.agent_profile_id).map(|p| p.cli.as_str()),
        });
        stop::stop_does(run, &self.turn)
    }

    /// The list was read and the project has no checkout.
    pub fn no_repositories(&self) -> bool {
        self.repos.as_ref().is_some_and(Vec::is_empty) && !self.load_failed
    }

    /// Whether a card is waiting on a person's answer: its question is known here, or its
    /// running agent's latest line says it asked.
    pub fn asks(&self, c: &Card) -> bool {
        c.status == Status::Running && (self.asking.contains(&c.id) || c.note.starts_with(ASKING))
    }
}

pub enum Msg {
    Loaded { feature: String, result: Result<Box<Loaded>, String> },
    Pulls { feature: String, merge: Option<Vec<PullRequestState>>, checks: Option<Vec<PullRequestState>>, ended: Option<Vec<PullRequestState>> },
    Run { run: String, update: RunUpdate },
    Questions { place: Place, run: String, result: Result<Vec<RunQuestion>, String> },
    Answered { place: Place, id: String, result: Result<(), String> },
    Stopped { feature: String, result: Result<InterruptResult, String> },
    Published { feature: String, result: Result<Published, String> },
    /// Fix conflicts or Fix CI Tests started; the toast says what happens next.
    Started { feature: String, note: &'static str, result: Result<(), String> },
    Deleted { feature: String, title: String, result: Result<(), bento_client::Error> },
    SessionStarted(Result<StartedSession, String>),
}

pub struct Loaded {
    detail: CardDetail,
    pipeline: Option<Pipeline>,
    profiles: Vec<AgentProfile>,
    can_publish: Option<bool>,
    repos: Option<Vec<ProjectRepository>>,
}

impl From<Msg> for data::Msg {
    fn from(m: Msg) -> data::Msg {
        data::Msg::Card(m)
    }
}

/// The drawer opened on a card, or opened again.
pub fn select(s: &mut State) {
    let Some(id) = s.selected.clone() else { return };
    if s.card.feature.as_deref() != Some(&id) {
        s.conn.release(Screen::Board, Some(STREAM));
        let keep = (std::mem::take(&mut s.card.asking), std::mem::take(&mut s.card.start_now));
        s.card = CardState { feature: Some(id), asking: keep.0, start_now: keep.1, ..CardState::default() };
    }
    s.card.seen = signature(s);
    load(s);
}

pub fn load(s: &mut State) {
    let (Some(feature), Some(project)) = (s.card.feature.clone(), s.project.clone()) else { return };
    s.conn.spawn(move |c| {
        let result = c
            .card_detail(&feature)
            .and_then(|detail| {
                Ok(Box::new(Loaded {
                    detail,
                    profiles: c.profiles()?,
                    pipeline: c.pipeline(&project).ok(),
                    can_publish: c.github_status().ok().map(|g| g.can_publish),
                    repos: c.project_repositories(&project).ok(),
                }))
            })
            .map_err(err);
        Msg::Loaded { feature, result }
    });
}

fn load_pulls(s: &mut State) {
    let Some(d) = &s.card.detail else { return };
    let (live, history) = (!d.pull_requests.is_empty(), !d.pull_request_history.is_empty());
    if !live && !history {
        return;
    }
    let feature = d.feature.id.clone();
    // Failure is "unknown", which shows nothing rather than a stale chip.
    s.conn.spawn(move |c| Msg::Pulls {
        merge: live.then(|| c.merge_status(&feature).unwrap_or_default()),
        checks: live.then(|| c.check_status(&feature).unwrap_or_default()),
        ended: history.then(|| c.pull_request_status(&feature).unwrap_or_default()),
        feature,
    });
}

fn follow(s: &mut State) {
    let Some(feature) = s.card.feature.clone() else { return };
    let active = s.card.latest_run().filter(|r| r.status.is_active()).map(|r| r.id.clone());
    questions::follow(s, Place::Drawer, &feature, active.as_deref());
    let Some(run) = active else {
        s.card.streaming = None;
        s.card.turn = Turn::default();
        s.conn.release(Screen::Board, Some(STREAM));
        return;
    };
    if s.card.streaming.as_deref() == Some(&run) && s.conn.holds(Screen::Board, STREAM) {
        return;
    }
    let Some(client) = s.conn.client.clone() else { return };
    s.card.turn = Turn::default();
    s.card.streaming = Some(run.clone());
    let (bus, id) = (s.conn.bus.clone(), run.clone());
    match client.stream_run(&run, 0, move |update| bus.send(Msg::Run { run: id.clone(), update })) {
        Ok(h) => s.conn.hold(Screen::Board, STREAM, h),
        Err(e) => {
            s.card.streaming = None;
            s.toast(err(e));
        }
    }
}

fn is_open(s: &State, feature: &str) -> bool {
    s.card.feature.as_deref() == Some(feature) && s.selected.as_deref() == Some(feature)
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Loaded { feature, .. } if !is_open(s, &feature) => {}
        Msg::Loaded { result: Err(e), .. } => {
            s.card.load_failed = true;
            s.toast(e);
        }
        Msg::Loaded { result: Ok(l), .. } => {
            let Loaded { detail, pipeline, profiles, can_publish, repos } = *l;
            let c = &mut s.card;
            c.load_failed = false;
            if let Some(p) = pipeline {
                c.stages = p.stages;
            }
            c.profiles = profiles;
            c.can_publish = can_publish;
            c.repos = repos;
            c.detail = Some(detail);
            load_pulls(s);
            follow(s);
        }
        Msg::Pulls { feature, .. } if !is_open(s, &feature) => {}
        Msg::Pulls { merge, checks, ended, .. } => {
            let c = &mut s.card;
            c.merge = merge.unwrap_or_default();
            c.checks = checks.unwrap_or_default();
            c.ended = ended.unwrap_or_default();
        }
        Msg::Run { run, .. } if s.card.streaming.as_deref() != Some(&run) => {}
        Msg::Run { update, .. } => match update {
            RunUpdate::Event { event, .. } => {
                s.card.turn.on_event(&event);
                questions::on_event(s, Place::Drawer, &event);
            }
            RunUpdate::Turn(turn) => s.card.turn.on_turn(turn),
            RunUpdate::Done { .. } => {
                s.card.streaming = None;
                s.conn.release(Screen::Board, Some(STREAM));
                load(s);
            }
            RunUpdate::Ended(_) => s.card.streaming = None,
            _ => {}
        },
        Msg::Questions { place, run, result } => questions::fetched(s, place, &run, result),
        Msg::Answered { place, id, result } => questions::answered(s, place, &id, result),
        Msg::Stopped { feature, result } => {
            s.card.stopping = false;
            if !is_open(s, &feature) {
                return;
            }
            match result {
                Ok(r) if !r.interrupted => s.card.turn.interrupt_sent = None,
                Ok(_) => {}
                Err(e) => {
                    s.card.turn.interrupt_sent = None;
                    s.toast(e);
                }
            }
        }
        Msg::Published { feature, result } => {
            s.card.publishing = false;
            s.busy = false;
            pulls::published(s, &feature, result);
        }
        Msg::Started { feature, note, result } => {
            s.busy = false;
            match result {
                Ok(()) => {
                    s.toast(note);
                    data::refetch_board(s);
                    if is_open(s, &feature) {
                        load(s);
                    }
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Deleted { feature, title, result } => {
            s.busy = false;
            match result {
                Ok(()) => s.toast(format!("Deleted “{}”.", clip_title(&title))),
                Err(e) if e.is_not_found() => s.toast("That card was already deleted."),
                Err(e) => {
                    s.toast(err(e));
                    return;
                }
            }
            if s.selected.as_deref() == Some(&feature) {
                s.selected = None;
            }
            data::refetch_board(s);
        }
        Msg::SessionStarted(result) => crate::screens::new_card::session_started(s, result),
    }
}

/// What the board says about the open card; a change means the drawer's reads are stale.
fn signature(s: &State) -> u64 {
    let mut h = DefaultHasher::new();
    if let Some(id) = &s.selected {
        id.hash(&mut h);
        s.lane_of(id).map(|l| l.key()).hash(&mut h);
        if let Some(c) = s.card(id) {
            (c.status.word(), &c.run_id, c.run_status.map(|r| r as u8), &c.pr).hash(&mut h);
        }
    }
    h.finish()
}

pub fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    let (settled, next) = s.card.turn.settle(t);
    if let Some(next) = next {
        tx.wake_after(std::time::Duration::from_secs_f64(next));
    }
    if s.screen != Screen::Board || s.selected.is_none() || s.selected != s.card.feature {
        return settled;
    }
    let seen = signature(s);
    // A screen switch closes the stream; coming back opens it again.
    let lost = s.card.streaming.is_some() && !s.conn.holds(Screen::Board, STREAM);
    if seen != s.card.seen || lost {
        s.card.seen = seen;
        if lost {
            s.card.streaming = None;
        }
        load(s);
        return true;
    }
    settled
}

pub fn stop(s: &mut State, now: f64) {
    let Some(run) = s.card.latest_run().filter(|r| r.status.is_active()).map(|r| r.id.clone()) else { return };
    let Some(feature) = s.card.feature.clone() else { return };
    match s.card.stop_does() {
        StopDoes::None => {}
        StopDoes::End => data::act(s, &feature, data::Action::Stop { run }),
        StopDoes::Interrupt if !s.card.stopping => {
            s.card.stopping = true;
            s.card.turn.interrupt_sent = Some(now);
            s.conn.spawn(move |c| Msg::Stopped { result: c.interrupt_run(&run).map_err(err), feature });
        }
        StopDoes::Interrupt => {}
    }
}

/// The panels between the drawer's head and its conversation: the agent's questions, and the
/// pull requests.
pub fn panels(s: &State, t: &Tokens, k: &Kit) -> El {
    let mut c = rune::col().key("card-panels").w_full().gap(10.0);
    if s.card.feature != s.selected {
        return c;
    }
    let agent = s.card.latest_run().and_then(|r| s.card.profile(&r.agent_profile_id)).map_or("The agent".to_owned(), |p| p.name.clone());
    if let Some(q) = questions::panel(&s.card.questions, Place::Drawer, &agent, t, k) {
        c = c.child(q);
    }
    if let Some(p) = pulls::panel(s, t, k) {
        c = c.child(p);
    }
    c
}

/// The open question in a Sessions conversation, the same card the drawer shows.
pub fn session_questions(q: &Questions, agent: &str, t: &Tokens, k: &Kit) -> Option<El> {
    questions::panel(q, Place::Sessions, agent, t, k)
}

/// The Sessions page follows its open conversation's newest run.
pub fn follow_session(s: &mut State, feature: &str, run: Option<&str>) {
    questions::follow(s, Place::Sessions, feature, run);
}

pub fn session_event(s: &mut State, e: &AgentEvent) {
    questions::on_event(s, Place::Sessions, e);
}

/// A card title inside a sentence: whole, or cut at a word and marked.
fn clip_title(title: &str) -> String {
    if title.chars().count() <= 60 {
        return title.to_owned();
    }
    let cut: String = title.chars().take(60).collect();
    let cut = match cut.rfind(char::is_whitespace) {
        Some(i) => cut[..i].to_owned(),
        None => cut,
    };
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_titles_are_cut_at_a_word() {
        assert_eq!(clip_title("Short"), "Short");
        let long = "Retry failed webhook deliveries with exponential backoff and give up after a day";
        assert_eq!(clip_title(long), "Retry failed webhook deliveries with exponential backoff…");
    }
}
