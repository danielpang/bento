//! Small pieces several screens use: the metal key, the status pill, section labels.

use rune::{El, Tx, el, row};

use crate::metal::{self, face};
use crate::model::Status;
use crate::state::State;
use crate::theme::{Tokens, label};

/// The one primary action in a view: a domed metal key. `None` draws it disabled.
pub fn key(name: &str, material: u32, t: &Tokens, on_press: Option<impl Fn(&mut State, &mut Tx) + 'static>) -> El {
    let k = row()
        .h(30.0)
        .px(14.0)
        .radius(9.0)
        .center()
        .role("button")
        .label(name)
        .child(face(material, 0.0, 9.0))
        .child(label(name.to_owned(), 13.0, 600.0, t.on_brand));
    match on_press {
        Some(f) => k.focusable(true).on_press_tx(f),
        None => k.opacity(0.45),
    }
}

pub fn status_color(st: Status, t: &Tokens) -> rune::color::Color {
    match st {
        Status::Idle => t.idle,
        Status::Running => t.running,
        Status::Gated => t.gated,
        Status::Failed => t.failed,
        Status::Succeeded => t.succeeded,
    }
}

pub fn status(st: Status, t: &Tokens) -> El {
    row()
        .h(20.0)
        .px(8.0)
        .gap(6.0)
        .radius(10.0)
        .center_y()
        .border(1.0, t.line)
        .child(el().size(7.0, 7.0).radius(3.5).fill(status_color(st, t)))
        .child(label(st.word(), 11.0, 450.0, t.dim))
}

/// The material and flow that say what a card is doing.
pub fn metal_of(st: Status) -> (u32, f32) {
    match st {
        Status::Running => (metal::CHROME, 1.0),
        Status::Gated => (metal::GOLD, 0.0),
        _ => (metal::GUNMETAL, 0.0),
    }
}

pub fn section(name: &str, t: &Tokens) -> El {
    el().key(format!("section-{name}")).pt(18.0).pb(6.0).px(10.0).child(label(name.to_uppercase(), 11.0, 500.0, t.faint))
}
