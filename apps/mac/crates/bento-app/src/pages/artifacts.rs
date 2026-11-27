//! The Artifacts page: what agents produced in the open project, by card, and a reader for one.
//!
//! Agent bytes are untrusted. Markdown renders with raw HTML dropped (rune-kit's parser ignores
//! HTML events), images are decoded into pixels, text is text, and HTML or SVG is never fetched
//! here: the browser console renders it sandboxed.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bento_client::{AgentRun, BoardEvent, BoardUpdate, Client, ProjectArtifactCard, RunArtifact, RunStatus};
use rune::{Align, Cx, El, Image, ImageCache, Key, KeyEvent, ScrollSpec, SurfaceFit, TextEdit, Tx, col, el, row};
use rune_kit::{Button, ButtonVariant, Kit, Markdown, TextInput};

use crate::data;
use crate::metal;
use crate::pages::{self, Scene};
use crate::screens::parts::key;
use crate::state::{Screen, State};
use crate::theme::{Tokens, label, mono};

const LIST_W: f32 = 300.0;
/// Below this main pane width the list and the reader take turns.
const STACK_BELOW: f32 = 620.0;
/// The server returns at most this many artifacts per card.
const CARD_CAP: usize = 200;
/// Text past this is cut, so one huge log cannot stall a frame.
const TEXT_SHOWN: usize = 256 * 1024;

pub enum Load<T> {
    Loading,
    Failed { message: String, missing: bool },
    Ready(T),
}

impl<T> Load<T> {
    fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(v) => Some(v),
            _ => None,
        }
    }

    fn from(result: Result<T, bento_client::Error>) -> Load<T> {
        match result {
            Ok(v) => Load::Ready(v),
            Err(e) => Load::Failed { missing: e.is_not_found(), message: data::err(e) },
        }
    }
}

pub enum Body {
    Text(String),
    Image(Image),
}

/// Who made an artifact, for the inspector.
pub struct RunInfo {
    pub status: RunStatus,
    pub agent: Option<String>,
}

pub struct PageState {
    project: Option<String>,
    cards: Load<Vec<ProjectArtifactCard>>,
    files: HashMap<String, Load<Vec<RunArtifact>>>,
    expanded: HashSet<String>,
    /// The card and the artifact the reader shows.
    selected: Option<(String, String)>,
    query: TextEdit,
    body: Option<(String, Load<Body>)>,
    runs: HashMap<String, Load<RunInfo>>,
    profiles: HashMap<String, String>,
    images: Option<ImageCache>,
    width: f32,
    /// In the stacked layout, whether the reader is showing instead of the list.
    reading: bool,
}

impl Default for PageState {
    fn default() -> Self {
        PageState {
            project: None,
            cards: Load::Loading,
            files: HashMap::new(),
            expanded: HashSet::new(),
            selected: None,
            query: TextEdit::new(""),
            body: None,
            runs: HashMap::new(),
            profiles: HashMap::new(),
            images: None,
            width: 0.0,
            reading: false,
        }
    }
}

pub enum Msg {
    Cards { project: String, result: Result<Vec<ProjectArtifactCard>, bento_client::Error> },
    Files { feature: String, result: Result<Vec<RunArtifact>, bento_client::Error> },
    Body { id: String, image: bool, result: Result<Vec<u8>, bento_client::Error> },
    Run { id: String, result: Result<AgentRun, bento_client::Error> },
    Profiles(Vec<(String, String)>),
    Board { project: String, update: BoardUpdate },
    /// An image finished decoding; the frame it wakes redraws it.
    Decoded,
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Cards { project, result } => {
            if s.artifacts.project.as_deref() != Some(&project) {
                return;
            }
            // A refresh that fails keeps what is on screen.
            if result.is_err() && s.artifacts.cards.ready().is_some() {
                return;
            }
            s.artifacts.cards = Load::from(result);
            if s.artifacts.selected.is_none()
                && let Some(first) = s.artifacts.cards.ready().and_then(|c| c.first()).map(|c| c.feature_id.clone())
            {
                s.artifacts.expanded.insert(first.clone());
                load_files(s, &first);
            }
        }
        Msg::Files { feature, result } => {
            if result.is_err() && s.artifacts.files.get(&feature).and_then(Load::ready).is_some() {
                return;
            }
            let first = result.as_ref().ok().and_then(|f| f.first()).map(|a| a.id.clone());
            s.artifacts.files.insert(feature.clone(), Load::from(result));
            if let (None, Some(id)) = (&s.artifacts.selected, first) {
                select(s, &feature, &id, false);
            }
        }
        Msg::Body { id, image, result } => {
            if s.artifacts.body.as_ref().is_none_or(|(b, _)| *b != id) {
                return;
            }
            let body = match result {
                Ok(bytes) if image => match image_cache(s) {
                    Some(cache) => Load::Ready(Body::Image(cache.load(bytes))),
                    None => Load::Failed { message: String::new(), missing: false },
                },
                Ok(bytes) => Load::Ready(Body::Text(String::from_utf8_lossy(&bytes).into_owned())),
                Err(e) => Load::from(Err(e)),
            };
            s.artifacts.body = Some((id, body));
        }
        Msg::Run { id, result } => {
            let info = result.map(|r| RunInfo { status: r.status, agent: s.artifacts.profiles.get(&r.agent_profile_id).cloned() });
            s.artifacts.runs.insert(id, Load::from(info));
        }
        Msg::Profiles(list) => {
            s.artifacts.profiles = list.into_iter().collect();
            // Runs that arrived first learn their agent's name.
            s.artifacts.runs.clear();
            if let Some(run) = selected_artifact(s).map(|a| a.run_id.clone()) {
                load_run(s, &run);
            }
        }
        Msg::Board { project, update } => {
            if s.artifacts.project.as_deref() != Some(&project) {
                return;
            }
            let feature = match update {
                BoardUpdate::Event(BoardEvent::RunUpdated { feature_id, status: Some(st), .. }) if st.is_terminal() => Some(feature_id),
                BoardUpdate::Event(BoardEvent::FeatureDeleted { feature_id, .. }) => Some(feature_id),
                BoardUpdate::Reconnected => None,
                _ => return,
            };
            refresh(s, feature.as_deref());
        }
        Msg::Decoded => {}
    }
}

