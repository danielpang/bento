//! The New card dialog.

use rune::{El, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Dialog, Field, Kit, TextArea, TextInput};

use crate::data;
use crate::state::State;
use crate::theme::{Tokens, label};

pub fn dialog(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let Some(form) = &s.new_card else { return };
    let submit = |s: &mut State, _: &mut Tx| data::create_card(s);
    let title = Field::new()
        .label("Title")
        .control(
            TextInput::new(&form.title)
                .label("Title")
                .placeholder("Add a rate limit to the public API")
                .width(None)
                .on_edit(|s: &mut State| &mut s.new_card.as_mut().expect("the dialog is open").title)
                .on_submit(submit)
                .build(k)
                .key("new-card-title"),
        )
        .build(k);
    let description = Field::new()
        .label("Description")
        .control(
            TextArea::new(&form.description)
                .label("Description")
                .placeholder("What should exist when this is done? Anything the agent should know: the endpoints involved, the limits, what to leave alone.")
                .width(None)
                .rows(5)
                .on_edit(|s: &mut State| &mut s.new_card.as_mut().expect("the dialog is open").description)
                .on_submit(submit)
                .build(k)
                .key("new-card-description"),
        )
        .build(k);
    let ready = !form.title.text.trim().is_empty() && !form.busy;
    let mut body = col().w_full().px(16.0).gap(14.0).child(title).child(description);
    if let Some(e) = &form.error {
        body = body.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().key("new-card-error"));
    }
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(form.busy).on_press(|s: &mut State| s.new_card = None).build(k).key("new-card-cancel"))
        .child(Button::new("Add").variant(ButtonVariant::Contrast).disabled(!ready).on_press_tx(submit).build(k).key("new-card-add"));
    Dialog::new("new-card", "New card")
        .description("A short title for the board, and the detail the agents work from.")
        .width(480.0)
        .fit()
        .open(true)
        .close_disabled(form.busy)
        .on_close(|s: &mut State| s.new_card = None)
        .child(body)
        .child(buttons)
        .build(k, layer);
}
