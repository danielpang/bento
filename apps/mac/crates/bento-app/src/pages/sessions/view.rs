//! The Sessions page's panes: the list, an open conversation, the composer, and the inspector.

use bento_client::{FeatureStatus, ProjectSession, RunStatus};
use rune::{Cx, El, Key, ScrollSpec, Tx, col, el, row, spacer};
use rune_kit::diff::DiffView;
use rune_kit::{Button, ButtonVariant, Kit, Markdown, SegmentedControl, Select, TextArea, TextInput};

use super::{Compose, HARNESSES, List, Open, Pane, StopDoes, ago, feature_word, initials, now_unix, run_words, token_count};
use crate::data;
use crate::metal::{self, orb, ring};
use crate::model::LaneKind;
use crate::pages;
use crate::screens::inspector::{block, user};
use crate::screens::parts::key;
use crate::state::{Screen, State};
use crate::theme::{Tokens, label, mono};

const LIST_W: f32 = 320.0;
const READING_W: f32 = 720.0;

fn open_mut(s: &mut State) -> &mut Open {
    s.sessions.open.as_mut().expect("a session is open")
}

fn compose_mut(s: &mut State) -> &mut Compose {
    s.sessions.compose.as_mut().expect("the composer is open")
}

fn centered(key: &str, body: El) -> El {
    col().key(key).w_full().h_full().center().gap(10.0).padding(24.0).child(body)
}

fn note(text: &str, t: &Tokens) -> El {
    label(text.to_owned(), 13.0, 400.0, t.faint)
}

pub fn view(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let p = &s.sessions;
    if s.project.is_none() {
        return centered("sessions", note("Loading sessions.", t));
    }
    let alone = p.alone();
    let pane = match (&p.compose, &p.open) {
        (Some(c), _) => Some(composer(c, alone, t, k, layer)),
        (None, Some(o)) => Some(session(s, o, t, k)),
        _ => None,
    };
    match (&p.list, pane) {
        (List::Ready(_), Some(pane)) if alone => pane,
        (List::Ready(rows), None) if rows.is_empty() => centered("sessions", note("Loading sessions.", t)),
        (List::Ready(rows), None) => col()
            .key("sessions")
            .w_full()
            .h_full()
            .items_center()
            .child(list(s, rows, t).max_w(READING_W)),
        (List::Ready(rows), Some(pane)) => row()
            .key("sessions")
            .w_full()
            .h_full()
            .child(list(s, rows, t).w(LIST_W).border_sides([0.0, 1.0, 0.0, 0.0], t.line))
            .child(col().key("sessions-pane").grow(1.0).shrink().min_w(0.0).h_full().child(pane)),
        (List::Loading, Some(pane)) => pane,
        (List::Loading, None) => centered("sessions", note("Loading sessions.", t)),
        (List::Failed(e), pane) => {
            let retry = Button::new("Retry").variant(ButtonVariant::Neutral).on_press(|s: &mut State| {
                s.sessions.list = List::Loading;
                super::enter(s);
            });
            let failed = col()
                .gap(8.0)
                .items_center()
                .child(label("Could not load sessions.", 14.0, 600.0, t.text))
                .child(label(e.clone(), 12.5, 400.0, t.failed).wrap().selectable(true).max_w(480.0))
                .child(retry.build(k).key("sessions-retry"));
            match pane {
                Some(pane) => pane,
                None => centered("sessions", failed),
            }
        }
    }
}

fn list(s: &State, rows: &[ProjectSession], t: &Tokens) -> El {
    let now = now_unix();
    let count = if rows.len() == 1 { "1 conversation".to_owned() } else { format!("{} conversations", rows.len()) };
    let head = row()
        .key("sessions-head")
        .w_full()
        .px(10.0)
        .pt(14.0)
        .pb(8.0)
        .gap(8.0)
        .center_y()
        .child(label("Conversations behind the work.", 12.0, 400.0, t.faint).truncate().shrink())
        .child(spacer())
        .child(label(count, 11.5, 400.0, t.faint));
    let open = s.sessions.open.as_ref().map(|o| o.feature.as_str());
    let items = rows.iter().fold(col().key("session-list").w_full().gap(2.0).px(8.0).pb(12.0).child(head), |c, r| c.child(list_row(r, open, now, t)));
    col().key("session-list-scroll").w_full().h_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(items)
}