fn image_cache(s: &mut State) -> Option<&ImageCache> {
    if s.artifacts.images.is_none() {
        let bus = s.conn.bus.clone();
        s.artifacts.images = Some(ImageCache::new(Arc::new(move || bus.send(Msg::Decoded))));
    }
    s.artifacts.images.as_ref()
}

/// Refetches the list and the loaded cards' files without clearing what is shown.
fn refresh(s: &mut State, feature: Option<&str>) {
    let Some(project) = s.artifacts.project.clone() else { return };
    s.conn.spawn(move |c: Client| Msg::Cards { result: c.project_artifacts(&project), project });
    let loaded: Vec<String> = match feature {
        Some(f) => s.artifacts.files.contains_key(f).then(|| f.to_owned()).into_iter().collect(),
        None => s.artifacts.files.keys().cloned().collect(),
    };
    for f in loaded {
        s.conn.spawn(move |c: Client| Msg::Files { result: c.feature_artifacts(&f), feature: f });
    }
}

pub fn enter(s: &mut State) {
    if s.artifacts.project != s.project {
        let (images, profiles) = (s.artifacts.images.take(), std::mem::take(&mut s.artifacts.profiles));
        s.artifacts = PageState { project: s.project.clone(), images, profiles, width: s.artifacts.width, ..PageState::default() };
    }
    let Some(project) = s.project.clone() else { return };
    if !s.conn.spawn({
        let project = project.clone();
        move |c: Client| Msg::Cards { result: c.project_artifacts(&project), project }
    }) {
        return;
    }
    let loaded: Vec<String> = s.artifacts.files.keys().cloned().collect();
    for f in loaded {
        s.conn.spawn(move |c: Client| Msg::Files { result: c.feature_artifacts(&f), feature: f });
    }
    if s.artifacts.profiles.is_empty() {
        s.conn.spawn(|c: Client| Msg::Profiles(c.profiles().map(|p| p.into_iter().map(|p| (p.id, p.name)).collect()).unwrap_or_default()));
    }
    let bus = s.conn.bus.clone();
    let stream = s.conn.client.as_ref().map(|c| {
        let project = project.clone();
        c.stream_board(&project.clone(), move |update| bus.send(Msg::Board { project: project.clone(), update }))
    });
    if let Some(Ok(handle)) = stream {
        s.conn.hold(Screen::Artifacts, "board", handle);
    }
}

pub fn leave(_s: &mut State) {}

fn load_files(s: &mut State, feature: &str) {
    if s.artifacts.files.contains_key(feature) {
        return;
    }
    let f = feature.to_owned();
    if s.conn.spawn(move |c: Client| Msg::Files { result: c.feature_artifacts(&f), feature: f }) {
        s.artifacts.files.insert(feature.to_owned(), Load::Loading);
    }
}

fn load_run(s: &mut State, run: &str) {
    if s.artifacts.runs.contains_key(run) {
        return;
    }
    let id = run.to_owned();
    if s.conn.spawn(move |c: Client| Msg::Run { result: c.get_run(&id), id }) {
        s.artifacts.runs.insert(run.to_owned(), Load::Loading);
    }
}

/// What the reader fetches: text for the kinds it renders, bytes for a raster image, and
/// nothing for HTML, SVG or any other file that could carry script.
fn fetches(a: &RunArtifact) -> Option<bool> {
    match a.kind.as_str() {
        "image" => Some(true),
        "markdown" | "mermaid" => Some(false),
        "file" if a.mime.starts_with("text/") => Some(false),
        _ => None,
    }
}

fn select(s: &mut State, feature: &str, id: &str, read: bool) {
    s.artifacts.selected = Some((feature.to_owned(), id.to_owned()));
    s.artifacts.reading = read;
    let Some(a) = selected_artifact(s).cloned() else { return };
    if s.artifacts.body.as_ref().is_none_or(|(b, _)| *b != a.id) {
        s.artifacts.body = None;
        if let Some(image) = fetches(&a) {
            let artifact = a.id.clone();
            if s.conn.spawn(move |c: Client| Msg::Body { result: c.artifact_content(&artifact), id: artifact, image }) {
                s.artifacts.body = Some((a.id.clone(), Load::Loading));
            }
        }
    }
    load_run(s, &a.run_id);
}

fn toggle(s: &mut State, feature: &str) {
    if !s.artifacts.expanded.remove(feature) {
        s.artifacts.expanded.insert(feature.to_owned());
        load_files(s, feature);
    }
}

