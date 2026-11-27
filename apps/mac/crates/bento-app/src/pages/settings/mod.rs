//! The Settings page: what a local person can set from this Mac. A section list on the left,
//! the chosen section at reading width on the right. Sections that live only in the console
//! open it in the browser.

mod agents;
mod fixtures;
mod local;
mod projects;

use bento_client::{AgentProfile, Feature, Health, Pipeline, Project, SavedSecret};
use rune::{Cx, El, KeyEvent, ScrollSpec, Tx, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, Dialog, Kit};

use crate::data;
use crate::pages::Scene;
use crate::state::{Screen, State};
use crate::theme::{self, Tokens, label};

pub const TITLE: &str = "Settings";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Section {
    #[default]
    Agents,
    Projects,
    Local,
    Appearance,
}

const SECTIONS: [(Section, &str, &str); 4] =
    [(Section::Agents, "agents", "Agents"), (Section::Projects, "projects", "Projects"), (Section::Local, "local", "Local Bento"), (Section::Appearance, "appearance", "Appearance")];

/// Console sections this page does not draw: (`?tab=`, label).
const IN_BROWSER: [(&str, &str); 5] = [("config", "Config"), ("providers", "Providers"), ("github", "GitHub"), ("linear", "Linear"), ("mcp", "MCP")];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Theme {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Default)]
pub enum Load<T> {
    #[default]
    Loading,
    Failed(String),
    Ready(T),
}

impl<T> From<Result<T, String>> for Load<T> {
    fn from(r: Result<T, String>) -> Self {
        match r {
            Ok(v) => Load::Ready(v),
            Err(e) => Load::Failed(e),
        }
    }
}

type Work = Box<dyn FnOnce(&bento_client::Client) -> Result<(), String> + Send>;

pub enum Pending {
    RemoveSecret(String),
    RemoveProfile(String),
    RemoveStage(String),
    Restart,
}

pub struct Confirm {
    pub title: String,
    pub description: String,
    pub label: &'static str,
    pub danger: bool,
    pub action: Pending,
}

#[derive(Clone, Copy)]
pub enum Reload {
    Secrets,
    Profiles,
    Pipeline,
}

#[derive(Default)]
pub struct PageState {
    pub section: Section,
    /// The server the page last loaded from; a restart brings a new one.
    loaded_for: Option<String>,
    pub busy: bool,
    pub open_select: Option<&'static str>,
    pub confirm: Option<Confirm>,
    pub beta: bool,
    pub theme: Theme,
    pub agents: agents::Agents,
    pub projects: projects::Projects,
    pub local: local::Local,
}

