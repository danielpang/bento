//! The window: the boot screen until the server is up, then sidebar, main pane and inspector.

mod board;
mod boot;
pub(crate) mod card;
pub(crate) mod drawer;
mod empty;
pub(crate) mod inspector;
pub(crate) mod new_card;
pub(crate) mod parts;
mod sidebar;

use rune::{Cx, El, Tx};
use rune_kit::shell::{SplitView, Toolbar};
use rune_kit::{Kit, Toast, ToastRegion};

use crate::metal;
use crate::pages;
use crate::state::{NewCard, Phase, Screen, State};
use crate::theme::{self, Tokens};

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let t = theme::tokens(pages::settings::dark(s, cx.system_dark()));
    let k = theme::kit(&t);
    let mut layer = Vec::new();
    let base = match &s.phase {
        Phase::Booting(message) => boot::starting(message, &t, &k),
        Phase::Failed(message) => boot::failed(message, &t, &k),
        Phase::Ready => shell(s, cx, &t, &k, &mut layer),
    };
    if !s.toasts.is_empty() {
        let region = s.toasts.iter().fold(ToastRegion::new(), |r, toast| {
            let id = toast.id;
            r.toast(Toast::new(format!("toast-{id}"), toast.text.clone()).on_close(move |s: &mut State| s.dismiss(id)).build(&k))
        });
        layer.push(region.build(&k));
    }
    rune_kit::root(base, layer)
}

fn shell(s: &State, cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let title = sidebar::NAV.iter().find(|(screen, _)| *screen == s.screen).map_or(pages::settings::TITLE, |(_, name)| name);
    let can_add = s.project.is_some() && s.screen == Screen::Board;
    let open_dialog: fn(&mut State, &mut Tx) = |s, _| s.new_card = Some(NewCard::new());
    let open = can_add.then_some(open_dialog);
    let mut toolbar = Toolbar::new().title(title);
    if s.project.is_some() && s.screen == Screen::Board {
        toolbar = toolbar.trailing(parts::key("New card", metal::KEY, t, open).key("new-card"));
    }
    if let Some(trailing) = pages::toolbar(s, cx, t, k) {
        toolbar = toolbar.trailing(trailing);
    }
    let main = if s.projects.is_empty() && s.screen != Screen::Settings {
        empty::no_projects(s, t)
    } else {
        match s.screen {
            Screen::Board => board::board(s, t),
            _ => pages::view(s, cx, t, k, layer),
        }
    };
    let side = match s.screen {
        Screen::Board => s.selected.as_deref().and_then(|id| s.card(id)).map(|_| inspector::inspector(s, t, k)),
        _ => pages::inspector(s, cx, t, k, layer),
    };
    new_card::dialog(s, t, k, layer);
    card::dialogs(s, t, k, layer);
    let mut split = SplitView::new(main).sidebar(&s.sidebar, |s: &mut State| &mut s.sidebar, sidebar::sidebar(s, t, k));
    if let Some(side) = side {
        split = split.inspector(&s.inspector, |s: &mut State| &mut s.inspector, side);
    }
    split
        .toolbar(toolbar)
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .sidebar_padding(18.0, 10.0)
        .reduced_motion(cx.is_reduced_motion())
        .build(k)
}