fn selected_artifact(s: &State) -> Option<&RunArtifact> {
    let (feature, id) = s.artifacts.selected.as_ref()?;
    s.artifacts.files.get(feature)?.ready()?.iter().find(|a| a.id == *id)
}

fn selected_card(s: &State) -> Option<&ProjectArtifactCard> {
    let (feature, _) = s.artifacts.selected.as_ref()?;
    s.artifacts.cards.ready()?.iter().find(|c| c.feature_id == *feature)
}

// Formatting, after the console's artifacts-format.ts.

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().filter(|b| !b.is_empty()).unwrap_or(path)
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "markdown" => "Markdown",
        "mermaid" => "Mermaid",
        "image" => "Image",
        "html" => "HTML",
        _ => "File",
    }
}

fn kind_ext(kind: &str, path: Option<&str>) -> String {
    if let (true, Some(path)) = (kind == "file", path)
        && let Some((_, ext)) = path.rsplit_once('.')
        && !ext.is_empty()
        && ext.len() <= 4
        && !ext.contains('/')
    {
        return ext.to_uppercase();
    }
    match kind {
        "markdown" => "MD",
        "mermaid" => "MMD",
        "image" => "IMG",
        "html" => "HTML",
        _ => "FILE",
    }
    .into()
}

fn count_label(n: u32) -> String {
    if n == 1 { "1 artifact".into() } else { format!("{n} artifacts") }
}

/// Seconds since the epoch for an ISO 8601 UTC time such as `2026-11-27T06:30:54.000Z`.
fn epoch(iso: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, min, sec) = (n(11..13)?, n(14..16)?, n(17..19).unwrap_or(0));
    // Days from civil, Howard Hinnant's algorithm.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + min * 60 + sec)
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn updated_ago(iso: &str, now: i64) -> String {
    let Some(t) = epoch(iso) else { return String::new() };
    let minutes = (now - t).max(0) / 60;
    if minutes < 1 {
        return "Updated just now".into();
    }
    if minutes < 60 {
        return format!("Updated {minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 48 { format!("Updated {hours}h ago") } else { format!("Updated {}d ago", hours / 24) }
}

fn created_label(iso: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (Some(month), Some(day), Some(year), Some(time)) = (
        iso.get(5..7).and_then(|m| m.parse::<usize>().ok()).and_then(|m| MONTHS.get(m.wrapping_sub(1))),
        iso.get(8..10).and_then(|d| d.parse::<u32>().ok()),
        iso.get(0..4),
        iso.get(11..16),
    ) else {
        return iso.to_owned();
    };
    format!("{month} {day}, {year}, {time} UTC")
}

fn size_label(bytes: u64) -> String {
    match bytes {
        0..1024 => format!("{bytes} bytes"),
        1024..1_048_576 => format!("{:.1} KB", bytes as f64 / 1024.0),
        _ => format!("{:.1} MB", bytes as f64 / 1_048_576.0),
    }
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

// Search, after artifacts-search.ts.

fn needle(s: &State) -> String {
    s.artifacts.query.text.trim().to_lowercase()
}

/// The cards the query leaves, each with the file names that matched.
fn results<'a>(cards: &'a [ProjectArtifactCard], q: &str) -> Vec<(&'a ProjectArtifactCard, Vec<&'a str>)> {
    cards
        .iter()
        .filter_map(|c| {
            if q.is_empty() {
                return Some((c, Vec::new()));
            }
            let mut files: Vec<&str> = Vec::new();
            for name in c.paths.iter().map(|p| base_name(p)) {
                if name.to_lowercase().contains(q) && !files.contains(&name) {
                    files.push(name);
                }
            }
            (!files.is_empty() || c.title.to_lowercase().contains(q)).then_some((c, files))
        })
        .collect()
}

/// The files a card shows under the query: all of them when its title matched.
fn shown_files<'a>(card: &ProjectArtifactCard, files: &'a [RunArtifact], q: &str) -> Vec<&'a RunArtifact> {
    if q.is_empty() || card.title.to_lowercase().contains(q) {
        return files.iter().collect();
    }
    files.iter().filter(|a| base_name(&a.path).to_lowercase().contains(q)).collect()
}

/// Every file in the list as it stands, in order, for the arrow keys.
fn visible_files(s: &State) -> Vec<(String, String)> {
    let q = needle(s);
    let Some(cards) = s.artifacts.cards.ready() else { return Vec::new() };
    let mut out = Vec::new();
    for (card, _) in results(cards, &q) {
        if !s.artifacts.expanded.contains(&card.feature_id) && q.is_empty() {
            continue;
        }
        if let Some(files) = s.artifacts.files.get(&card.feature_id).and_then(Load::ready) {
            out.extend(shown_files(card, files, &q).into_iter().map(|a| (card.feature_id.clone(), a.id.clone())));
        }
    }
    out
}

// The view.

fn note(text: impl Into<String>, t: &Tokens) -> El {
    label(text, 12.5, 400.0, t.faint).wrap()
}

/// A note in a centered panel.
fn cnote(text: impl Into<String>, t: &Tokens) -> El {
    note(text, t).align(Align::Center)
}

fn centered(key_: &str, children: Vec<El>) -> El {
    children.into_iter().fold(col().key(key_).w_full().h_full().center().gap(10.0).padding(24.0), |c, e| c.child(e))
}

