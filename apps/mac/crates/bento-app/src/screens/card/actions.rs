//! The drawer's actions bar and the dialogs behind Reject, Delete, Undo and Move.

use bento_client::{CardRunRow, Client, RunStatus};
use rune::{El, TextEdit, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Dialog as KitDialog, Field, Kit, TextArea};

use super::stop::{StopDoes, stop_help};
use super::{Dialog, Msg, pulls};
use crate::data::{self, Action, err};
use crate::metal;
use crate::model::{Card, LaneKind, Status};
use crate::screens::parts::key;
use crate::state::{Screen, State};
use crate::theme::{Tokens, label};

fn button(name: impl Into<String>, k: &Kit, busy: bool, f: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    Button::new(name).variant(ButtonVariant::Neutral).disabled(busy).on_press_tx(f).build(k)
}

fn action(id: &str, a: Action) -> impl Fn(&mut State, &mut Tx) + 'static {
    let id = id.to_owned();
    move |s: &mut State, _: &mut Tx| data::act(s, &id, a.clone())
}

fn open(d: fn() -> Dialog) -> impl Fn(&mut State, &mut Tx) + 'static {
    move |s: &mut State, _: &mut Tx| s.card.dialog = Some(d())
}

/// Runs `work` against the server like any card action: the board refetches and the
/// conversation reloads when it answers.
fn act(s: &mut State, work: impl FnOnce(&Client) -> bento_client::Result<()> + Send + 'static) {
    let Some(feature) = s.card.feature.clone() else { return };
    s.busy = true;
    s.card.dialog = None;
    if !s.conn.spawn(move |c| data::Msg::Acted { result: work(&c).map_err(err), feature }) {
        s.busy = false;
    }
}

const WORKING: &str = "An agent is working this card. Stop it or wait for it to finish.";

pub fn actions(s: &State, c: &Card, t: &Tokens, k: &Kit) -> El {
    let busy = s.busy;
    let mut bar = row().key("actions").w_full().gap(8.0).flex_wrap().center_y();
    let Some(index) = s.lanes.iter().position(|l| l.cards.iter().any(|x| x.id == c.id)) else { return bar };
    let lane = &s.lanes[index];
    let no_repos = s.card.no_repositories();
    match &lane.kind {
        LaneKind::Backlog => {
            let mut b = Button::new("Start pipeline").variant(ButtonVariant::Neutral).disabled(busy || no_repos).on_press_tx(action(&c.id, Action::Advance));
            if no_repos {
                b = b.help(pulls::REPOSITORY_SETUP_MESSAGE);
            }
            bar = bar.child(b.build(k).key("advance"));
        }
        LaneKind::Completed => bar = bar.child(button("Reopen", k, busy, action(&c.id, Action::Back)).key("reopen")),
        LaneKind::Stage(_) => {
            if c.status == Status::Gated {
                let approve = (!busy).then(|| action(&c.id, Action::Approve));
                bar = bar
                    .child(key("Approve and advance", metal::KEY_GOLD, t, approve).key("approve"))
                    .child(button("Reject", k, busy, open(|| Dialog::Reject(Box::new(TextEdit::new(""))))).key("reject"));
            } else if let Some(next) = s.lanes.get(index + 1).filter(|l| matches!(l.kind, LaneKind::Stage(_))) {
                bar = bar.child(button(format!("Move to {}", next.name), k, busy, action(&c.id, Action::Advance)).key("advance"));
            }
            bar = bar.child(button("Send back a stage", k, busy, action(&c.id, Action::Back)).key("back"));
        }
    }
    if s.card.feature.as_deref() == Some(&c.id)
        && let Some(pr) = pulls::create_pr_action(s, k)
    {
        bar = bar.child(pr);
    }
    let active = c.run_status.is_some_and(RunStatus::is_active);
    if active {
        bar = bar.child(stop_button(s, k));
    } else if let (LaneKind::Stage(_), Some(profile)) = (&lane.kind, lane.agent_profile_id.clone()) {
        bar = bar.child(button(format!("Run {}", lane.agent), k, busy || no_repos, action(&c.id, Action::Run { profile })).key("run"));
    }
    let more = if s.card.more { "Fewer actions" } else { "More actions" };
    bar = bar.child(Button::new(more).variant(ButtonVariant::Ghost).on_press(|s: &mut State| s.card.more = !s.card.more).build(k).key("more"));
    if !s.card.more {
        return bar;
    }
    col().key("actions-box").w_full().gap(8.0).child(bar).child(more_actions(s, c, lane.kind == LaneKind::Completed, k))
}