pub enum Msg {
    Secrets(Result<Vec<SavedSecret>, String>),
    Profiles(Result<Vec<AgentProfile>, String>),
    Projects(Result<Vec<Project>, String>),
    Pipeline { project: String, result: Result<(Pipeline, Vec<Feature>), String> },
    Cards { project: String, result: Result<usize, String> },
    Health(Result<Health, String>),
    Flags(bool),
    Saved { name: &'static str, result: Result<(), String> },
    Acted { reload: Reload, result: Result<(), String> },
    Renamed(Result<(), String>),
    ProjectRemoved(Result<String, String>),
    StageSaved(Result<(), String>),
    Active(Result<usize, String>),
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Secrets(r) => s.settings.agents.secrets = r.into(),
        Msg::Profiles(r) => s.settings.agents.profiles = r.into(),
        Msg::Projects(r) => projects::listed(s, r),
        Msg::Pipeline { project, result } => {
            if s.settings.projects.open.as_deref() == Some(&project) {
                s.settings.projects.pipeline = result.into();
            }
        }
        Msg::Cards { project, result } => {
            if let Some(r) = s.settings.projects.remove.as_mut().filter(|r| r.id == project) {
                r.cards = result.ok();
            }
        }
        Msg::Health(r) => s.settings.local.health = r.into(),
        Msg::Flags(beta) => s.settings.beta = beta,
        Msg::Saved { name, result } => agents::saved(s, name, result),
        Msg::Acted { reload, result } => {
            s.settings.busy = false;
            if let Err(e) = result {
                s.toast(e);
            }
            match reload {
                Reload::Secrets => agents::load_secrets(s),
                Reload::Profiles => {
                    agents::reload_profiles(s);
                    projects::load_pipeline(s);
                    data::refetch_board(s);
                }
                Reload::Pipeline => {
                    projects::load_pipeline(s);
                    data::refetch_board(s);
                }
            }
        }
        Msg::Renamed(result) => {
            s.settings.busy = false;
            match result {
                Ok(()) => {
                    s.settings.projects.rename = None;
                    projects::load(s);
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::ProjectRemoved(result) => {
            s.settings.busy = false;
            match result {
                Ok(note) => {
                    s.settings.projects.remove = None;
                    s.toast(note);
                    projects::load(s);
                }
                // Kept open: the usual refusal is an agent still working a card.
                Err(e) => s.toast(e),
            }
        }
        Msg::StageSaved(result) => {
            s.settings.busy = false;
            match result {
                Ok(()) => {
                    s.settings.projects.stage = None;
                    projects::load_pipeline(s);
                    data::refetch_board(s);
                }
                Err(e) => s.toast(e),
            }
        }
        Msg::Active(result) => local::checked(s, result),
    }
}

pub fn enter(s: &mut State) {
    let Some(base) = s.conn.base_url().map(str::to_owned) else { return };
    s.settings.loaded_for = Some(base);
    s.settings.busy = false;
    agents::enter(s);
    projects::enter(s);
    local::enter(s);
    s.conn.spawn(|c| Msg::Flags(c.flags().is_ok_and(|f| f.beta_testers)));
}

pub fn leave(s: &mut State) {
    s.settings.open_select = None;
}

/// The page is already showing when a restart brings a new server, so it loads again here.
pub fn poll(s: &mut State, _t: f64, _tx: &mut Tx) -> bool {
    if s.screen != Screen::Settings || s.conn.base_url().is_none() || s.conn.base_url() == s.settings.loaded_for.as_deref() {
        return false;
    }
    enter(s);
    true
}

pub fn on_key(_s: &mut State, _ev: &KeyEvent, _tx: &mut Tx) -> bool {
    false
}

pub fn inspector(_s: &State, _cx: &mut Cx<State>, _t: &Tokens, _k: &Kit, _layer: &mut Vec<El>) -> Option<El> {
    None
}

pub fn toolbar(_s: &State, _cx: &mut Cx<State>, _t: &Tokens, _k: &Kit) -> Option<El> {
    None
}

/// The window's palette: the person's choice here, else the system's.
pub fn dark(s: &State, system: bool) -> bool {
    match s.settings.theme {
        Theme::System => system,
        Theme::Dark => true,
        Theme::Light => false,
    }
}

fn appearance_file() -> std::path::PathBuf {
    data::data_dir().join("mac-app").join("appearance")
}

pub fn load_appearance(s: &mut State) {
    s.settings.theme = match std::fs::read_to_string(appearance_file()).as_deref().map(str::trim) {
        Ok("dark") => Theme::Dark,
        Ok("light") => Theme::Light,
        _ => Theme::System,
    };
}

fn choose_theme(s: &mut State, theme: Theme) {
    s.settings.theme = theme;
    let path = appearance_file();
    let result = match theme {
        Theme::System => std::fs::remove_file(&path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
        Theme::Dark | Theme::Light => {
            path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&path, if theme == Theme::Dark { "dark" } else { "light" }))
        }
    };
    if let Err(e) = result {
        s.toast(e.to_string());
    }
}

/// What the sidecar is started with, over this process's environment.
pub fn sidecar_env() -> Vec<(String, String)> {
    local::saved()
}

pub fn toggle_select(s: &mut State, id: &'static str) {
    s.settings.open_select = if s.settings.open_select == Some(id) { None } else { Some(id) };
}

pub fn heading(title: &str, description: &str, t: &Tokens) -> El {
    col()
        .key("settings-heading")
        .w_full()
        .gap(4.0)
        .pb(2.0)
        .child(label(title.to_owned(), 17.0, 600.0, t.text))
        .child(label(description.to_owned(), 12.5, 400.0, t.dim).wrap())
}

pub fn panel(key: &str, t: &Tokens) -> El {
    col().key(key.to_owned()).w_full().padding(16.0).gap(12.0).radius(10.0).fill(t.panel).border(1.0, t.line)
}

pub fn title_row(title: &str, trailing: Option<El>, t: &Tokens) -> El {
    let r = row().w_full().gap(10.0).center_y().child(label(title.to_owned(), 13.5, 600.0, t.text).truncate().shrink()).child(spacer());
    match trailing {
        Some(e) => r.child(e),
        None => r,
    }
}

pub fn note(text: impl Into<String>, t: &Tokens) -> El {
    label(text, 12.0, 400.0, t.faint).wrap()
}

pub fn state_line(text: &str, t: &Tokens) -> El {
    label(text.to_owned(), 12.5, 400.0, t.faint).key("settings-state")
}

pub fn line(t: &Tokens) -> El {
    el().w_full().h(1.0).fill(t.line)
}

pub fn view(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let body = match s.settings.section {
        Section::Agents => agents::view(s, t, k),
        Section::Projects => projects::view(s, t, k, layer),
        Section::Local => local::view(s, t, k, layer),
        Section::Appearance => appearance(s, t),
    };
    confirm(s, k, layer);
    let content = col().key("settings-content").w_full().max_w(680.0).px(28.0).py(22.0).gap(14.0).child(body);
    row()
        .key("settings")
        .w_full()
        .h_full()
        .child(nav(s, t))
        .child(el().w(1.0).h_full().fill(t.line))
        .child(col().key("settings-scroll").grow(1.0).shrink().min_w(0.0).h_full().scroll(ScrollSpec::default()).child(content))
}

fn nav_row(key: String, name: &str, on: bool, detail: Option<&str>, t: &Tokens) -> El {
    let mut r = row()
        .key(key)
        .w_full()
        .h(30.0)
        .px(10.0)
        .gap(8.0)
        .radius(7.0)
        .center_y()
        .role("tab")
        .label(name.to_owned())
        .focusable(true)
        .child(label(name.to_owned(), 13.0, if on { 550.0 } else { 450.0 }, if on { t.text } else { t.dim }).truncate().shrink())
        .child(spacer());
    if let Some(d) = detail {
        r = r.child(label(d.to_owned(), 11.5, 400.0, t.faint));
    }
    if on { r.fill(t.raised) } else { r }
}

fn nav(s: &State, t: &Tokens) -> El {
    let mut n = col().key("settings-nav").w(196.0).h_full().padding(12.0).gap(2.0);
    for (section, id, name) in SECTIONS {
        n = n.child(nav_row(format!("settings-nav-{id}"), name, s.settings.section == section, None, t).on_press(move |s: &mut State| {
            s.settings.section = section;
            s.settings.open_select = None;
        }));
    }
    n = n.child(el().key("settings-nav-browser").pt(18.0).pb(6.0).px(10.0).child(label("IN THE BROWSER", 11.0, 500.0, t.faint)));
    for (tab, name) in IN_BROWSER {
        // Providers is a beta section in the console, absent there without it.
        if tab == "providers" && !s.settings.beta {
            continue;
        }
        n = n.child(nav_row(format!("settings-nav-{tab}"), name, false, Some("↗"), t).on_press_tx(move |s: &mut State, tx: &mut Tx| {
            let Some(base) = s.conn.base_url() else { return };
            if let Err(e) = tx.open_url(&format!("{base}/settings?tab={tab}")) {
                s.toast(e.to_string());
            }
        }));
    }
    n
}

fn confirm(s: &State, k: &Kit, layer: &mut Vec<El>) {
    let Some(c) = &s.settings.confirm else { return };
    let busy = s.settings.busy;
    let go = |s: &mut State, _: &mut Tx| {
        let Some(c) = s.settings.confirm.take() else { return };
        let spawn = |s: &mut State, reload: Reload, work: Work| {
            s.settings.busy = true;
            if !s.conn.spawn(move |c| Msg::Acted { reload, result: work(&c) }) {
                s.settings.busy = false;
            }
        };
        match c.action {
            Pending::RemoveSecret(id) => spawn(s, Reload::Secrets, Box::new(move |c| c.delete_secret(&id).map_err(data::err))),
            Pending::RemoveProfile(id) => spawn(s, Reload::Profiles, Box::new(move |c| c.delete_profile(&id).map(drop).map_err(data::err))),
            Pending::RemoveStage(id) => spawn(s, Reload::Pipeline, Box::new(move |c| c.delete_stage(&id).map_err(data::err))),
            Pending::Restart => local::check_and_restart(s),
        }
    };
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(|s: &mut State| s.settings.confirm = None).build(k).key("confirm-cancel"))
        .child(
            Button::new(c.label)
                .variant(if c.danger { ButtonVariant::Danger } else { ButtonVariant::Contrast })
                .disabled(busy)
                .on_press_tx(go)
                .build(k)
                .key("confirm-ok"),
        );
    Dialog::new("settings-confirm", c.title.clone())
        .description(c.description.clone())
        .width(440.0)
        .fit()
        .open(true)
        .close_disabled(busy)
        .on_close(|s: &mut State| s.settings.confirm = None)
        .child(buttons)
        .build(k, layer);
}

fn appearance(s: &State, t: &Tokens) -> El {
    let mut options = row().key("themes").w_full().gap(12.0).flex_wrap();
    for (theme, id, name) in [(Theme::System, "system", "System"), (Theme::Dark, "dark", "Dark"), (Theme::Light, "light", "Light")] {
        let on = s.settings.theme == theme;
        options = options.child(
            col()
                .key(format!("theme-{id}"))
                .w(150.0)
                .gap(8.0)
                .padding(8.0)
                .radius(10.0)
                .border(if on { 2.0 } else { 1.0 }, if on { t.brand } else { t.line })
                .role("radio")
                .label(name.to_owned())
                .focusable(true)
                .on_press(move |s: &mut State| choose_theme(s, theme))
                .child(preview(theme))
                .child(row().w_full().px(2.0).child(label(name.to_owned(), 12.5, if on { 600.0 } else { 450.0 }, t.text)).child(spacer()).child(label(if on { "✓" } else { "" }, 12.0, 600.0, t.text))),
        );
    }
    col().w_full().gap(14.0).child(heading("Appearance", "Make this workspace feel like yours.", t)).child(
        panel("appearance-theme", t)
            .child(title_row("Theme", None, t))
            .child(note("Choose a palette, or follow your device's appearance.", t))
            .child(options),
    )
}

/// A small drawing of the window in a palette; System is split down the middle.
fn preview(theme: Theme) -> El {
    let half = |dark: bool| {
        let p = theme::tokens(dark);
        let nav = col().w(26.0).h_full().padding(5.0).gap(4.0).fill(p.panel);
        let nav = (0..3).fold(nav, |n, _| n.child(el().w_full().h(4.0).radius(2.0).fill(p.line)));
        let board = row()
            .grow(1.0)
            .h_full()
            .padding(6.0)
            .gap(5.0)
            .fill(p.bg);
        let board = (0..3).fold(board, |b, i| {
            b.child(col().grow(1.0).gap(4.0).child(el().w_full().h(18.0).radius(3.0).fill(p.raised).border(1.0, p.line)).child(el().w_full().h(10.0 + 4.0 * i as f32).radius(3.0).fill(p.raised)))
        });
        row().grow(1.0).h_full().child(nav).child(board)
    };
    let frame = row().w_full().h(72.0).radius(6.0).clip_rounded(6.0);
    match theme {
        Theme::System => frame.child(half(true)).child(half(false)),
        Theme::Dark => frame.child(half(true)),
        Theme::Light => frame.child(half(false)),
    }
}

pub const SCENES: &[Scene] = &[
    ("settings", fixtures::agents),
    ("settings/projects", fixtures::projects),
    ("settings/project", fixtures::project),
    ("settings/stage", fixtures::stage),
    ("settings/remove-project", fixtures::remove_project),
    ("settings/local", fixtures::local),
    ("settings/local-changed", fixtures::local_changed),
    ("settings/appearance", fixtures::appearance),
    ("settings/loading", fixtures::loading),
    ("settings/failed", fixtures::failed),
    ("settings/no-projects", fixtures::no_projects),
];
