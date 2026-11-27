//! While the local server starts, and when it could not.

use rune::{Align, El, Tx, col, el};
use rune_kit::{Button, ButtonVariant, Kit};

use crate::data;
use crate::metal::{self, orb};
use crate::state::State;
use crate::theme::{Tokens, label};

pub fn starting(message: &str, t: &Tokens) -> El {
    frame(t)
        .child(orb(metal::CHROME, 1.0, 44.0).key("boot-orb"))
        .child(label("Bento", 20.0, 600.0, t.text))
        .child(label(message.to_owned(), 13.0, 400.0, t.dim).key("boot-progress").wrap().align(Align::Center).max_w(420.0))
}

pub fn failed(message: &str, t: &Tokens, k: &Kit) -> El {
    frame(t)
        .child(orb(metal::GUNMETAL, 0.0, 44.0))
        .child(label("Bento could not start", 20.0, 600.0, t.text))
        .child(label(message.to_owned(), 13.0, 400.0, t.dim).key("boot-error").wrap().align(Align::Center).max_w(480.0).selectable(true))
        .child(
            Button::new("Try again")
                .variant(ButtonVariant::Neutral)
                .on_press_tx(|s: &mut State, _: &mut Tx| data::boot(s))
                .build(k)
                .key("boot-retry"),
        )
}

fn frame(t: &Tokens) -> El {
    col().key("boot").w_full().h_full().fill(t.bg).center().gap(14.0).window_drag().child(el().h(0.0))
}
