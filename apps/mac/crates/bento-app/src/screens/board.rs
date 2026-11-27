//! The board: one lane per stage between Backlog and Completed.

use rune::{El, col, row, spacer};

use crate::data;
use crate::metal::{self, ring};
use crate::model::{Card, Lane, LaneKind, Status};
use crate::screens::parts::{key, status};
use crate::state::State;
use crate::theme::{Tokens, label, mono};

const LANE_W: f32 = 248.0;

pub fn board(s: &State, t: &Tokens) -> El {
    if !s.loaded {
        return col().key("board").w_full().h_full().center().child(label("Loading the board.", 13.0, 400.0, t.faint));
    }
    s.lanes
        .iter()
        .fold(row().key("board").w_full().h_full().padding(16.0).gap(12.0).items_start(), |b, l| b.child(lane(l, s, t)))
        .scroll_xy()
}

fn lane(l: &Lane, s: &State, t: &Tokens) -> El {
    let head = row()
        .gap(8.0)
        .center_y()
        .child(label(l.name.clone(), 13.0, 600.0, t.text).truncate().shrink())
        .child(mono(l.cards.len().to_string(), 11.0, t.faint));
    let mut lane = col().key(format!("lane-{}", l.key())).w(LANE_W).gap(10.0).child(head);
    if matches!(l.kind, LaneKind::Stage(_)) {
        let rule = col().key("rule").gap(2.0).child(label(l.rule.clone(), 11.5, 400.0, t.faint)).child(label(l.agent.clone(), 11.5, 400.0, t.dim));
        lane = lane.child(rule);
    }
    for c in &l.cards {
        lane = lane.child(card(c, s, t));
    }
    lane
}

fn card(c: &Card, s: &State, t: &Tokens) -> El {
    let id = c.id.clone();
    let selected = s.selected.as_deref() == Some(&c.id);
    let mut card = col()
        .key(format!("card-{}", c.id))
        .w_full()
        .padding(12.0)
        .gap(8.0)
        .radius(10.0)
        .fill(if selected { t.raised } else { t.panel })
        .border(1.0, if selected { t.dim } else { t.line })
        .role("button")
        .label(c.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| if s.selected.as_deref() == Some(&id) { s.selected = None } else { data::select_card(s, &id) });
    // Metal says the card is alive (chrome, flowing) or waiting on a person (gold, still).
    let asks = s.card.asks(c);
    match c.status {
        _ if asks => card = card.child(ring(metal::GOLD, 2.0, 0.0, 10.0)),
        Status::Running => card = card.child(ring(metal::CHROME, 2.0, 1.0, 10.0)),
        Status::Gated => card = card.child(ring(metal::GOLD, 2.0, 0.0, 10.0)),
        _ => {}
    }
    card = card.child(label(c.title.clone(), 13.0, 500.0, t.text).wrap());
    if !c.note.is_empty() {
        let note = if c.status == Status::Running { mono(c.note.clone(), 11.5, t.dim) } else { label(c.note.clone(), 11.5, 400.0, t.faint) };
        card = card.child(note.wrap().max_h(48.0));
    }
    let mut foot = row().w_full().gap(8.0).center_y().child(status(c.status, t));
    if !c.agent.is_empty() {
        foot = foot.child(label(c.agent.clone(), 11.5, 400.0, t.faint).truncate().shrink());
    }
    if let Some((number, url)) = &c.pr {
        foot = foot.child(spacer()).child(pr_chip(*number, url.clone(), t));
    }
    if c.status == Status::Gated || asks {
        let id = c.id.clone();
        let name = if asks { "Answer" } else { "Review" };
        let review = key(name, metal::KEY_GOLD, t, Some(move |s: &mut State, _: &mut rune::Tx| data::select_card(s, &id)));
        if c.pr.is_none() {
            foot = foot.child(spacer());
        }
        foot = foot.child(review.key("review"));
    }
    card.child(foot)
}

/// The card's pull request: a link when its address is known.
fn pr_chip(number: u64, url: Option<String>, t: &Tokens) -> El {
    let chip = label(format!("PR #{number}"), 11.0, 500.0, t.dim).px(7.0).py(2.0).radius(9.0).border(1.0, t.line).key("pr-chip");
    match url {
        Some(url) => chip.role("link").label(format!("PR #{number}")).focusable(true).on_press_tx(move |s: &mut State, tx: &mut rune::Tx| {
            if let Err(e) = tx.open_url(&url) {
                s.toast(e.to_string());
            }
        }),
        None => chip,
    }
}
