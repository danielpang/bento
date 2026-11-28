//! No projects yet: make one from a folder.

use rune::{Align, El, Tx, col};

use crate::data;
use crate::metal;
use crate::screens::parts::key;
use crate::state::State;
use crate::theme::{Tokens, label};

pub fn no_projects(s: &State, t: &Tokens) -> El {
    let press: Option<fn(&mut State, &mut Tx)> = if s.creating_project { None } else { Some(|_, tx| data::choose_folder(tx)) };
    col()
        .key("empty")
        .w_full()
        .h_full()
        .center()
        .gap(12.0)
        .child(label("New project", 18.0, 600.0, t.text))
        .child(
            label("Point Bento at a git repository on this machine.", 13.0, 400.0, t.dim)
                .wrap()
                .align(Align::Center)
                .max_w(380.0),
        )
        .child(key("Choose a folder", metal::KEY, t, press).key("choose-folder"))
}
