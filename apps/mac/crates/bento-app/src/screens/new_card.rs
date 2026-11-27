//! The New card dialog: add the card to the backlog, or start an agent on it now.

use bento_client::{NewSession, StartedSession};
use rune::{El, TextEdit, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, Dialog, Field, Kit, Select, Switch, TextArea, TextInput};

use crate::data::{self, err};
use crate::pages::sessions::{HARNESSES, starting_model};
use crate::screens::card::{Msg, StartNow};
use crate::state::State;
use crate::theme::{Tokens, label};

fn start_now(s: &mut State) -> &mut StartNow {
    &mut s.card.start_now
}

fn ready(s: &State) -> bool {
    let Some(form) = &s.new_card else { return false };
    let now = &s.card.start_now;
    !form.busy && !form.title.text.trim().is_empty() && (!now.on || !now.model.text.trim().is_empty())
}

fn submit(s: &mut State) {
    if !s.card.start_now.on {
        data::create_card(s);
        return;
    }
    let (Some(project), true) = (s.project.clone(), ready(s)) else { return };
    let Some(form) = s.new_card.as_mut() else { return };
    let title = form.title.text.trim().to_owned();
    let description = form.description.text.trim().to_owned();
    form.busy = true;
    form.error = None;
    let now = &s.card.start_now;
    // The agent works from the detail; a card with only a title is asked its title.
    let prompt = if description.is_empty() { title.clone() } else { description };
    let input = NewSession { cli: now.cli.to_owned(), model: now.model.text.trim().to_owned(), prompt, title: Some(title) };
    if !s.conn.spawn(move |c| Msg::SessionStarted(c.start_session(&project, &input).map_err(err)))
        && let Some(form) = s.new_card.as_mut()
    {
        form.busy = false;
    }
}

pub fn session_started(s: &mut State, result: Result<StartedSession, String>) {
    match result {
        Ok(started) => {
            s.new_card = None;
            data::refetch_board(s);
            data::select_card(s, &started.feature_id);
        }
        Err(e) => {
            if let Some(form) = s.new_card.as_mut() {
                form.busy = false;
                form.error = Some(e);
            }
        }
    }
}

fn pick_harness(s: &mut State, name: &str) {
    let now = start_now(s);
    now.harness_open = false;
    if let Some(h) = HARNESSES.iter().find(|h| h.1 == name) {
        now.cli = h.0;
        now.model = TextEdit::new(starting_model(h.0, None));
    }
}

pub fn dialog(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let Some(form) = &s.new_card else { return };
    let go = |s: &mut State, _: &mut Tx| submit(s);
    let title = Field::new()
        .label("Title")
        .control(
            TextInput::new(&form.title)
                .label("Title")
                .placeholder("Add a rate limit to the public API")
                .width(None)
                .on_edit(|s: &mut State| &mut s.new_card.as_mut().expect("the dialog is open").title)
                .on_submit(go)
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
                .on_submit(go)
                .build(k)
                .key("new-card-description"),
        )
        .build(k);
    let now = &s.card.start_now;
    let switch = Switch::new(now.on)
        .label("Start agent now")
        .description(if now.on { "The agent starts as soon as the card is added" } else { "The card waits in the backlog" })
        .disabled(form.busy)
        .on_toggle(|s: &mut State| start_now(s).on = !start_now(s).on)
        .build(k)
        .key("new-card-start-now");
    let mut body = col().w_full().px(16.0).gap(14.0).child(title).child(description).child(switch);
    // The harness menu opens over the dialog, so it joins the layer after it.
    let mut menus = Vec::new();
    if now.on {
        let labels: Vec<&str> = HARNESSES.iter().map(|h| h.1).collect();
        let current = HARNESSES.iter().find(|h| h.0 == now.cli).map_or(now.cli, |h| h.1);
        let harness = Select::new("new-card-harness", &labels)
            .label("Harness")
            .current(Some(current))
            .open(now.harness_open)
            .width(190.0)
            .disabled(form.busy)
            .on_toggle(|s: &mut State| start_now(s).harness_open = !start_now(s).harness_open)
            .on_close(|s: &mut State| start_now(s).harness_open = false)
            .on_choose(|s: &mut State, v: &str, _: &mut Tx| pick_harness(s, v))
            .build(k, &mut menus);
        let model = TextInput::new(&now.model)
            .label("Model")
            .placeholder("Type a model id")
            .width(Some(200.0))
            .disabled(form.busy)
            .on_edit(|s: &mut State| &mut start_now(s).model)
            .on_submit(go)
            .build(k)
            .key("new-card-model");
        let tool_key = |name: &str| label(name.to_owned(), 11.5, 500.0, t.faint);
        body = body.child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .flex_wrap()
                .child(row().gap(4.0).center_y().child(tool_key("Harness")).child(harness))
                .child(row().gap(6.0).center_y().child(tool_key("Model")).child(model))
                .child(spacer()),
        );
    }
    if let Some(e) = &form.error {
        body = body.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().key("new-card-error"));
    }
    let add = if now.on { "Start session" } else { "Add" };
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(form.busy).on_press(|s: &mut State| s.new_card = None).build(k).key("new-card-cancel"))
        .child(Button::new(add).variant(ButtonVariant::Contrast).disabled(!ready(s)).on_press_tx(go).build(k).key("new-card-add"));
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
    layer.extend(menus);
}