fn stop_button(s: &State, k: &Kit) -> El {
    // Until the card's runs are read, Stop ends the run, which is always safe to offer.
    let does = if s.card.detail.is_some() { s.card.stop_does() } else { StopDoes::End };
    Button::new("Stop")
        .variant(ButtonVariant::Neutral)
        .disabled(s.busy || s.card.stopping || does == StopDoes::None)
        .help(stop_help(does, &s.card.turn))
        .on_press_tx(|s: &mut State, tx: &mut Tx| super::stop(s, tx.clock()))
        .build(k)
        .key("stop")
}

fn more_actions(s: &State, c: &Card, finished: bool, k: &Kit) -> El {
    let busy = s.busy;
    let mut more = row().key("more-actions").w_full().gap(8.0).flex_wrap().center_y();
    if !finished {
        let id = c.id.clone();
        more = more.child(
            button("Mark completed", k, busy, move |s: &mut State, _: &mut Tx| {
                let id = id.clone();
                act(s, move |c| c.finish_feature(&id).map(drop));
            })
            .key("finish"),
        );
        more = more.child(button("Move to…", k, busy, open(|| Dialog::Move)).key("move"));
    }
    if !finished && s.card.latest_run().is_some_and(|r| r.checkpoint_id.is_some()) {
        more = more.child(button("Undo this run", k, busy, open(|| Dialog::Rollback)).key("rollback"));
    }
    let blocked = if c.run_status.is_some_and(RunStatus::is_active) || s.card.run_active() {
        Some(WORKING)
    } else if s.card.load_failed {
        Some("Reopen the card first. This cannot be done while its details are missing.")
    } else {
        None
    };
    let loaded = s.card.detail.as_ref().is_some_and(|d| d.feature.id == c.id);
    let mut delete = Button::new("Delete card").variant(ButtonVariant::GhostMuted).disabled(busy || !loaded || blocked.is_some()).on_press(|s: &mut State| s.card.dialog = Some(Dialog::Delete));
    if let Some(b) = blocked {
        delete = delete.help(b);
    }
    more.child(delete.build(k).key("delete"))
}

/// What goes with the card, and what does not, in the console's words.
pub fn delete_consequences(branch: Option<&str>, runs: &[CardRunRow], prs: &[u64]) -> String {
    if runs.is_empty() {
        return "Nothing has run on this card, so nothing else goes with it. It leaves the board for everyone in this organization. There is no undo.".into();
    }
    let finished: Vec<&CardRunRow> = runs.iter().filter(|r| r.status.is_terminal() && r.role.as_deref() != Some("judge")).collect();
    let measured: Vec<f64> = finished.iter().filter_map(|r| r.cost_usd).collect();
    let going = if runs.len() == 1 {
        "Its single run goes with it, transcript and recorded spend included".to_owned()
    } else {
        format!("Its {} runs go with it, transcripts and recorded spend included", runs.len())
    };
    let mut out = vec![if measured.is_empty() {
        format!("{going}.")
    } else {
        format!("{going}, so this project's spend drops by ${:.2}.", measured.iter().sum::<f64>())
    }];
    if let Some(b) = branch {
        out.push(format!("The branch {b} is left alone, and any pull request stays open."));
    }
    match prs {
        [] => {}
        [one] => out.push(format!("Bento stops tracking pull request #{one}. It stays open on GitHub, where you can merge or close it yourself.")),
        many => out.push(format!(
            "Bento stops tracking pull requests {}. They stay open on GitHub, where you can merge or close them yourself.",
            many.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ")
        )),
    }
    out.push("Its sandbox is thrown away, and there is no undo.".into());
    out.join(" ")
}

fn close(s: &mut State) {
    s.card.dialog = None;
}

fn buttons(k: &Kit, busy: bool, confirm: El) -> El {
    row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(close).build(k).key("dialog-cancel"))
        .child(confirm)
}