pub fn dot_color(status: RunStatus, t: &Tokens) -> rune::color::Color {
    match status {
        RunStatus::Succeeded => t.succeeded,
        RunStatus::Failed => t.failed,
        RunStatus::Cancelled | RunStatus::Unknown => t.idle,
        _ => t.running,
    }
}

fn dot(c: rune::color::Color) -> El {
    el().size(7.0, 7.0).radius(3.5).fill(c)
}

fn avatar(name: &str, active: bool, t: &Tokens) -> El {
    let mut a = col().size(30.0, 30.0).radius(15.0).fill(t.raised).border(1.0, t.line).center().child(label(initials(name), 11.0, 600.0, t.dim));
    // Chrome flows round an agent that is working right now.
    if active {
        a = a.child(ring(metal::CHROME, 2.0, 1.0, 15.0));
    }
    a
}

fn list_row(r: &ProjectSession, open: Option<&str>, now: i64, t: &Tokens) -> El {
    let run = &r.latest_run;
    let agent = run.agent_name.clone().unwrap_or_else(|| "agent".into());
    let selected = open == Some(r.feature_id.as_str());
    let id = r.feature_id.clone();
    let mut tail = if r.run_count == 1 { "1 run".to_owned() } else { format!("{} runs", r.run_count) };
    if let Some(cost) = r.total_cost_usd {
        tail.push_str(&format!(" · ${cost:.2}"));
    }
    let time = run.queued_at.as_deref().map(|q| ago(q, now)).unwrap_or_default();
    let top = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(label(r.title.clone(), 13.0, 500.0, t.text).truncate().grow(1.0).shrink())
        .child(label(time, 11.5, 400.0, t.faint));
    let sub = row()
        .w_full()
        .gap(6.0)
        .center_y()
        .child(dot(dot_color(run.status, t)))
        .child(label(format!("{agent} {}", run_words(run.status)), 11.5, 400.0, t.dim).truncate().shrink())
        .child(spacer())
        .child(label(tail, 11.5, 400.0, t.faint).help("This conversation's agent runs. Judge runs are not counted, and runs that report no cost are missing from the total, so it is a floor, not a total."));
    let mut item = row()
        .key(format!("session-{}", r.feature_id))
        .w_full()
        .px(10.0)
        .py(9.0)
        .gap(10.0)
        .radius(8.0)
        .center_y()
        .role("button")
        .label(r.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| super::open_session(s, &id))
        .child(avatar(&agent, run.status.is_active(), t))
        .child(col().grow(1.0).shrink().min_w(0.0).gap(4.0).child(top).child(sub));
    if selected {
        item = item.fill(t.raised).border(1.0, t.line);
    }
    item
}

fn close_button(k: &Kit) -> El {
    Button::new("Close").variant(ButtonVariant::Ghost).on_press(|s: &mut State| super::close(s)).build(k).key("session-close")
}

fn metal_for(o: &Open) -> (u32, f32) {
    if o.run_active() {
        return (metal::CHROME, 1.0);
    }
    match o.detail.as_ref().map(|d| d.feature.status) {
        Some(FeatureStatus::Gated) => (metal::GOLD, 0.0),
        _ => (metal::GUNMETAL, 0.0),
    }
}

