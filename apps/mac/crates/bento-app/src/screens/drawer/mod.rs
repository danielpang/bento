//! What the card drawer shows for review, beside its actions: the conversation, the card's diff,
//! its artifacts, and its details. Each tab's data loads when the card's detail does, so it is
//! fresh after every run, move and approval.

mod artifacts;
pub(crate) mod changes;
mod conversation;
mod details;
mod scenes;
pub mod tools;

use std::collections::HashSet;
use std::sync::Arc;

use bento_client::{
    AgentEvent, AgentProfile, Client, Conversation, EventsPage, FeatureChanges, FeatureDetail, FeatureEvent, GateState, RunArtifact,
};
use rune::{El, ImageCache, Tx, row};
use rune_kit::Kit;
use rune_kit::diff::DiffState;

use crate::data::{self, err};
use crate::model::Entry;
use crate::pages::artifacts::{Body, Load, decode, fetches};
use crate::state::State;
use crate::theme::{Tokens, label};

pub use scenes::SCENES;

/// Earlier lines asked for at a time, as the console pages them.
const PAGE: u32 = 200;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Tab {
    #[default]
    Conversation,
    Changes,
    Artifacts,
    Details,
}

const TABS: [(Tab, &str); 4] = [(Tab::Conversation, "Conversation"), (Tab::Changes, "Changes"), (Tab::Artifacts, "Artifacts"), (Tab::Details, "Details")];

/// A finished run in the conversation, by its place there, with the lines paged in above its
/// tail. The run is folded whole, so a result paged in meets the call it answers.
#[derive(Clone, Debug, PartialEq)]
pub struct RunPage {
    pub run: String,
    pub first_seq: Option<u64>,
    /// Lines still above what is shown.
    pub earlier: u64,
    pub events: Vec<AgentEvent>,
    pub entries: Vec<Entry>,
    /// Lines were paged in above the tail.
    pub paged: bool,
    pub loading: bool,
}

impl RunPage {
    fn new(run: &str, first_seq: Option<u64>, earlier: u64, events: Vec<AgentEvent>) -> RunPage {
        RunPage { run: run.to_owned(), first_seq, earlier, entries: data::entries(&events), events, paged: false, loading: false }
    }
}

pub struct Review {
    pub feature: String,
    pub tab: Tab,
    pub detail: Option<FeatureDetail>,
    pub profiles: Vec<AgentProfile>,
    pub gate: Load<GateState>,
    pub history: Load<Vec<FeatureEvent>>,
    pub changes: Load<FeatureChanges>,
    pub diff: DiffState,
    pub artifacts: Load<Vec<RunArtifact>>,
    /// More than the first few artifacts are listed.
    pub all_artifacts: bool,
    /// The artifact read in place.
    pub reading: Option<String>,
    pub body: Option<(String, Load<Body>)>,
    images: Option<ImageCache>,
    /// Tokens the finished runs reported.
    pub tokens: u64,
    pub pages: Vec<RunPage>,
    /// Tool groups and calls shown open, by their keys.
    pub open: HashSet<String>,
    pub rechecking: bool,
    /// The transcript viewport's bottom edge, in window points.
    viewport_bottom: f32,
    /// The transcript's last line's top, in window points.
    end_y: f32,
    /// The newest line is out of sight below.
    pub scrolled_up: bool,
}

impl Default for Review {
    fn default() -> Self {
        Review {
            feature: String::new(),
            tab: Tab::Conversation,
            detail: None,
            profiles: Vec::new(),
            gate: Load::Loading,
            history: Load::Loading,
            changes: Load::Loading,
            diff: wrapped(DiffState::default()),
            artifacts: Load::Loading,
            all_artifacts: false,
            reading: None,
            body: None,
            images: None,
            tokens: 0,
            pages: Vec::new(),
            open: HashSet::new(),
            rechecking: false,
            viewport_bottom: 0.0,
            end_y: 0.0,
            scrolled_up: false,
        }
    }
}

fn wrapped(mut d: DiffState) -> DiffState {
    d.set_wrap(true);
    d
}

impl Review {
    /// What the drawer knows about `feature`, or nothing while another card's is held.
    pub fn of(&self, feature: &str) -> Option<&Review> {
        (self.feature == feature).then_some(self)
    }

    pub fn agent_name(&self, profile_id: &str) -> Option<&str> {
        self.profiles.iter().find(|p| p.id == profile_id).map(|p| p.name.as_str())
    }
}

