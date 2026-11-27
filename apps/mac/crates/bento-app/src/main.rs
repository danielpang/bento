//! Bento for Mac. `cargo run` starts the local server (the sidecar) and shows its board;
//! `-- --snap board.png --scene board` renders a fixture scene headless with no server.

mod data;
mod fixtures;
mod instance;
mod metal;
mod model;
mod pages;
mod screens;
mod shell_env;
mod sidecar;
mod state;
mod theme;

use std::time::Duration;

use rune::{AppSpec, Chrome, KeyEvent, MenuItem, Shortcut, Tx, Waker};
use rune_kit::shell;

use state::{NewCard, Phase, Screen, State};

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
    let carded = screens::card::poll(s, t, tx);
    changed || aged || paged || carded
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
    ("boot-cancelled", boot_cancelled),
];

fn boot_cancelled(s: &mut State) {
    s.phase = Phase::Failed(sidecar::CANCELLED.into());
}

fn chord(keys: &str) -> Shortcut {
    keys.parse().expect("a valid shortcut")
}

fn go(screen: Screen) -> impl Fn(&mut State, &mut Tx) + Send + Sync + 'static {
    move |s, _| {
        if s.phase == Phase::Ready {
            pages::show(s, screen);
        }
    }
}

fn new_card(s: &mut State, _: &mut Tx) {
    if s.phase == Phase::Ready && s.project.is_some() {
        pages::show(s, Screen::Board);
        s.new_card = Some(NewCard::new());
    }
}

/// The menu bar beside winit's app menu (About, Hide, Quit ⌘Q) and the standard Edit and
/// Window menus (Close ⌘W). The View items are the sidebar's pages in its order, then Settings.
fn menus() -> Vec<MenuItem<State>> {
    let pages = [
        (Screen::Board, "Board"),
        (Screen::Sessions, "Sessions"),
        (Screen::Artifacts, "Artifacts"),
        (Screen::Swarms, "Swarms"),
        (Screen::Analytics, "Analytics"),
        (Screen::Settings, "Settings"),
    ];
    let mut items = vec![
        MenuItem::separator(),
        MenuItem::with_action("Settings…", go(Screen::Settings)).id("app-settings").key_equivalent(chord("cmd+comma")),
        MenuItem::new("New Card", new_card).menu("File").key_equivalent(chord("cmd+n")),
    ];
    for (n, (screen, name)) in pages.into_iter().enumerate() {
        items.push(MenuItem::with_action(name, go(screen)).id(format!("view-{name}")).menu("View").key_equivalent(chord(&format!("cmd+{}", n + 1))));
    }
    items
}

/// The app starts a server of its own: not attached to one, and a window rather than a
/// headless snapshot (`--realtime` boots the real server headless too).
fn starts_server() -> bool {
    let attached = std::env::var("BENTO_SERVER_URL").is_ok_and(|u| !u.trim().is_empty());
    !attached && (!rune::is_headless() || std::env::args().any(|a| a == "--realtime"))
}

fn main() {
    let mut instance = None;
    if starts_server() {
        match instance::claim(&data::data_dir()) {
            instance::Claim::First(i) => instance = Some(i),
            instance::Claim::Running => {
                eprintln!("Bento is already open on {}, and was brought forward.", data::data_dir().display());
                return;
            }
            instance::Claim::Stuck => {
                eprintln!("Another Bento holds {} and is not answering.", data::data_dir().display());
                std::process::exit(1);
            }
        }
        shell_env::warm();
    }
    let chrome = Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true };
    let mut app = rune::App::new(AppSpec {
        on_key: Some(on_key),
        setup: Some(setup),
        poll: Some(poll),
        min_size: Some((900.0, 600.0)),
        scenes: SCENES
            .iter()
            .copied()
            .chain(pages::scenes())
            .chain(screens::card::SCENES.iter().copied())
            .chain(screens::drawer::SCENES.iter().copied())
            .collect::<Vec<_>>()
            .leak(),
        ..AppSpec::new("Bento", (1440.0, 900.0), State::new, screens::view)
    });
    for item in menus() {
        app = app.menu_item(item);
    }
    if let Some(i) = instance.as_mut() {
        let handle = app.handle();
        i.listen(move || handle.open());
    }
    let handle = app.handle();
    // Closing the window hides it and leaves the server and its agents working; the Dock icon
    // brings it back, and Quit stops the server.
    app.keep_running()
        .standard_menus()
        .chrome(chrome)
        .compositor(metal::Metal::default())
        .on_quit(on_quit)
        // The server starts after the first frame, so the window shows at once.
        .on_ready(move |_| handle.update(|s, _| data::start_once(s)))
        .run();
    drop(instance);
}

#[cfg(test)]
mod tests {
    #[test]
    fn menus_build() {
        assert_eq!(super::menus().len(), 9);
    }
}