fn button(name: impl Into<String>, k: &Kit, f: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    Button::new(name).variant(ButtonVariant::Neutral).on_press_tx(f).build(k)
}

fn ext_badge(text: String, t: &Tokens, w: f32) -> El {
    row().w(w).h(20.0).radius(5.0).center().border(1.0, t.line).fill(t.raised).child(mono(text, 9.5, t.dim))
}

pub fn view(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, _layer: &mut Vec<El>) -> El {
    let stacked = s.artifacts.width > 0.0 && s.artifacts.width < STACK_BELOW;
    let page = row().key("artifacts").w_full().h_full().on_layout(|s: &mut State, r: [f32; 4]| s.artifacts.width = r[2]);
    let Some(cards) = s.artifacts.cards.ready() else {
        return page.child(match &s.artifacts.cards {
            Load::Failed { missing: true, .. } => centered(
                "artifacts-missing",
                vec![cnote("This project isn't available. It may have been removed, or you may not have access.", t).max_w(360.0)],
            ),
            Load::Failed { message, .. } => centered(
                "artifacts-error",
                vec![
                    label("Couldn't load artifacts.", 13.0, 500.0, t.text),
                    label(message.clone(), 12.0, 400.0, t.failed).wrap().selectable(true).max_w(420.0),
                    button("Try again", k, |s, _| enter(s)).key("artifacts-retry"),
                ],
            ),
            _ => centered("artifacts-loading", vec![note("Loading artifacts.", t)]),
        });
    };
    if cards.is_empty() {
        return page.child(centered(
            "artifacts-empty",
            vec![
                label("No artifacts yet", 14.0, 600.0, t.text),
                cnote("When an agent produces a write up, mockup, or screenshot on a card, it will show up here.", t).max_w(360.0),
                button("Go to Board", k, |s, _| pages::show(s, Screen::Board)).key("go-to-board"),
            ],
        ));
    }
    if stacked {
        let reading = s.artifacts.reading && selected_artifact(s).is_some();
        return page.child(if reading { reader(s, t, k, true) } else { list(s, cards, t, k).w_full() });
    }
    page.child(list(s, cards, t, k).w(LIST_W)).child(el().w(1.0).h_full().fill(t.line)).child(reader(s, t, k, false))
}

fn search(s: &State, count: usize, t: &Tokens, k: &Kit) -> El {
    let field = TextInput::new(&s.artifacts.query)
        .label("Search artifacts")
        .placeholder("Search cards and file names")
        .leading_icon(&rune_kit::glyphs::SEARCH)
        .clear_button()
        .width(None)
        .on_edit(|s: &mut State| &mut s.artifacts.query)
        .on_key(|s: &mut State, ev: &KeyEvent, _: &mut Tx| {
            if ev.key == Key::Escape && !s.artifacts.query.text.is_empty() {
                s.artifacts.query = TextEdit::new("");
                return true;
            }
            false
        })
        .build(k)
        .key("artifacts-search");
    let mut c = col().w_full().gap(6.0).child(field);
    if !needle(s).is_empty() {
        let status = if count == 1 { "1 card".to_owned() } else { format!("{count} cards") };
        c = c.child(label(status, 11.5, 400.0, t.faint).key("artifacts-search-count"));
    }
    c
}

fn list(s: &State, cards: &[ProjectArtifactCard], t: &Tokens, k: &Kit) -> El {
    let q = needle(s);
    let found = results(cards, &q);
    let head = col().w_full().px(12.0).pt(12.0).pb(8.0).child(search(s, found.len(), t, k));
    let mut rows = col().key("artifacts-cards").w_full().px(8.0).pb(12.0).gap(2.0);
    if found.is_empty() {
        let query = s.artifacts.query.text.trim().to_owned();
        rows = rows.child(
            col()
                .key("artifacts-no-match")
                .w_full()
                .padding(12.0)
                .gap(8.0)
                .child(label(format!("No artifacts match \u{201c}{query}\u{201d}"), 13.0, 500.0, t.text).wrap())
                .child(note("Search looks at card titles and file names.", t))
                .child(button("Clear search", k, |s, _| s.artifacts.query = TextEdit::new("")).key("clear-search")),
        );
    }
    let now = now();
    for (card, files) in found {
        rows = rows.child(card_row(s, card, &files, &q, now, t, k));
    }
    col().key("artifacts-list").h_full().min_h(0.0).child(head).child(
        col().key("artifacts-list-scroll").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec::default()).child(rows),
    )
}