fn chip(o: &Open, t: &Tokens) -> El {
    let Some(d) = &o.detail else { return el() };
    let color = match d.feature.status {
        FeatureStatus::Gated => t.gated,
        FeatureStatus::Done => t.succeeded,
        _ if o.run_active() => t.running,
        _ => o.latest_run().map_or(t.idle, |r| dot_color(r.status, t)),
    };
    row()
        .key("session-status")
        .h(20.0)
        .px(8.0)
        .gap(6.0)
        .radius(10.0)
        .center_y()
        .border(1.0, t.line)
        .child(dot(color))
        .child(label(feature_word(d.feature.status), 11.0, 450.0, t.dim))
}

fn session(s: &State, o: &Open, t: &Tokens, k: &Kit) -> El {
    let title = o.detail.as_ref().map_or("Conversation".to_owned(), |d| d.feature.title.clone());
    let (material, flow) = metal_for(o);
    let mut head = row()
        .key("session-head")
        .w_full()
        .px(20.0)
        .py(10.0)
        .gap(10.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], t.line);
    if o.detail.is_some() {
        head = head.child(orb(material, flow, 16.0));
    }
    head = head.child(label(title, 14.0, 600.0, t.text).truncate().grow(1.0).shrink().min_w(60.0));
    if o.has_diff() {
        let picked = if o.pane == Pane::Changes { 1 } else { 0 };
        let toggle = SegmentedControl::new(&["Conversation", "Changes"], Some(picked))
            .label("Pane")
            .fit()
            .on_pick(|s: &mut State, i: usize, _: &mut Tx| open_mut(s).pane = if i == 1 { Pane::Changes } else { Pane::Conversation })
            .build(k)
            .key("session-pane");
        head = head.child(toggle);
    }
    head = head.child(close_button(k));
    let body = if o.deleted {
        centered(
            "session-gone",
            col()
                .gap(6.0)
                .items_center()
                .child(label("This card was deleted.", 14.0, 600.0, t.text))
                .child(label("It is no longer on the board, and its transcript went with it.", 12.5, 400.0, t.dim)),
        )
    } else if let (Some(e), None) = (&o.error, &o.detail) {
        let feature = o.feature.clone();
        let again = Button::new("Try again").variant(ButtonVariant::Neutral).on_press(move |s: &mut State| {
            open_mut(s).error = None;
            super::load_detail(s, &feature);
        });
        centered(
            "session-failed",
            col()
                .gap(8.0)
                .items_center()
                .child(label("Could not load this card.", 14.0, 600.0, t.text))
                .child(label(e.clone(), 12.5, 400.0, t.failed).wrap().selectable(true).max_w(480.0))
                .child(again.build(k).key("session-retry")),
        )
    } else if o.pane == Pane::Changes && o.has_diff() {
        DiffView::new(|s: &State| &s.sessions.diff, |s: &mut State| &mut s.sessions.diff)
            .key("session-diff")
            .scroll_bar(true)
            .build(s, k)
            .w_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
    } else {
        transcript(o, t, k)
    };
    let mut pane = col().key("session").w_full().h_full().child(head).child(body);
    if o.detail.is_some() && !o.deleted && o.pane == Pane::Conversation {
        pane = pane.child(composer_bar(o, t, k));
    }
    pane
}

fn transcript(o: &Open, t: &Tokens, k: &Kit) -> El {
    let tr = &o.transcript;
    let mut c = col().key("session-transcript").w_full().max_w(READING_W).gap(18.0).px(24.0).py(20.0);
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
    col()
        .key("session-scroll")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .items_center()
        .scroll(ScrollSpec { stick_bottom: true })
        .child(c)
}

/// The sentence under the composer, as the console says it.
fn hint(o: &Open) -> String {
    let name = o.latest_agent().map_or("This agent".to_owned(), |a| a.name.clone());
    let resumes = o.latest_agent().is_none_or(|a| !matches!(a.cli.as_str(), "pool" | "dsh"));
    if !o.run_active() {
        return if resumes {
            "Nothing is running. Your message starts a new run on this card, continuing the same conversation.".into()
        } else {
            "Nothing is running. Your message starts a new run on this card, with a compacted transcript of this conversation.".into()
        };
    }
    match o.live_kind() {
        Some("steer") => format!("{name} holds a live session: your message steers it while it works."),
        Some(_) => format!("{name} holds a live session: your message is read after the current step, in the same conversation."),
        None if resumes => "This tool takes messages between runs: yours is delivered the moment the current run ends.".into(),
        None => "This tool takes messages between runs: yours is delivered the moment the current run ends, as a new run with a compacted transcript of this conversation.".into(),
    }
}

