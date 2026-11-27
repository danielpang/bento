//! The pages beside the board. Each lives in its own module with the same surface (`PageState`,
//! `Msg`, `apply`, `enter`, `leave`, `view`, `inspector`, `toolbar`, `on_key`, `poll`, `SCENES`);
//! this file only routes to the one showing.

pub mod analytics;
pub mod artifacts;
pub mod sessions;
pub mod settings;
pub mod swarms;

use rune::{Cx, El, KeyEvent, Tx};
use rune_kit::Kit;

use crate::data;
use crate::state::{Screen, State};
use crate::theme::Tokens;

pub type Scene = (&'static str, fn(&mut State));

pub fn scenes() -> impl Iterator<Item = Scene> {
    [sessions::SCENES, artifacts::SCENES, swarms::SCENES, analytics::SCENES, settings::SCENES].into_iter().flatten().copied()
}

/// Switches screens: the old page leaves and its streams close, then the new page enters.
pub fn show(s: &mut State, screen: Screen) {
    if s.screen == screen {
        return;
    }
    let old = s.screen;
    match old {
        Screen::Board => {}
        Screen::Sessions => sessions::leave(s),
        Screen::Artifacts => artifacts::leave(s),
        Screen::Swarms => swarms::leave(s),
        Screen::Analytics => analytics::leave(s),
        Screen::Settings => settings::leave(s),
    }
    s.conn.release(old, None);
    s.screen = screen;
    enter(s);
}

/// The open project changed: the showing page's streams close and it enters again.
pub fn project_changed(s: &mut State) {
    s.conn.release(s.screen, None);
    enter(s);
}

fn enter(s: &mut State) {
    match s.screen {
        Screen::Board => {}
        Screen::Sessions => sessions::enter(s),
        Screen::Artifacts => artifacts::enter(s),
        Screen::Swarms => swarms::enter(s),
        Screen::Analytics => analytics::enter(s),
        Screen::Settings => settings::enter(s),
    }
}

pub fn apply(s: &mut State, m: data::Msg) {
    match m {
        data::Msg::Sessions(m) => sessions::apply(s, m),
        data::Msg::Artifacts(m) => artifacts::apply(s, m),
        data::Msg::Swarms(m) => swarms::apply(s, m),
        data::Msg::Analytics(m) => analytics::apply(s, m),
        data::Msg::Settings(m) => settings::apply(s, m),
        _ => {}
    }
}

/// The main pane of a page; the board is drawn by `screens`.
pub fn view(s: &State, cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    match s.screen {
        Screen::Board => rune::el(),
        Screen::Sessions => sessions::view(s, cx, t, k, layer),
        Screen::Artifacts => artifacts::view(s, cx, t, k, layer),
        Screen::Swarms => swarms::view(s, cx, t, k, layer),
        Screen::Analytics => analytics::view(s, cx, t, k, layer),
        Screen::Settings => settings::view(s, cx, t, k, layer),
    }
}

pub fn inspector(s: &State, cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> Option<El> {
    match s.screen {
        Screen::Board => None,
        Screen::Sessions => sessions::inspector(s, cx, t, k, layer),
        Screen::Artifacts => artifacts::inspector(s, cx, t, k, layer),
        Screen::Swarms => swarms::inspector(s, cx, t, k, layer),
        Screen::Analytics => analytics::inspector(s, cx, t, k, layer),
        Screen::Settings => settings::inspector(s, cx, t, k, layer),
    }
}

pub fn toolbar(s: &State, cx: &mut Cx<State>, t: &Tokens, k: &Kit) -> Option<El> {
    match s.screen {
        Screen::Board => None,
        Screen::Sessions => sessions::toolbar(s, cx, t, k),
        Screen::Artifacts => artifacts::toolbar(s, cx, t, k),
        Screen::Swarms => swarms::toolbar(s, cx, t, k),
        Screen::Analytics => analytics::toolbar(s, cx, t, k),
        Screen::Settings => settings::toolbar(s, cx, t, k),
    }
}

pub fn on_key(s: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    match s.screen {
        Screen::Board => false,
        Screen::Sessions => sessions::on_key(s, ev, tx),
        Screen::Artifacts => artifacts::on_key(s, ev, tx),
        Screen::Swarms => swarms::on_key(s, ev, tx),
        Screen::Analytics => analytics::on_key(s, ev, tx),
        Screen::Settings => settings::on_key(s, ev, tx),
    }
}

/// Every page polls, showing or not, so a timer can outlive a switch if its page wants it to.
pub fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    let a = sessions::poll(s, t, tx);
    let b = artifacts::poll(s, t, tx);
    let c = swarms::poll(s, t, tx);
    let d = analytics::poll(s, t, tx);
    let e = settings::poll(s, t, tx);
    a || b || c || d || e
}
