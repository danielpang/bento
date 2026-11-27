//! The drawer's conversation: every run with its tool calls open to read, the lines above a long
//! run's tail on request, a sign of life while the agent works, and a way back to the newest line.

use rune::{El, ScrollSpec, Tx, col, el, row};
use rune_kit::{Button, ButtonVariant, Kit, Markdown};

use super::{RunPage, load_earlier, toggle, track_end, track_viewport};
use crate::metal::{self, orb};
use crate::model::{Entry, ToolCall, tools_line};
use crate::screens::inspector::{block_head, entry, user};
use crate::state::{Block, State};
use crate::theme::{Tokens, label, mono};

/// A call's input or output past this is cut, so one huge file read cannot stall a frame.
const SHOWN: usize = 16 * 1024;

fn cut(text: &str) -> String {
    if text.len() <= SHOWN {
        return text.to_owned();
    }
    format!("{}…", &text[..text.floor_char_boundary(SHOWN)])
}

fn state_word(call: &ToolCall, running: bool) -> &'static str {
    if call.failed {
        "Failed"
    } else if call.done {
        "Completed"
    } else if !running {
        "Result not recorded"
    } else {
        "Running…"
    }
}

fn call_view(call: &ToolCall, key: &str, running: bool, open: bool, t: &Tokens) -> El {
    let k = key.to_owned();
    let word = state_word(call, running);
    let head = row()
        .key(key.to_owned())
        .w_full()
        .px(6.0)
        .py(4.0)
        .gap(8.0)
        .radius(6.0)
        .center_y()
        .hover_fill(t.raised)
        .role("button")
        .label(call.summary.clone())
        .focusable(true)
        .on_press(move |s: &mut State| toggle(s, &k))
        .child(label(if open { "▾" } else { "▸" }, 10.0, 400.0, t.faint).w(10.0))
        .child(mono(call.summary.clone(), 11.5, t.dim).truncate().grow(1.0).shrink())
        .child(label(word, 11.0, 450.0, if call.failed { t.failed } else { t.faint }));
    let mut c = col().w_full().child(head);
    if !open {
        return c;
    }
    let section = |name: &str, text: &str| {
        col()
            .w_full()
            .gap(4.0)
            .child(label(name.to_owned(), 11.0, 600.0, t.faint))
            .child(col().w_full().padding(8.0).radius(6.0).fill(t.raised).child(mono(cut(text), 11.0, t.text).wrap().selectable(true)))
    };
    let mut body = col().key(format!("{key}-body")).w_full().pl(22.0).pr(4.0).pt(2.0).pb(6.0).gap(8.0);
    if !call.input.is_empty() {
        body = body.child(section("Input", &call.input));
    }
    if !call.output.is_empty() {
        body = body.child(section("Output", &call.output));
    }
    if call.input.is_empty() && call.output.is_empty() {
        body = body.child(label("This agent did not record inputs or output for this call.", 11.5, 400.0, t.faint).wrap());
    }
    c = c.child(body);
    c
}

/// A run of consecutive tool calls: a line that opens to the calls, each opening to its input
/// and output.
fn tools(calls: &[ToolCall], key: &str, running: bool, s: &State, t: &Tokens) -> El {
    let open = s.review.open.contains(key);
    let active = running && calls.iter().any(|c| !c.done);
    let failed = calls.iter().filter(|c| c.failed).count();
    let k = key.to_owned();
    let n = calls.len();
    let mut head = row()
        .key(key.to_owned())
        .w_full()
        .gap(6.0)
        .center_y()
        .role("button")
        .label(if active { "Tool calling…" } else { "Tool calls" })
        .focusable(true)
        .on_press(move |s: &mut State| toggle(s, &k))
        .child(label(if open { "▾" } else { "▸" }, 10.0, 400.0, t.faint).w(10.0))
        .child(label(if active { "Tool calling…" } else { "Tool calls" }, 11.5, 500.0, t.dim))
        .child(label(format!("{n} {}", if n == 1 { "call" } else { "calls" }), 11.5, 400.0, t.faint));
    if failed > 0 {
        head = head.child(label(format!("{failed} failed"), 11.5, 500.0, t.failed));
    }
    let mut c = col().key(format!("{key}-group")).w_full().gap(2.0).child(head);
    if !open {
        return c.child(mono(tools_line(calls), 11.0, t.faint).wrap().pl(16.0));
    }
    let mut list = col().w_full().pl(10.0).gap(1.0);
    for (j, call) in calls.iter().enumerate() {
        let ck = format!("{key}-{j}");
        list = list.child(call_view(call, &ck, running, s.review.open.contains(&ck), t));
    }
    c = c.child(list);
    c
}