pub enum Msg {
    Profiles(Vec<AgentProfile>),
    Gate { feature: String, result: Result<GateState, bento_client::Error> },
    History { feature: String, result: Result<Vec<FeatureEvent>, bento_client::Error> },
    Changes { feature: String, result: Result<FeatureChanges, bento_client::Error> },
    Artifacts { feature: String, result: Result<Vec<RunArtifact>, bento_client::Error> },
    Body { id: String, image: bool, result: Result<Vec<u8>, bento_client::Error> },
    Earlier { feature: String, run: String, result: Result<EventsPage, String> },
    Rechecked { feature: String, result: Result<(), String> },
    /// An image finished decoding; the frame it wakes redraws it.
    Decoded,
}

/// A card was opened: a different card starts from nothing, on the conversation.
pub fn selected(s: &mut State) {
    let Some(id) = s.selected.clone() else { return };
    if s.review.feature != id {
        let images = s.review.images.take();
        s.review = Review { feature: id, images, ..Review::default() };
    }
}

/// The card's detail and conversation arrived: page bookkeeping, then a fresh read of the rest.
pub fn loaded(s: &mut State, detail: FeatureDetail, conversation: &Conversation) {
    let r = &mut s.review;
    if r.feature != detail.feature.id {
        return;
    }
    r.tokens = conversation.blocks.iter().flat_map(|b| &b.events).map(tokens_of).sum();
    let old = std::mem::take(&mut r.pages);
    r.pages = conversation
        .blocks
        .iter()
        .map(|b| match old.iter().find(|p| p.run == b.run_id && p.paged) {
            Some(kept) => kept.clone(),
            None => RunPage::new(&b.run_id, b.first_seq, b.earlier, b.events.clone()),
        })
        .collect();
    r.detail = Some(detail);
    refresh(s);
}

fn tokens_of(e: &AgentEvent) -> u64 {
    match e {
        AgentEvent::Result { input_tokens, output_tokens, .. } => input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0),
        _ => 0,
    }
}

/// Reads the requirements, history, changes and artifacts again, keeping what is shown meanwhile.
fn refresh(s: &mut State) {
    let feature = s.review.feature.clone();
    if feature.is_empty() {
        return;
    }
    if s.review.profiles.is_empty() {
        s.conn.spawn(|c: Client| Msg::Profiles(c.profiles().unwrap_or_default()));
    }
    let f = feature.clone();
    s.conn.spawn(move |c: Client| Msg::Gate { result: c.feature_gate(&f), feature: f });
    let f = feature.clone();
    s.conn.spawn(move |c: Client| Msg::History { result: c.feature_history(&f), feature: f });
    let f = feature.clone();
    s.conn.spawn(move |c: Client| Msg::Changes { result: c.feature_changes(&f), feature: f });
    s.conn.spawn(move |c: Client| Msg::Artifacts { result: c.feature_artifacts(&feature), feature });
}

/// A refresh that fails keeps what is on screen.
fn keep<T>(slot: &mut Load<T>, result: Result<T, bento_client::Error>) {
    if result.is_err() && slot.ready().is_some() {
        return;
    }
    *slot = Load::from(result);
}

