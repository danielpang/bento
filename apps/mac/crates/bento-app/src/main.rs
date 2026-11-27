//! Bento for Mac. `cargo run` starts the local server (the sidecar) and shows its board;
//! `-- --snap board.png --scene board` renders a fixture scene headless with no server.

mod data;
mod fixtures;
mod metal;
mod model;
mod pages;
mod screens;
mod sidecar;
mod state;
mod theme;

use std::time::Duration;

use rune::{AppSpec, Chrome, KeyEvent, Tx, Waker};
use rune_kit::shell;

use state::State;

fn on_key(s: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    if ev.is_command(',') && s.phase == state::Phase::Ready {
        pages::show(s, state::Screen::Settings);
        return true;
    }
    if ev.is_command('i') && ev.mods.alt {
        s.inspector.toggle();
        return true;
    }
    if ev.key == rune::Key::Escape && s.screen == state::Screen::Board && s.new_card.is_none() && s.selected.is_some() {
        s.selected = None;
        return true;
    }
    pages::on_key(s, ev, tx)
}

fn setup(s: &mut State, waker: Waker) {
    s.conn.set_waker(waker);
}

fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    let changed = data::drain(s);
    let (aged, next) = s.age_toasts(t);
    if let Some(next) = next {
        tx.wake_after(Duration::from_secs_f64(next.max(0.05)));
    }
    let paged = pages::poll(s, t, tx);
    changed || aged || paged
}

fn on_quit(s: &mut State, _: &mut Tx) {
    s.conn.shutdown();
}

const SCENES: &[pages::Scene] = &[
    ("board", fixtures::board),
    ("no-inspector", fixtures::no_inspector),
    ("gated", fixtures::gated),
    ("boot", fixtures::boot),
    ("boot-failed", fixtures::boot_failed),
    ("empty", fixtures::empty),
    ("new-card", fixtures::new_card),
];

fn main() {
    let chrome = Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true };
    let app = rune::App::new(AppSpec {
        on_key: Some(on_key),
        setup: Some(setup),
        poll: Some(poll),
        min_size: Some((900.0, 600.0)),
        scenes: SCENES.iter().copied().chain(pages::scenes()).collect::<Vec<_>>().leak(),
        ..AppSpec::new("Bento", (1440.0, 900.0), State::new, screens::view)
    });
    let handle = app.handle();
    app.chrome(chrome)
        .compositor(metal::Metal::default())
        .on_quit(on_quit)
        // The server starts after the first frame, so the window shows at once.
        .on_ready(move |_| handle.update(|s, _| data::start_once(s)))
        .run();
}
