//! The inspector: the selected card, what can be done with it, and its review tabs.

use bento_client::RunStatus;
use rune::{El, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, Kit, Markdown, TextArea};

use crate::data;
use crate::metal::orb;
use crate::model::{Entry, Status, tools_line};
use crate::screens::card;
use crate::screens::drawer::{self, Tab};
use crate::screens::parts::{metal_of, status};
use crate::state::{Block, State};
use crate::theme::{Tokens, label, mono};

pub fn inspector(s: &State, t: &Tokens, k: &Kit) -> El {
    let Some(c) = s.selected.as_deref().and_then(|id| s.card(id)) else {
        return col().key("inspector").w_full().h_full().center().child(label("Select a card", 13.0, 400.0, t.faint));
    };
    let (material, flow) = metal_of(c.status);
    let lane = s.lane_of(&c.id).map(|l| l.name.clone()).unwrap_or_default();
    let mut head = col()
        .key("inspector-head")
        .w_full()
        .gap(10.0)
        .child(
            row()
                .gap(10.0)
                .center_y()
                .child(orb(material, flow, 18.0))
                .child(label(c.title.clone(), 14.0, 600.0, t.text).wrap().shrink())
                .child(spacer())
                .child(Button::new("Close").variant(ButtonVariant::Ghost).on_press(|s: &mut State| s.selected = None).build(k).key("drawer-close")),
        )
        .child(row().gap(8.0).center_y().child(status(c.status, t)).child(label(lane, 11.5, 400.0, t.faint)));
    if !c.description.trim().is_empty() {
        head = head.child(label(c.description.clone(), 12.5, 400.0, t.dim).wrap().max_h(120.0).key("description"));
    }
    if !c.note.is_empty() && c.status != Status::Running {
        head = head.child(label(c.note.clone(), 12.5, 400.0, t.dim).wrap());
    }
    head = head.child(card::actions(s, c, t, k));
    let conversation = s.review.of(&c.id).is_none_or(|r| r.tab == Tab::Conversation);
    let mut pane = col()
        .key("inspector")
        .w_full()
        .h_full()
        .padding(16.0)
        .gap(14.0)
        .child(head)
        .child(card::panels(s, t, k))
        .child(drawer::tabs(s, &c.id, t))
        .child(drawer::body(s, &c.id, t, k));
    if conversation {
        pane = pane.child(composer(s, k));
    }
    pane
}

pub(crate) fn entry(e: &Entry, n: &str, t: &Tokens, k: &Kit) -> El {
    match e {
        Entry::User(text) => user(text, &format!("user-{n}"), t, k),
        Entry::Agent(text) => Markdown::new(text.clone()).build(k).key(format!("agent-{n}")).w_full(),
        Entry::System(text) => label(text.clone(), 11.5, 400.0, t.faint).wrap().key(format!("system-{n}")),
        Entry::Tools(calls) => row()
            .key(format!("tools-{n}"))
            .gap(6.0)
            .child(el_dot(t))
            .child(mono(tools_line(calls), 11.5, t.faint).wrap().shrink()),
        Entry::Failed(text) => label(text.clone(), 12.0, 450.0, t.failed).wrap().selectable(true).key(format!("failed-{n}")),
    }
}

fn el_dot(t: &Tokens) -> El {
    rune::el().size(5.0, 5.0).radius(2.5).fill(t.idle).mt(5.0)
}

pub(crate) fn user(text: &str, key: &str, t: &Tokens, k: &Kit) -> El {
    col().key(key).w_full().padding(10.0).radius(8.0).fill(t.raised).child(Markdown::new(text.to_owned()).build(k).w_full())
}

/// Who ran a block and how it ended.
pub(crate) fn block_head(b: &Block, t: &Tokens) -> El {
    let word = match b.status {
        RunStatus::Queued | RunStatus::Starting | RunStatus::Running => "running",
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Unknown => "",
    };
    row().gap(8.0).child(label(b.agent.clone(), 11.5, 600.0, t.dim)).child(label(word, 11.5, 400.0, t.faint))
}

pub(crate) fn block(b: &Block, i: usize, t: &Tokens, k: &Kit) -> El {
    let mut c = col().key(format!("block-{i}")).w_full().gap(10.0).child(block_head(b, t));
    for (n, e) in b.entries.iter().enumerate() {
        c = c.child(entry(e, &n.to_string(), t, k));
    }
    c
}

fn composer(s: &State, k: &Kit) -> El {
    let send = |s: &mut State, _: &mut Tx| data::send_message(s);
    let field = TextArea::new(&s.composer)
        .label("Send a message")
        .placeholder("Send a message...")
        .width(None)
        .auto_grow(2, 6)
        .on_edit(|s: &mut State| &mut s.composer)
        .on_submit(send)
        .build(k)
        .key("composer");
    let empty = s.composer.text.trim().is_empty();
    col()
        .key("composer-box")
        .w_full()
        .gap(8.0)
        .child(field)
        .child(row().w_full().justify_end().child(Button::new("Send").variant(ButtonVariant::Neutral).disabled(empty).on_press_tx(send).build(k).key("send")))
}