pub fn apply(s: &mut State, m: Msg) {
    let r = &mut s.review;
    match m {
        Msg::Profiles(p) => r.profiles = p,
        Msg::Gate { feature, result } if feature == r.feature => keep(&mut r.gate, result),
        Msg::History { feature, result } if feature == r.feature => keep(&mut r.history, result),
        Msg::Changes { feature, result } if feature == r.feature => {
            if let Ok(c) = &result {
                changes::show(&mut r.diff, c);
            }
            keep(&mut r.changes, result);
        }
        Msg::Artifacts { feature, result } if feature == r.feature => {
            keep(&mut r.artifacts, result);
            let gone = r.reading.as_ref().is_some_and(|id| r.artifacts.ready().is_some_and(|list| !list.iter().any(|a| a.id == *id)));
            if gone {
                r.reading = None;
            }
        }
        Msg::Body { id, image, result } => {
            if r.body.as_ref().is_none_or(|(b, _)| *b != id) {
                return;
            }
            let bus = s.conn.bus.clone();
            let cache = r.images.get_or_insert_with(|| ImageCache::new(Arc::new(move || bus.send(Msg::Decoded))));
            r.body = Some((id, decode(cache, image, result)));
        }
        Msg::Earlier { feature, run, result } if feature == r.feature => {
            let Some(page) = r.pages.iter_mut().find(|p| p.run == run) else { return };
            page.loading = false;
            match result {
                Ok(got) => {
                    let mut events = got.events;
                    events.append(&mut page.events);
                    *page = RunPage { paged: true, ..RunPage::new(&page.run, got.first_seq.or(page.first_seq), got.earlier, events) };
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Rechecked { feature, result } if feature == r.feature => {
            r.rechecking = false;
            match result {
                Ok(()) => {
                    data::refetch_board(s);
                    refresh(s);
                }
                Err(e) => s.toast(e),
            }
        }
        _ => {}
    }
}

pub fn show_tab(s: &mut State, tab: Tab) {
    s.review.tab = tab;
}

pub fn toggle(s: &mut State, key: &str) {
    if !s.review.open.remove(key) {
        s.review.open.insert(key.to_owned());
    }
}

/// Pages in the lines above the `index`th finished run's tail.
pub fn load_earlier(s: &mut State, index: usize) {
    let feature = s.review.feature.clone();
    let Some(page) = s.review.pages.get_mut(index) else { return };
    let Some(seq) = page.first_seq.filter(|_| page.earlier > 0 && !page.loading) else { return };
    let run = page.run.clone();
    page.loading = s.conn.spawn(move |c: Client| Msg::Earlier { result: c.run_events_before(&run, seq, PAGE).map_err(err), feature, run });
}

pub fn recheck(s: &mut State) {
    let feature = s.review.feature.clone();
    if s.review.rechecking {
        return;
    }
    s.review.rechecking = s.conn.spawn(move |c: Client| Msg::Rechecked { result: c.recheck_gate(&feature).map(drop).map_err(err), feature });
}

/// Reads an artifact in place, fetching only what the reader renders.
pub fn read(s: &mut State, id: &str) {
    s.review.reading = Some(id.to_owned());
    let Some(a) = s.review.artifacts.ready().and_then(|l| l.iter().find(|a| a.id == id)).cloned() else { return };
    if s.review.body.as_ref().is_some_and(|(b, _)| *b == a.id) {
        return;
    }
    s.review.body = None;
    if let Some(image) = fetches(&a) {
        let artifact = a.id.clone();
        if s.conn.spawn(move |c: Client| Msg::Body { result: c.artifact_content(&artifact), id: artifact, image }) {
            s.review.body = Some((a.id, Load::Loading));
        }
    }
}

/// Where the transcript's end sits against its viewport, for the jump to the newest line.
fn track_end(s: &mut State, end_y: f32, tx: &mut Tx) {
    s.review.end_y = end_y;
    settle_jump(s, tx);
}

fn track_viewport(s: &mut State, r: [f32; 4], tx: &mut Tx) {
    s.review.viewport_bottom = r[1] + r[3];
    settle_jump(s, tx);
}

fn settle_jump(s: &mut State, tx: &mut Tx) {
    let r = &mut s.review;
    let up = r.viewport_bottom > 0.0 && r.end_y > r.viewport_bottom + 48.0;
    if up == r.scrolled_up {
        tx.live_only();
    }
    r.scrolled_up = up;
}

/// The tab row, under the drawer's head.
pub fn tabs(s: &State, card: &str, t: &Tokens) -> El {
    let running = s.card(card).and_then(|c| c.run_status).is_some_and(bento_client::RunStatus::is_active);
    let current = s.review.of(card).map_or(Tab::Conversation, |r| r.tab);
    let mut bar = row().key("drawer-tabs").w_full().gap(16.0).border_sides([0.0, 0.0, 1.0, 0.0], t.line).role("tablist").label("Card details");
    for (tab, name) in TABS {
        let on = tab == current;
        let mut word = row().gap(5.0).center_y().child(label(name, 12.5, if on { 600.0 } else { 450.0 }, if on { t.text } else { t.dim }));
        if tab == Tab::Conversation && running {
            word = word.child(rune::el().size(6.0, 6.0).radius(3.0).fill(t.running));
        }
        let mut cell = rune::col()
            .key(format!("tab-{}", name.to_lowercase()))
            .pt(2.0)
            .gap(7.0)
            .role("tab")
            .label(name)
            .focusable(true)
            .on_press(move |s: &mut State| show_tab(s, tab))
            .child(word);
        cell = cell.child(rune::el().w_full().h(2.0).radius(1.0).fill(if on { t.text } else { rune::color::Color::TRANSPARENT }));
        bar = bar.child(cell);
    }
    bar
}

/// The open tab's body.
pub fn body(s: &State, card: &str, t: &Tokens, k: &Kit) -> El {
    let tab = s.review.of(card).map_or(Tab::Conversation, |r| r.tab);
    match tab {
        Tab::Conversation => conversation::view(s, card, t, k),
        Tab::Changes => changes::tab(s, card, t, k),
        Tab::Artifacts => artifacts::tab(s, card, t, k),
        Tab::Details => details::tab(s, card, t, k),
    }
}
