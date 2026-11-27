//! The inspector: the selected card, what can be done with it, and its conversation.

use bento_client::RunStatus;
use rune::{El, ScrollSpec, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Kit, Markdown, TextArea};

use crate::data::{self, Action};
use crate::metal::{self, orb};
use crate::model::{Card, Entry, LaneKind, Status, tools_line};
use crate::screens::parts::{key, metal_of, status};
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
        .child(row().gap(10.0).center_y().child(orb(material, flow, 18.0)).child(label(c.title.clone(), 14.0, 600.0, t.text).wrap().shrink()))
        .child(row().gap(8.0).center_y().child(status(c.status, t)).child(label(lane, 11.5, 400.0, t.faint)));
    if !c.description.trim().is_empty() {
        head = head.child(label(c.description.clone(), 12.5, 400.0, t.dim).wrap().max_h(120.0).key("description"));
    }
    if !c.note.is_empty() && c.status != Status::Running {
        head = head.child(label(c.note.clone(), 12.5, 400.0, t.dim).wrap());
    }
    head = head.child(actions(s, c, t, k));
    col()
        .key("inspector")
        .w_full()
        .h_full()
        .padding(16.0)
        .gap(14.0)
        .child(head)
        .child(transcript(s, t, k))
        .child(composer(s, k))
}

fn button(name: impl Into<String>, k: &Kit, busy: bool, f: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    Button::new(name).variant(ButtonVariant::Neutral).disabled(busy).on_press_tx(f).build(k)
}

fn action(id: &str, a: Action) -> impl Fn(&mut State, &mut Tx) + 'static {
    let id = id.to_owned();
    move |s: &mut State, _: &mut Tx| data::act(s, &id, a.clone())
}

fn actions(s: &State, c: &Card, t: &Tokens, k: &Kit) -> El {
    let busy = s.busy;
    let mut bar = row().key("actions").w_full().gap(8.0).flex_wrap().center_y();
    let Some(index) = s.lanes.iter().position(|l| l.cards.iter().any(|x| x.id == c.id)) else { return bar };
    let lane = &s.lanes[index];
    match &lane.kind {
        LaneKind::Backlog => bar = bar.child(button("Start pipeline", k, busy, action(&c.id, Action::Advance)).key("advance")),
        LaneKind::Completed => bar = bar.child(button("Reopen", k, busy, action(&c.id, Action::Back)).key("reopen")),
        LaneKind::Stage(_) => {
            if c.status == Status::Gated {
                let approve = (!busy).then(|| action(&c.id, Action::Approve));
                bar = bar
                    .child(key("Approve and advance", metal::KEY_GOLD, t, approve).key("approve"))
                    .child(button("Reject", k, busy, action(&c.id, Action::Reject)).key("reject"));
            } else if let Some(next) = s.lanes.get(index + 1).filter(|l| matches!(l.kind, LaneKind::Stage(_))) {
                bar = bar.child(button(format!("Move to {}", next.name), k, busy, action(&c.id, Action::Advance)).key("advance"));
            }
            bar = bar.child(button("Send back a stage", k, busy, action(&c.id, Action::Back)).key("back"));
        }
    }
    let active = c.run_status.is_some_and(RunStatus::is_active);
    if let (true, Some(run)) = (active, c.run_id.clone()) {
        bar = bar.child(button("Stop the agent", k, busy, action(&c.id, Action::Stop { run })).key("stop"));
    } else if let (false, LaneKind::Stage(_), Some(profile)) = (active, &lane.kind, lane.agent_profile_id.clone()) {
        bar = bar.child(button(format!("Run {}", lane.agent), k, busy, action(&c.id, Action::Run { profile })).key("run"));
    }
    bar
}

fn entry(e: &Entry, n: usize, t: &Tokens, k: &Kit) -> El {
    match e {
        Entry::User(text) => user(text, &format!("user-{n}"), t, k),
        Entry::Agent(text) => Markdown::new(text.clone()).build(k).key(format!("agent-{n}")).w_full(),
        Entry::System(text) => label(text.clone(), 11.5, 400.0, t.faint).wrap().key(format!("system-{n}")),
        Entry::Tools(names) => row()
            .key(format!("tools-{n}"))
            .gap(6.0)
            .child(el_dot(t))
            .child(mono(tools_line(names), 11.5, t.faint).wrap().shrink()),
        Entry::Failed(text) => label(text.clone(), 12.0, 450.0, t.failed).wrap().selectable(true).key(format!("failed-{n}")),
    }
}

fn el_dot(t: &Tokens) -> El {
    rune::el().size(5.0, 5.0).radius(2.5).fill(t.idle).mt(5.0)
}

pub(crate) fn user(text: &str, key: &str, t: &Tokens, k: &Kit) -> El {
    col().key(key).w_full().padding(10.0).radius(8.0).fill(t.raised).child(Markdown::new(text.to_owned()).build(k).w_full())
}

pub(crate) fn block(b: &Block, i: usize, t: &Tokens, k: &Kit) -> El {
    let word = match b.status {
        RunStatus::Queued | RunStatus::Starting | RunStatus::Running => "running",
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Unknown => "",
    };
    let mut c = col()
        .key(format!("block-{i}"))
        .w_full()
        .gap(10.0)
        .child(row().gap(8.0).child(label(b.agent.clone(), 11.5, 600.0, t.dim)).child(label(word, 11.5, 400.0, t.faint)));
    for (n, e) in b.entries.iter().enumerate() {
        c = c.child(entry(e, n, t, k));
    }
    c
}

fn transcript(s: &State, t: &Tokens, k: &Kit) -> El {
    let tr = &s.transcript;
    let mut c = col().key("transcript").w_full().gap(16.0).pr(4.0);
    for (i, b) in tr.blocks.iter().enumerate() {
        c = c.child(block(b, i, t, k));
    }
    if let Some(live) = &tr.live {
        let mut b = block(live, tr.blocks.len(), t, k).key("block-live");
        if !tr.draft.is_empty() {
            b = b.child(Markdown::new(tr.draft.clone()).streaming(true).build(k).key("draft").w_full().opacity(0.75));
        }
        c = c.child(b);
    }
    for (n, text) in tr.pending.iter().chain(&tr.sent).enumerate() {
        c = c.child(user(text, &format!("pending-{n}"), t, k).opacity(0.7));
    }
    if tr.loading && tr.blocks.is_empty() {
        c = c.child(label("Loading the conversation.", 12.0, 400.0, t.faint));
    }
    col().key("transcript-scroll").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: true }).child(c)
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
