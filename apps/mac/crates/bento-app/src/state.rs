//! One window's state.

use bento_client::RunStatus;
use rune::TextEdit;
use rune_kit::shell::PaneState;

use crate::data::Conn;
use crate::model::{Card, Entry, Lane};
use crate::pages::{analytics, artifacts, sessions, settings, swarms};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Screen {
    Board,
    Sessions,
    Artifacts,
    Swarms,
    Analytics,
    Settings,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// The server is starting; the sidecar's latest progress line.
    Booting(String),
    Failed(String),
    Ready,
}

#[derive(Clone, Debug)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
}

/// One run in the conversation.
#[derive(Clone, Debug)]
pub struct Block {
    pub agent: String,
    pub status: RunStatus,
    pub entries: Vec<Entry>,
}

#[derive(Clone, Debug, Default)]
pub struct Transcript {
    pub feature: String,
    pub loading: bool,
    pub blocks: Vec<Block>,
    /// The run streaming now.
    pub live: Option<Block>,
    /// What the agent is typing, until its message lands.
    pub draft: String,
    /// Messages queued behind a working agent.
    pub pending: Vec<String>,
    /// Sent from this window and not yet in a fetched conversation.
    pub sent: Vec<String>,
}

pub struct NewCard {
    pub title: TextEdit,
    pub description: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
}

impl NewCard {
    pub fn new() -> NewCard {
        let mut title = TextEdit::new("");
        title.focused = true;
        NewCard { title, description: TextEdit::new(""), busy: false, error: None }
    }
}

pub struct Toast {
    pub id: u64,
    pub text: String,
    /// Clock seconds at which it goes; set on the first poll that sees it.
    pub until: Option<f64>,
}

pub struct State {
    pub screen: Screen,
    pub sidebar: PaneState,
    pub inspector: PaneState,
    pub phase: Phase,
    pub projects: Vec<ProjectRow>,
    pub project: Option<String>,
    pub picking_project: bool,
    pub creating_project: bool,
    /// The board for the open project has arrived at least once.
    pub loaded: bool,
    pub lanes: Vec<Lane>,
    pub selected: Option<String>,
    pub transcript: Transcript,
    pub new_card: Option<NewCard>,
    pub composer: TextEdit,
    /// A card action is in flight.
    pub busy: bool,
    pub toasts: Vec<Toast>,
    next_toast: u64,
    pub conn: Conn,
    pub sessions: sessions::PageState,
    pub artifacts: artifacts::PageState,
    pub swarms: swarms::PageState,
    pub analytics: analytics::PageState,
    pub settings: settings::PageState,
}

impl State {
    pub fn new() -> State {
        State {
            screen: Screen::Board,
            sidebar: PaneState::new(232.0).range(180.0, 360.0),
            inspector: PaneState::new(400.0).range(320.0, 560.0),
            phase: Phase::Booting("Starting Bento.".into()),
            projects: Vec::new(),
            project: None,
            picking_project: false,
            creating_project: false,
            loaded: false,
            lanes: Vec::new(),
            selected: None,
            transcript: Transcript::default(),
            new_card: None,
            composer: TextEdit::new(""),
            busy: false,
            toasts: Vec::new(),
            next_toast: 0,
            conn: Conn::default(),
            sessions: Default::default(),
            artifacts: Default::default(),
            swarms: Default::default(),
            analytics: Default::default(),
            settings: Default::default(),
        }
    }

    pub fn card(&self, id: &str) -> Option<&Card> {
        self.lanes.iter().flat_map(|l| &l.cards).find(|c| c.id == id)
    }

    pub fn lane_of(&self, id: &str) -> Option<&Lane> {
        self.lanes.iter().find(|l| l.cards.iter().any(|c| c.id == id))
    }

    pub fn project_name(&self) -> Option<&str> {
        let id = self.project.as_deref()?;
        self.projects.iter().find(|p| p.id == id).map(|p| p.name.as_str())
    }

    pub fn toast(&mut self, text: impl Into<String>) {
        self.next_toast += 1;
        self.toasts.push(Toast { id: self.next_toast, text: text.into(), until: None });
        // Three at most; the oldest goes first.
        if self.toasts.len() > 3 {
            self.toasts.remove(0);
        }
    }

    pub fn dismiss(&mut self, id: u64) {
        self.toasts.retain(|t| t.id != id);
    }

    /// Ages toasts on the frame clock. Returns whether any went, and when to look again.
    pub fn age_toasts(&mut self, now: f64) -> (bool, Option<f64>) {
        const SHOWN_FOR: f64 = 6.0;
        for t in &mut self.toasts {
            t.until.get_or_insert(now + SHOWN_FOR);
        }
        let before = self.toasts.len();
        self.toasts.retain(|t| t.until.is_some_and(|u| u > now));
        let next = self.toasts.iter().filter_map(|t| t.until).fold(None, |a: Option<f64>, u| Some(a.map_or(u, |a| a.min(u))));
        (self.toasts.len() != before, next.map(|u| u - now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_age_out_and_cap_at_three() {
        let mut s = State::new();
        for n in 0..4 {
            s.toast(format!("t{n}"));
        }
        assert_eq!(s.toasts.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["t1", "t2", "t3"]);
        assert_eq!(s.age_toasts(10.0), (false, Some(6.0)));
        s.toast("later");
        assert_eq!(s.toasts.len(), 3);
        assert!(!s.age_toasts(12.0).0);
        let (gone, next) = s.age_toasts(16.5);
        assert!(gone);
        assert_eq!(s.toasts.len(), 1);
        assert_eq!(next, Some(1.5));
    }
}