pub fn dialogs(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let (Some(d), Some(feature)) = (&s.card.dialog, &s.card.detail) else { return };
    if s.screen != Screen::Board || s.selected.as_deref() != Some(&feature.feature.id) {
        return;
    }
    let busy = s.busy;
    let dialog = |key: &str, title: String| KitDialog::new(key.to_owned(), title).width(440.0).fit().open(true).close_disabled(busy).on_close(close);
    match d {
        Dialog::Reject(reason) => {
            let submit = |s: &mut State, _: &mut Tx| reject(s);
            let field = Field::new()
                .label("Reason (optional)")
                .control(
                    TextArea::new(reason)
                        .label("Reason (optional)")
                        .placeholder("The API shape does not match the design")
                        .width(None)
                        .rows(3)
                        .on_edit(reason_mut)
                        .on_submit(submit)
                        .build(k)
                        .key("reject-reason"),
                )
                .build(k);
            let confirm = Button::new("Reject and send back").variant(ButtonVariant::Contrast).disabled(busy).on_press_tx(submit).build(k).key("reject-confirm");
            dialog("reject-dialog", "Reject this card".into())
                .description("It goes back a stage, to the backlog from the first, so the work can be redone.")
                .child(col().w_full().px(16.0).child(field))
                .child(buttons(k, busy, confirm))
                .build(k, layer);
        }
        Dialog::Delete => {
            let prs: Vec<u64> = feature.pull_requests.iter().map(|p| p.number).collect();
            let text = delete_consequences(feature.feature.branch_name.as_deref(), &feature.runs, &prs);
            let (id, title) = (feature.feature.id.clone(), feature.feature.title.clone());
            let confirm = Button::new("Delete this card")
                .variant(ButtonVariant::Danger)
                .disabled(busy)
                .on_press(move |s: &mut State| {
                    s.busy = true;
                    s.card.dialog = None;
                    let (feature, title) = (id.clone(), title.clone());
                    s.conn.spawn(move |c| Msg::Deleted { result: c.delete_feature(&feature), feature, title });
                })
                .build(k)
                .key("delete-confirm");
            dialog("delete-dialog", format!("Delete “{}”?", super::clip_title(&feature.feature.title)))
                .description(text)
                .child(buttons(k, busy, confirm))
                .build(k, layer);
        }
        Dialog::Rollback => {
            let Some(run) = feature.runs.first().map(|r| r.id.clone()) else { return };
            let confirm = Button::new("Undo the run")
                .variant(ButtonVariant::Danger)
                .disabled(busy)
                .on_press(move |s: &mut State| {
                    let run = run.clone();
                    act(s, move |c| c.rollback_run(&run));
                })
                .build(k)
                .key("rollback-confirm");
            dialog("rollback-dialog", "Undo this run?".into())
                .description("The sandbox goes back to how it was before the agent started. Anything it wrote since is lost.")
                .child(buttons(k, busy, confirm))
                .build(k, layer);
        }
        Dialog::Move => {
            let here = s.lane_of(&feature.feature.id).map(|l| l.key());
            let mut list = col().w_full().px(16.0).gap(6.0);
            for lane in &s.lanes {
                let dest = lane.kind.clone();
                let current = here.as_deref() == Some(lane.key().as_str());
                let name = if current { format!("{} (here now)", lane.name) } else { lane.name.clone() };
                let mut b = Button::new(name)
                    .variant(ButtonVariant::Outline)
                    .disabled(busy || current)
                    .on_press(move |s: &mut State| move_to(s, dest.clone()));
                if let LaneKind::Stage(_) = lane.kind {
                    b = b.help(format!("{} · {}", lane.rule, lane.agent));
                }
                list = list.child(b.build(k).w_full().key(format!("move-{}", lane.key())));
            }
            let note = label("Entering a stage with an assigned agent starts that agent.", 12.0, 400.0, t.faint).wrap();
            dialog("move-dialog", "Move this card".into())
                .child(list.child(note))
                .child(row().w_full().padding(16.0).justify_end().child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(close).build(k).key("dialog-cancel")))
                .build(k, layer);
        }
    }
}

fn reason_mut(s: &mut State) -> &mut TextEdit {
    match &mut s.card.dialog {
        Some(Dialog::Reject(r)) => r,
        _ => &mut s.card.scratch,
    }
}

fn reject(s: &mut State) {
    let Some(Dialog::Reject(reason)) = &s.card.dialog else { return };
    let reason = reason.text.trim().to_owned();
    let Some(id) = s.card.feature.clone() else { return };
    if reason.is_empty() {
        s.card.dialog = None;
        data::act(s, &id, Action::Reject);
    } else {
        act(s, move |c| c.reject_feature(&id, Some(&reason)).map(drop));
    }
}

fn move_to(s: &mut State, dest: LaneKind) {
    let Some(id) = s.card.feature.clone() else { return };
    act(s, move |c| match dest {
        LaneKind::Backlog => c.move_feature(&id, None).map(drop),
        LaneKind::Stage(stage) => c.move_feature(&id, Some(&stage)).map(drop),
        LaneKind::Completed => c.finish_feature(&id).map(drop),
    });
}