fn composer_bar(o: &Open, t: &Tokens, k: &Kit) -> El {
    let queues = o.run_active() && o.live_kind() != Some("steer");
    let (placeholder, name) = if queues { ("Queue a message...", "Queue a message") } else { ("Send a message...", "Send a message") };
    let send = |s: &mut State, _: &mut Tx| super::send(s);
    let field = TextArea::new(&o.composer)
        .label(name)
        .placeholder(placeholder)
        .width(None)
        .auto_grow(2, 8)
        .disabled(o.busy)
        .on_edit(|s: &mut State| &mut open_mut(s).composer)
        // Enter sends; Shift+Enter is the newline.
        .on_key(|s: &mut State, ev: &rune::KeyEvent, _: &mut Tx| {
            if ev.key == Key::Enter && !ev.mods.shift && !ev.mods.alt {
                super::send(s);
                return true;
            }
            false
        })
        .on_submit(send)
        .build(k)
        .key("session-composer");
    let mut buttons = row().w_full().gap(8.0).center_y().child(label(hint(o), 11.5, 400.0, t.faint).wrap().grow(1.0).shrink());
    if o.run_active() {
        let does = o.stop_does();
        let help = match does {
            StopDoes::End => "Stop the agent",
            StopDoes::Interrupt => "Stop this turn. The agent waits for your next message.",
            StopDoes::None if o.interrupt_sent.is_some() => "Stopping this turn.",
            StopDoes::None => "The agent is waiting for your next message.",
        };
        let stop = Button::new("Stop")
            .variant(ButtonVariant::Neutral)
            .disabled(o.busy || does == StopDoes::None)
            .help(help)
            .on_press_tx(|s: &mut State, tx: &mut Tx| super::stop(s, tx.clock()))
            .build(k)
            .key("session-stop");
        buttons = buttons.child(stop);
    }
    let empty = o.composer.text.trim().is_empty();
    buttons = buttons.child(Button::new("Send").variant(ButtonVariant::Neutral).disabled(empty || o.busy).on_press_tx(send).build(k).key("session-send"));
    let mut c = col().w_full().max_w(READING_W).px(24.0).pb(16.0).pt(10.0).gap(8.0).child(field).child(buttons);
    if let Some(p) = &o.problem {
        c = c.child(label(p.clone(), 12.0, 450.0, t.failed).wrap().selectable(true).key("session-problem"));
    }
    col().key("session-composer-box").w_full().items_center().border_sides([0.0, 0.0, 0.0, 0.0], t.line).child(c)
}