fn card_row(s: &State, card: &ProjectArtifactCard, matched: &[&str], q: &str, now: i64, t: &Tokens, k: &Kit) -> El {
    // A search shows the matching files of every card it keeps, as the console's tiles name them.
    let open = s.artifacts.expanded.contains(&card.feature_id) || !q.is_empty();
    let id = card.feature_id.clone();
    let kinds = card.kinds.iter().fold(row().gap(4.0), |r, kind| r.child(mono(kind_ext(kind, None), 9.5, t.faint)));
    let meta = format!("{} · {}", count_label(card.artifact_count), updated_ago(&card.latest_created_at, now));
    let head = row()
        .key(format!("artifact-card-{}", card.feature_id))
        .w_full()
        .px(8.0)
        .py(8.0)
        .gap(8.0)
        .radius(7.0)
        .items_start()
        .hover_fill(t.panel)
        .role("button")
        .label(card.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| toggle(s, &id))
        .child(label(if open { "▾" } else { "▸" }, 11.0, 400.0, t.faint).w(10.0).mt(2.0))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(3.0)
                .child(label(card.title.clone(), 13.0, 500.0, t.text).wrap())
                .child(row().w_full().gap(8.0).flex_wrap().center_y().child(label(meta, 11.5, 400.0, t.faint)).child(kinds)),
        );
    let mut c = col().w_full().gap(1.0).child(head);
    if !open {
        return c;
    }
    let body = match s.artifacts.files.get(&card.feature_id) {
        None | Some(Load::Loading) => {
            // While a search is open over unloaded files, name the matches the summary knows.
            let names = matched.iter().fold(col().gap(4.0), |c, n| c.child(mono((*n).to_owned(), 11.5, t.dim).truncate()));
            col().gap(6.0).child(names).child(note("Loading artifacts.", t))
        }
        Some(Load::Failed { missing: true, .. }) => col().child(note("This card no longer exists.", t)),
        Some(Load::Failed { message, .. }) => {
            let id = card.feature_id.clone();
            col()
                .gap(6.0)
                .child(label("Couldn't load artifacts.", 12.5, 500.0, t.text))
                .child(label(message.clone(), 11.5, 400.0, t.failed).wrap().selectable(true))
                .child(
                    button("Try again", k, move |s, _| {
                        s.artifacts.files.remove(&id);
                        load_files(s, &id);
                    })
                    .key(format!("files-retry-{}", card.feature_id)),
                )
        }
        Some(Load::Ready(files)) if files.is_empty() => col().child(note("No artifacts on this card", t)),
        Some(Load::Ready(files)) => {
            let shown = shown_files(card, files, q);
            let mut list = col().w_full().gap(1.0);
            if shown.is_empty() {
                list = list.child(note("No file names match.", t));
            }
            for a in shown {
                list = list.child(file_row(s, card, a, t));
            }
            if files.len() >= CARD_CAP {
                list = list.child(note("Showing the 200 most recent artifacts.", t).pt(6.0));
            }
            list
        }
    };
    c = c.child(col().w_full().pl(26.0).pr(4.0).pb(8.0).child(body));
    c
}

fn file_row(s: &State, card: &ProjectArtifactCard, a: &RunArtifact, t: &Tokens) -> El {
    let current = s.artifacts.selected.as_ref().is_some_and(|(_, id)| *id == a.id);
    let (feature, id) = (card.feature_id.clone(), a.id.clone());
    let stage = if a.stage_name.is_empty() { kind_label(&a.kind).to_owned() } else { format!("{} · {}", a.stage_name, kind_label(&a.kind)) };
    let mut r = row()
        .key(format!("artifact-{}", a.id))
        .w_full()
        .px(8.0)
        .py(6.0)
        .gap(10.0)
        .radius(7.0)
        .center_y()
        .role("button")
        .label(base_name(&a.path).to_owned())
        .focusable(true)
        .on_press(move |s: &mut State| select(s, &feature, &id, true))
        .child(ext_badge(kind_ext(&a.kind, Some(&a.path)), t, 40.0))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(label(base_name(&a.path).to_owned(), 12.5, 450.0, t.text).truncate())
                .child(label(stage, 11.0, 400.0, t.faint).truncate()),
        );
    r = if current { r.fill(t.raised).border(1.0, t.line) } else { r.hover_fill(t.panel) };
    r
}

fn open_in_browser(url: String) -> impl Fn(&mut State, &mut Tx) + 'static {
    move |s: &mut State, tx: &mut Tx| {
        if let Err(e) = tx.open_url(&url) {
            s.toast(e.to_string());
        }
    }
}

fn reader(s: &State, t: &Tokens, k: &Kit, stacked: bool) -> El {
    let frame = col().key("artifact-reader").grow(1.0).shrink().min_w(0.0).h_full().min_h(0.0);
    let Some(a) = selected_artifact(s) else {
        return frame.child(centered("artifact-none", vec![note("Select an artifact", t)]));
    };
    let client = s.conn.client.as_ref();
    let name = base_name(&a.path).to_owned();
    let mut head = row().key("artifact-reader-head").w_full().px(16.0).py(12.0).gap(10.0).center_y();
    if stacked {
        head = head.child(
            Button::new("All artifacts")
                .variant(ButtonVariant::Ghost)
                .on_press(|s: &mut State| s.artifacts.reading = false)
                .build(k)
                .key("artifact-back"),
        );
    }
    head = head.child(
        col()
            .grow(1.0)
            .shrink()
            .min_w(0.0)
            .gap(2.0)
            .child(label(name, 14.0, 600.0, t.text).truncate())
            .child(mono(a.path.clone(), 11.0, t.faint).truncate_middle()),
    );
    // HTML gets the copper key in its own panel; everything else can open the console's page.
    if let (Some(c), false) = (client, a.kind == "html") {
        let url = if fetches(a).is_some() { c.artifact_console_url(&a.id) } else { c.artifact_content_url(&a.id) };
        let name = if fetches(a).is_some() { "Open in browser" } else { "Download" };
        head = head.child(button(name, k, open_in_browser(url)).key("artifact-open"));
    }
    frame.child(head).child(el().w_full().h(1.0).fill(t.line)).child(reader_body(s, a, t, k))
}