fn entries(out: El, items: &[Entry], prefix: &str, running: bool, s: &State, t: &Tokens, k: &Kit) -> El {
    items.iter().enumerate().fold(out, |out, (n, e)| match e {
        Entry::Tools(calls) => out.child(tools(calls, &format!("tools-{prefix}-{n}"), running, s, t)),
        other => out.child(entry(other, &format!("{prefix}-{n}"), t, k)),
    })
}

fn finished(s: &State, b: &Block, i: usize, page: Option<&RunPage>, t: &Tokens, k: &Kit) -> El {
    let mut c = col().key(format!("block-{i}")).w_full().gap(10.0).child(block_head(b, t));
    if let Some(p) = page {
        if p.earlier > 0 && p.first_seq.is_some() {
            let words = if p.loading {
                "Loading earlier output...".to_owned()
            } else {
                format!("Show {} earlier {}", p.earlier, if p.earlier == 1 { "line" } else { "lines" })
            };
            let more = Button::new(words)
                .variant(ButtonVariant::Ghost)
                .disabled(p.loading)
                .on_press(move |s: &mut State| load_earlier(s, i))
                .build(k)
                .key(format!("earlier-{i}"));
            c = c.child(more);
        }
        return entries(c, &p.entries, &i.to_string(), false, s, t, k);
    }
    entries(c, &b.entries, &i.to_string(), false, s, t, k)
}

/// The agent is in its run and has nothing on the way yet.
fn working(agent: &str, started: bool, t: &Tokens) -> El {
    let name = if agent.is_empty() { "The agent" } else { agent };
    let words = if started { format!("{name} is working") } else { format!("{name} is getting started...") };
    row().key("working").gap(8.0).center_y().child(orb(metal::CHROME, 1.0, 14.0)).child(label(words, 12.0, 400.0, t.faint))
}

pub fn view(s: &State, card: &str, t: &Tokens, k: &Kit) -> El {
    let tr = &s.transcript;
    let pages = s.review.of(card).map_or(&[][..], |r| &r.pages[..]);
    let mut c = col().key("transcript").w_full().gap(16.0).pr(4.0);
    for (i, b) in tr.blocks.iter().enumerate() {
        let page = pages.get(i);
        c = c.child(finished(s, b, i, page, t, k));
    }
    if let Some(live) = &tr.live {
        let mut b = entries(col().key("block-live").w_full().gap(10.0).child(block_head(live, t)), &live.entries, "live", true, s, t, k);
        if !tr.draft.is_empty() {
            b = b.child(Markdown::new(tr.draft.clone()).streaming(true).build(k).key("draft").w_full().opacity(0.75));
        } else {
            b = b.child(working(&live.agent, !live.entries.is_empty(), t));
        }
        c = c.child(b);
    }
    for (n, text) in tr.pending.iter().chain(&tr.sent).enumerate() {
        c = c.child(user(text, &format!("pending-{n}"), t, k).opacity(0.7));
    }
    if tr.loading && tr.blocks.is_empty() {
        c = c.child(label("Loading the conversation.", 12.0, 400.0, t.faint));
    } else if tr.blocks.is_empty() && tr.live.is_none() && tr.pending.is_empty() && tr.sent.is_empty() {
        c = c.child(label("No agent has run on this card yet. Start it from the card's Actions, and the conversation appears here.", 12.0, 400.0, t.faint).wrap());
    }
    c = c.child(el().key("transcript-end").w_full().h(1.0).on_layout_tx(|s: &mut State, r: [f32; 4], tx: &mut Tx| track_end(s, r[1], tx)));
    let scroll = col()
        .key("transcript-scroll")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: true })
        .on_layout_tx(|s: &mut State, r: [f32; 4], tx: &mut Tx| track_viewport(s, r, tx))
        .child(c);
    let mut pane = col().key("conversation").w_full().grow(1.0).shrink().min_h(0.0).child(scroll);
    if s.review.of(card).is_some_and(|r| r.scrolled_up) {
        let jump = Button::new("Jump to latest ↓")
            .variant(ButtonVariant::Neutral)
            .on_press_tx(|s: &mut State, tx: &mut Tx| {
                s.review.scrolled_up = false;
                tx.scroll_to_bottom("transcript-scroll");
            })
            .build(k)
            .key("jump-latest");
        pane = pane.child(row().w_full().pin(Some(0.0), None, Some(0.0), Some(8.0)).justify_center().child(jump));
    }
    pane
}