fn composer(c: &Compose, alone: bool, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let start = |s: &mut State, _: &mut Tx| super::start(s);
    let prompt = TextArea::new(&c.prompt)
        .label("Message")
        .placeholder("Where does the login flow live, and why does it redirect twice?")
        .width(None)
        .auto_grow(4, 12)
        .disabled(c.busy)
        .on_edit(|s: &mut State| &mut compose_mut(s).prompt)
        .on_submit(start)
        .build(k)
        .key("compose-message");
    let labels: Vec<&str> = HARNESSES.iter().map(|h| h.1).collect();
    let harness = Select::new("compose-harness", &labels)
        .label("Harness")
        .current(Some(c.label()))
        .open(c.harness_open)
        .width(190.0)
        .disabled(c.busy)
        .on_toggle(|s: &mut State| {
            let c = compose_mut(s);
            c.harness_open = !c.harness_open;
        })
        .on_close(|s: &mut State| compose_mut(s).harness_open = false)
        .on_choose(|s: &mut State, v: &str, _: &mut Tx| super::pick_harness(s, v))
        .build(k, layer);
    let model = TextInput::new(&c.model)
        .label("Model")
        .placeholder("Type a model id")
        .width(Some(220.0))
        .disabled(c.busy)
        .on_edit(|s: &mut State| &mut compose_mut(s).model)
        .on_submit(start)
        .build(k)
        .key("compose-model");
    let tool_key = |name: &str| label(name.to_owned(), 11.5, 500.0, t.faint);
    let mut tools = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .flex_wrap()
        .child(row().gap(4.0).center_y().child(tool_key("Harness")).child(harness))
        .child(row().gap(6.0).center_y().child(tool_key("Model")).child(model))
        .child(spacer());
    if !alone {
        tools = tools.child(
            Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(c.busy).on_press(|s: &mut State| s.sessions.compose = None).build(k).key("compose-cancel"),
        );
    }
    tools = tools.child(key("Start session", metal::KEY, t, c.ready().then_some(start)).key("compose-start"));
    let mut card = col().key("compose-card").w_full().padding(12.0).gap(10.0).radius(12.0).fill(t.panel).border(1.0, t.line).child(prompt);
    if let Some(e) = &c.error {
        card = card.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true).key("compose-error"));
    }
    card = card.child(tools);
    let hint = if c.busy { "Starting the agent…" } else { "Cmd+Enter to send" };
    let mut under = row().w_full().gap(8.0).center_y();
    if alone {
        under = under.child(
            label("Or start an agent from a card on the board.", 12.0, 400.0, t.dim)
                .role("link")
                .label("Or start an agent from a card on the board.")
                .focusable(true)
                .on_press(|s: &mut State| pages::show(s, Screen::Board))
                .key("compose-board"),
        );
    }
    under = under.child(spacer()).child(label(hint, 11.5, 400.0, t.faint));
    let column = col()
        .w_full()
        .max_w(640.0)
        .gap(14.0)
        .child(label("What should the agent do?", 20.0, 600.0, t.text))
        .child(label("Ask about the code or describe a change. The agent works on its own branch, outside the pipeline.", 13.0, 400.0, t.dim).wrap())
        .child(card)
        .child(under);
    col().key("compose").w_full().h_full().center().padding(24.0).child(column)
}