fn reader_body(s: &State, a: &RunArtifact, t: &Tokens, k: &Kit) -> El {
    let scroll = |child: El| col().key("artifact-body").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec::default()).child(child);
    if a.kind == "html" {
        return html_panel(s, a, t);
    }
    if fetches(a).is_none() {
        return centered(
            "artifact-no-preview",
            vec![ext_badge(kind_ext(&a.kind, Some(&a.path)), t, 52.0), cnote("This file has no preview. Download it to look at it.", t).max_w(320.0)],
        );
    }
    let body = match &s.artifacts.body {
        Some((id, body)) if *id == a.id => body,
        _ => return centered("artifact-loading", vec![note("Loading artifacts.", t)]),
    };
    match body {
        Load::Loading => centered("artifact-loading", vec![note("Loading artifacts.", t)]),
        Load::Failed { message, .. } => centered(
            "artifact-error",
            vec![
                label("Could not load this artifact. Check the connection and open it again.", 12.5, 450.0, t.failed).wrap().max_w(380.0),
                label(message.clone(), 11.5, 400.0, t.faint).wrap().selectable(true).max_w(380.0),
            ],
        ),
        Load::Ready(Body::Image(img)) => match (img.error(), img.size()) {
            (Some(_), _) => centered(
                "artifact-no-preview",
                vec![ext_badge(kind_ext(&a.kind, Some(&a.path)), t, 52.0), cnote("This file has no preview. Download it to look at it.", t).max_w(320.0)],
            ),
            (None, Some([w, h])) if w > 0 && h > 0 => col()
                .key("artifact-image")
                .w_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .padding(20.0)
                .center()
                .child(el().aspect_fit(w as f32 / h as f32).max_w(w as f32).max_h(h as f32).radius(4.0).pixels_fit(img.pixels(), SurfaceFit::Fill)),
            _ => centered("artifact-loading", vec![note("Loading artifacts.", t)]),
        },
        Load::Ready(Body::Text(text)) if a.kind == "markdown" => {
            scroll(col().w_full().max_w(760.0).px(24.0).py(20.0).child(Markdown::new(text.clone()).selectable(true).build(k).w_full()))
        }
        Load::Ready(Body::Text(text)) => {
            let cut = text.len() > TEXT_SHOWN;
            let shown = if cut { &text[..text.floor_char_boundary(TEXT_SHOWN)] } else { text.as_str() };
            let mut c = col().px(20.0).py(16.0).gap(10.0).child(mono(shown.to_owned(), 12.0, t.text).selectable(true));
            if cut {
                c = c.child(note("Showing the first 256 KB. Open it in the browser for the rest.", t));
            }
            col().key("artifact-body").w_full().grow(1.0).shrink().min_h(0.0).scroll_xy().child(c)
        }
    }
}

/// HTML is never fetched or drawn here: the console renders it in a sandboxed frame.
fn html_panel(s: &State, a: &RunArtifact, t: &Tokens) -> El {
    let url = s.conn.client.as_ref().map(|c| c.artifact_console_url(&a.id));
    let made_by = match s.artifacts.runs.get(&a.run_id) {
        Some(Load::Ready(RunInfo { agent: Some(agent), .. })) => format!("{agent}, run {}", short_id(&a.run_id)),
        _ => format!("Run {}", short_id(&a.run_id)),
    };
    let facts = col()
        .gap(4.0)
        .items_center()
        .child(label(base_name(&a.path).to_owned(), 13.5, 600.0, t.text).truncate())
        .child(label(format!("{} · {}", size_label(a.size), made_by), 12.0, 400.0, t.dim).truncate());
    let open = key("Open in browser", metal::KEY, t, url.map(open_in_browser)).key("artifact-open-html");
    centered(
        "artifact-html",
        vec![
            ext_badge("HTML".into(), t, 52.0),
            facts,
            cnote("HTML previews open in the browser, where they run sandboxed.", t).max_w(340.0),
            open,
        ],
    )
}

pub fn inspector(s: &State, _cx: &mut Cx<State>, t: &Tokens, _k: &Kit, _layer: &mut Vec<El>) -> Option<El> {
    let a = selected_artifact(s)?;
    let card = selected_card(s).map_or_else(String::new, |c| c.title.clone());
    let (run, agent) = match s.artifacts.runs.get(&a.run_id) {
        Some(Load::Ready(info)) => {
            let word = match info.status {
                RunStatus::Queued | RunStatus::Starting | RunStatus::Running => "running",
                RunStatus::Succeeded => "succeeded",
                RunStatus::Failed => "failed",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Unknown => "",
            };
            let run = if word.is_empty() { short_id(&a.run_id).to_owned() } else { format!("{} · {word}", short_id(&a.run_id)) };
            (run, info.agent.clone().unwrap_or_default())
        }
        _ => (short_id(&a.run_id).to_owned(), String::new()),
    };
    let fact = |name: &str, value: String, mono_: bool| {
        let v = if mono_ { mono(value, 12.0, t.text) } else { label(value, 12.5, 400.0, t.text) };
        col().key(format!("fact-{}", name.to_lowercase())).w_full().gap(3.0).child(label(name.to_owned(), 11.0, 500.0, t.faint)).child(v.wrap().selectable(true))
    };
    let mut c = col()
        .key("artifact-inspector")
        .w_full()
        .padding(16.0)
        .gap(14.0)
        .child(label(base_name(&a.path).to_owned(), 14.0, 600.0, t.text).wrap())
        .child(fact("Card", card, false))
        .child(fact("Stage", a.stage_name.clone(), false))
        .child(fact("Run", run, true));
    if !agent.is_empty() {
        c = c.child(fact("Agent", agent, false));
    }
    c = c
        .child(fact("Created", created_label(&a.created_at), false))
        .child(fact("Size", size_label(a.size), false))
        .child(fact("Type", format!("{} · {}", kind_label(&a.kind), a.mime), false))
        .child(fact("Path", a.path.clone(), true));
    Some(col().key("artifact-inspector-scroll").w_full().h_full().min_h(0.0).scroll(ScrollSpec::default()).child(c))
}