pub fn inspector(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, _layer: &mut Vec<El>) -> Option<El> {
    let o = s.sessions.open.as_ref()?;
    if o.deleted {
        return None;
    }
    let Some(d) = &o.detail else {
        return Some(col().key("session-inspector").w_full().h_full().center().child(note("Loading the conversation.", t)));
    };
    let f = &d.feature;
    let stage = match (f.status, f.current_stage_id.as_deref()) {
        (FeatureStatus::Done, _) => "Completed".to_owned(),
        (_, None) if f.standalone => "Outside the pipeline".to_owned(),
        (_, None) => "Backlog".to_owned(),
        (_, Some(id)) => s.lanes.iter().find(|l| l.kind == LaneKind::Stage(id.to_owned())).map_or_else(String::new, |l| l.name.clone()),
    };
    let agent = o.latest_agent().map(|a| (a.name.clone(), a.model.clone()));
    let costs: Vec<f64> = d.runs.iter().filter_map(|r| r.cost_usd).collect();
    let cost = if costs.is_empty() { "Not reported".to_owned() } else { format!("${:.2}", costs.iter().sum::<f64>()) };
    let tokens = o.tokens + o.live_tokens;
    let tokens = if tokens == 0 { "Not reported".to_owned() } else { token_count(tokens) };
    let (material, flow) = metal_for(o);
    let id = f.id.clone();
    let open_card = Button::new("Open card")
        .variant(ButtonVariant::Neutral)
        .on_press(move |s: &mut State| {
            pages::show(s, Screen::Board);
            data::select_card(s, &id);
        })
        .build(k)
        .key("session-open-card");
    let head = col()
        .w_full()
        .gap(10.0)
        .child(row().gap(10.0).center_y().child(orb(material, flow, 18.0)).child(label(f.title.clone(), 14.0, 600.0, t.text).wrap().shrink()))
        .child(row().gap(8.0).center_y().child(chip(o, t)).child(spacer()).child(open_card));
    let field = |name: &str, value: El| row().w_full().gap(12.0).items_start().child(label(name.to_owned(), 12.0, 400.0, t.faint).w(72.0)).child(value.grow(1.0).shrink());
    let text = |v: String| label(v, 12.5, 400.0, t.text).wrap();
    let mut facts = col().key("session-facts").w_full().gap(10.0);
    facts = facts.child(field("Stage", text(stage)));
    if let Some((name, model)) = agent {
        facts = facts.child(field("Agent", col().gap(2.0).child(text(name)).child(mono(model, 11.5, t.faint).wrap())));
    }
    if let Some(branch) = &f.branch_name {
        facts = facts.child(field("Branch", mono(branch.clone(), 11.5, t.dim).wrap().selectable(true)));
    }
    facts = facts
        .child(field("Runs", text(d.runs.len().to_string())))
        .child(field("Cost", text(cost)))
        .child(field("Tokens", text(tokens)));
    let mut files = col().key("session-files").w_full().gap(2.0).child(label("FILES CHANGED", 11.0, 500.0, t.faint).pb(4.0));
    match &o.changes {
        None => files = files.child(note("Loading the changes.", t)),
        Some(c) if c.repositories.iter().all(|r| r.files.is_empty()) => files = files.child(label("Nothing committed yet.", 12.5, 400.0, t.faint)),
        Some(c) => {
            let many = c.repositories.len() > 1;
            for r in &c.repositories {
                for file in &r.files {
                    let path = file.path.clone();
                    let shown = if many { format!("{}/{}", r.name, file.path) } else { file.path.clone() };
                    let row_el = row()
                        .key(format!("file-{shown}"))
                        .w_full()
                        .px(6.0)
                        .py(4.0)
                        .gap(8.0)
                        .radius(6.0)
                        .center_y()
                        .role("button")
                        .label(shown.clone())
                        .focusable(true)
                        .on_press_tx(move |s: &mut State, tx: &mut Tx| {
                            let p = &mut s.sessions;
                            if let Some(o) = p.open.as_mut().filter(|o| o.has_diff()) {
                                o.pane = Pane::Changes;
                                if let Some(i) = p.diff.file_index(&path) {
                                    p.diff.scroll_to_file(i, tx);
                                }
                            }
                        })
                        .child(mono(shown, 11.5, t.dim).truncate().grow(1.0).shrink())
                        .child(mono(format!("+{}", file.additions), 11.5, t.succeeded))
                        .child(if file.deletions > 0 { mono(format!("-{}", file.deletions), 11.5, t.failed) } else { el() });
                    files = files.child(row_el);
                }
                if r.truncated {
                    files = files.child(label("The diff is too large to show in full.", 11.5, 400.0, t.faint).wrap());
                }
            }
        }
    }
    Some(
        col()
            .key("session-inspector")
            .w_full()
            .h_full()
            .padding(16.0)
            .gap(18.0)
            .child(head)
            .child(facts)
            .child(files)
            .scroll(ScrollSpec { stick_bottom: false }),
    )
}

pub fn toolbar(s: &State, _cx: &mut Cx<State>, t: &Tokens, _k: &Kit) -> Option<El> {
    s.project.as_ref()?;
    let p = &s.sessions;
    if p.compose.is_some() || p.alone() {
        return None;
    }
    let open: fn(&mut State, &mut Tx) = |s, _| super::compose(s);
    Some(key("New session", metal::KEY, t, Some(open)).key("new-session"))
}