pub fn toolbar(_s: &State, _cx: &mut Cx<State>, _t: &Tokens, _k: &Kit) -> Option<El> {
    None
}

pub fn on_key(s: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if ev.is_command('f') {
        tx.focus("artifacts-search", true);
        return true;
    }
    let step: isize = match ev.key {
        Key::Down => 1,
        Key::Up => -1,
        Key::Escape if s.artifacts.reading => {
            s.artifacts.reading = false;
            return true;
        }
        _ => return false,
    };
    let files = visible_files(s);
    if files.is_empty() {
        return false;
    }
    let at = s.artifacts.selected.as_ref().and_then(|sel| files.iter().position(|f| f == sel));
    let next = match at {
        Some(i) => (i as isize + step).clamp(0, files.len() as isize - 1) as usize,
        None => 0,
    };
    let (feature, id) = files[next].clone();
    let reading = s.artifacts.reading;
    select(s, &feature, &id, reading);
    tx.scroll_into_view(format!("artifact-{id}"));
    true
}

pub fn poll(_s: &mut State, _t: f64, _tx: &mut Tx) -> bool {
    false
}

// Fixture scenes.

fn fixture_artifact(id: &str, run: &str, stage: &str, path: &str, kind: &str, mime: &str, size: u64) -> RunArtifact {
    RunArtifact {
        id: id.into(),
        run_id: run.into(),
        stage_slug: stage.to_lowercase().replace(' ', "-"),
        stage_name: stage.into(),
        path: path.into(),
        kind: kind.into(),
        mime: mime.into(),
        size,
        created_at: "2026-11-27T06:30:54.000Z".into(),
    }
}

fn fixture_card(id: &str, title: &str, files: &[RunArtifact]) -> ProjectArtifactCard {
    let mut kinds: Vec<String> = Vec::new();
    for k in ["markdown", "mermaid", "image", "html", "file"] {
        if files.iter().any(|f| f.kind == k) {
            kinds.push(k.into());
        }
    }
    ProjectArtifactCard {
        feature_id: id.into(),
        title: title.into(),
        artifact_count: files.len() as u32,
        kinds,
        latest_created_at: files.first().map_or_else(String::new, |f| f.created_at.clone()),
        paths: files.iter().map(|f| f.path.clone()).collect(),
    }
}

const PLAN: &str = "# Retry failed webhook deliveries\n\n## What exists\n\nThe sender in `webhook/sender.ts` gives up after the first failure. \
A 5xx from the receiver is logged and dropped.\n\n<script>alert('raw html is dropped')</script>\n\n## Plan\n\n1. Retry 5xx and timeouts with \
exponential backoff, at most **five** attempts.\n2. Record each attempt on the delivery row.\n3. Leave 4xx alone: the receiver said no.\n\n\
| Attempt | Delay |\n|---|---|\n| 1 | 1 s |\n| 2 | 4 s |\n| 3 | 16 s |\n\n## Open questions\n\n- Should a delivery that exhausts its retries page anyone?\n";

fn fixture(s: &mut State) {
    crate::fixtures::board(s);
    s.screen = Screen::Artifacts;
    let webhooks = vec![
        fixture_artifact("a-plan", "run-webhooks-1", "Product investigation", "docs/bento/product-investigation.md", "markdown", "text/markdown", 1840),
        fixture_artifact("a-mock", "run-webhooks-1", "Product investigation", "artifacts/retry-settings.html", "html", "text/html", 12_288),
        fixture_artifact("a-shot", "run-webhooks-2", "Implementation", "artifacts/delivery-log.png", "image", "image/png", 48_211),
        fixture_artifact("a-log", "run-webhooks-2", "Implementation", "artifacts/test-run.txt", "file", "text/plain", 702),
        fixture_artifact("a-svg", "run-webhooks-2", "Implementation", "artifacts/flow.svg", "file", "application/octet-stream", 3310),
    ];
    let guide = vec![fixture_artifact("b-plan", "run-guide-1", "Product investigation", "docs/bento/product-investigation.md", "markdown", "text/markdown", 960)];
    let a = &mut s.artifacts;
    a.project = s.project.clone();
    a.cards = Load::Ready(vec![fixture_card("webhooks", "Retry failed webhook deliveries", &webhooks), fixture_card("contributing", "Add a CONTRIBUTING guide", &guide)]);
    a.files.insert("webhooks".into(), Load::Ready(webhooks));
    a.files.insert("contributing".into(), Load::Ready(guide));
    a.expanded.insert("webhooks".into());
    a.selected = Some(("webhooks".into(), "a-plan".into()));
    a.body = Some(("a-plan".into(), Load::Ready(Body::Text(PLAN.into()))));
    a.runs.insert("run-webhooks-1".into(), Load::Ready(RunInfo { status: RunStatus::Succeeded, agent: Some("Product Manager".into()) }));
    a.runs.insert("run-webhooks-2".into(), Load::Ready(RunInfo { status: RunStatus::Succeeded, agent: Some("Software Engineer".into()) }));
}

fn pick(s: &mut State, id: &str) {
    s.artifacts.selected = Some(("webhooks".into(), id.into()));
    s.artifacts.body = None;
}

pub const SCENES: &[Scene] = &[
    ("artifacts", fixture),
    ("artifacts/html", |s| {
        fixture(s);
        pick(s, "a-mock");
    }),
    ("artifacts/image", |s| {
        fixture(s);
        pick(s, "a-shot");
        let (w, h) = (480u32, 300u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[(x * 255 / w) as u8, 0x8a, (y * 255 / h) as u8, 0xff]);
            }
        }
        let cache = ImageCache::new(Arc::new(|| {}));
        let img = cache.rgba(w, h, rgba);
        let _ = img.wait();
        s.artifacts.body = Some(("a-shot".into(), Load::Ready(Body::Image(img))));
        s.artifacts.images = Some(cache);
    }),
    ("artifacts/text", |s| {
        fixture(s);
        pick(s, "a-log");
        s.artifacts.body = Some(("a-log".into(), Load::Ready(Body::Text("$ pnpm test webhook\n\n  sender retries a 503 five times  ok\n  sender leaves a 404 alone  ok\n\n2 passed\n".into()))));
    }),
    ("artifacts/file", |s| {
        fixture(s);
        pick(s, "a-svg");
    }),
    ("artifacts/search", |s| {
        fixture(s);
        s.artifacts.query = TextEdit::new("png");
    }),
    ("artifacts/no-match", |s| {
        fixture(s);
        s.artifacts.query = TextEdit::new("roadmap");
    }),
    ("artifacts/empty", |s| {
        fixture(s);
        s.artifacts = PageState { project: s.project.clone(), cards: Load::Ready(Vec::new()), ..PageState::default() };
    }),
    ("artifacts/loading", |s| {
        fixture(s);
        s.artifacts = PageState { project: s.project.clone(), ..PageState::default() };
    }),
    ("artifacts/error", |s| {
        fixture(s);
        s.artifacts = PageState {
            project: s.project.clone(),
            cards: Load::Failed { message: "connect ECONNREFUSED 127.0.0.1:4400".into(), missing: false },
            ..PageState::default()
        };
    }),
    ("artifacts/stacked", |s| {
        fixture(s);
        // Shown stacked only below STACK_BELOW: snap it with --size 900x600.
        s.artifacts.reading = true;
    }),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_the_console_writes_them() {
        let t = epoch("2026-11-27T06:30:54.000Z").unwrap();
        assert_eq!(t, 1_795_761_054);
        assert_eq!(updated_ago("2026-11-27T06:30:54.000Z", t + 30), "Updated just now");
        assert_eq!(updated_ago("2026-11-27T06:30:54.000Z", t + 5 * 60), "Updated 5m ago");
        assert_eq!(updated_ago("2026-11-27T06:30:54.000Z", t + 47 * 3600), "Updated 47h ago");
        assert_eq!(updated_ago("2026-11-27T06:30:54.000Z", t + 50 * 3600), "Updated 2d ago");
        assert_eq!(created_label("2026-11-27T06:30:54.000Z"), "Nov 27, 2026, 06:30 UTC");
    }

    #[test]
    fn labels_follow_the_console() {
        assert_eq!(kind_ext("file", Some("artifacts/flow.svg")), "SVG");
        assert_eq!(kind_ext("file", Some("artifacts/README")), "FILE");
        assert_eq!(kind_ext("markdown", Some("docs/plan.md")), "MD");
        assert_eq!(base_name("docs/bento/plan.md"), "plan.md");
        assert_eq!(size_label(702), "702 bytes");
        assert_eq!(size_label(48_211), "47.1 KB");
        assert_eq!(count_label(1), "1 artifact");
    }

    #[test]
    fn html_and_svg_are_never_fetched() {
        let a = |kind: &str, mime: &str| fixture_artifact("a", "r", "S", "x", kind, mime, 1);
        assert_eq!(fetches(&a("html", "text/html")), None);
        assert_eq!(fetches(&a("file", "application/octet-stream")), None);
        assert_eq!(fetches(&a("image", "image/png")), Some(true));
        assert_eq!(fetches(&a("markdown", "text/markdown")), Some(false));
        assert_eq!(fetches(&a("file", "text/plain")), Some(false));
    }

    #[test]
    fn search_keeps_titles_and_file_names() {
        let files = [fixture_artifact("a", "r", "S", "artifacts/shot.png", "image", "image/png", 1), fixture_artifact("b", "r", "S", "docs/plan.md", "markdown", "text/markdown", 1)];
        let cards = [fixture_card("f1", "Webhooks", &files), fixture_card("f2", "Guide", &files[1..])];
        let found = results(&cards, "png");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, ["shot.png"]);
        assert_eq!(results(&cards, "guide").len(), 1);
        assert_eq!(results(&cards, "").len(), 2);
        assert_eq!(shown_files(&cards[0], &files, "png").len(), 1);
        assert_eq!(shown_files(&cards[0], &files, "webhooks").len(), 2);
    }
}
