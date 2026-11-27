//! The drawer's Artifacts tab: what the card's runs produced, newest first, one read in place
//! with the Artifacts page's reader.

use bento_client::RunArtifact;
use rune::{El, ScrollSpec, col, row};
use rune_kit::{Button, ButtonVariant, Kit};

use super::{Review, read};
use crate::pages::artifacts::{Load, base_name, note, open_button, preview, short_id};
use crate::state::State;
use crate::theme::{Tokens, label, mono};

/// How many the tab lists before asking, as the console's drawer does.
const PREVIEW: usize = 6;

/// The console's drawer words for an artifact's kind.
fn kind_words(kind: &str) -> &'static str {
    match kind {
        "markdown" => "Doc",
        "mermaid" => "Diagram",
        "image" => "Image",
        "html" => "Page",
        _ => "File",
    }
}

/// The newest capture of each path.
fn newest(list: &[RunArtifact]) -> Vec<&RunArtifact> {
    let mut seen = Vec::new();
    list.iter().filter(|a| !seen.contains(&a.path.as_str()) && { seen.push(a.path.as_str()); true }).collect()
}

fn artifact_row(a: &RunArtifact, t: &Tokens) -> El {
    let id = a.id.clone();
    row()
        .key(format!("drawer-artifact-{}", a.id))
        .w_full()
        .px(8.0)
        .py(7.0)
        .gap(10.0)
        .radius(7.0)
        .center_y()
        .hover_fill(t.raised)
        .role("button")
        .label(base_name(&a.path).to_owned())
        .focusable(true)
        .on_press(move |s: &mut State| read(s, &id))
        .child(row().h(20.0).px(7.0).radius(10.0).center().border(1.0, t.line).child(label(kind_words(&a.kind), 10.5, 500.0, t.dim)))
        .child(label(base_name(&a.path).to_owned(), 12.5, 450.0, t.text).truncate().grow(1.0).shrink())
        .child(label(a.stage_name.clone(), 11.0, 400.0, t.faint).truncate().max_w(140.0))
}

fn reader(s: &State, r: &Review, a: &RunArtifact, t: &Tokens, k: &Kit) -> El {
    let client = s.conn.client.as_ref();
    let back = Button::new("All artifacts").variant(ButtonVariant::Ghost).on_press(|s: &mut State| s.review.reading = None).build(k).key("drawer-artifact-back");
    let mut head = row().key("drawer-artifact-head").w_full().gap(8.0).center_y().child(back).child(
        col()
            .grow(1.0)
            .shrink()
            .min_w(0.0)
            .gap(2.0)
            .child(label(base_name(&a.path).to_owned(), 13.0, 600.0, t.text).truncate())
            .child(mono(a.path.clone(), 10.5, t.faint).truncate_middle()),
    );
    if let Some(open) = open_button(a, client, k) {
        head = head.child(open);
    }
    let body = r.body.as_ref().filter(|(id, _)| *id == a.id).map(|(_, b)| b);
    let run = r.detail.as_ref().and_then(|d| d.runs.iter().find(|x| x.id == a.run_id));
    let made_by = match run.and_then(|x| r.agent_name(&x.agent_profile_id)) {
        Some(agent) => format!("{agent}, run {}", short_id(&a.run_id)),
        None => format!("Run {}", short_id(&a.run_id)),
    };
    col()
        .key("drawer-artifact")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .gap(8.0)
        .child(head)
        .child(col().w_full().grow(1.0).shrink().min_h(0.0).border(1.0, t.line).radius(8.0).clip_rounded(8.0).child(preview(a, body, &made_by, client, t, k)))
}

pub fn tab(s: &State, card: &str, t: &Tokens, k: &Kit) -> El {
    let frame = col().key("drawer-artifacts").w_full().grow(1.0).shrink().min_h(0.0);
    let Some(r) = s.review.of(card) else { return frame.child(note("Loading artifacts.", t)) };
    let list = match &r.artifacts {
        Load::Loading => return frame.child(note("Loading artifacts.", t)),
        Load::Failed { message, .. } => return frame.child(super::changes::failed(message, t)),
        Load::Ready(list) => list,
    };
    if let Some(a) = r.reading.as_ref().and_then(|id| list.iter().find(|a| a.id == *id)) {
        return frame.child(reader(s, r, a, t, k));
    }
    let shown = newest(list);
    if shown.is_empty() {
        return frame.child(note("No artifacts on this card", t));
    }
    let total = shown.len();
    let mut rows = col().key("drawer-artifact-list").w_full().gap(1.0);
    for a in shown.iter().take(if r.all_artifacts { total } else { PREVIEW }) {
        rows = rows.child(artifact_row(a, t));
    }
    if total > PREVIEW {
        let words = if r.all_artifacts { "Show less".to_owned() } else { format!("Show all {total}") };
        rows = rows.child(
            Button::new(words).variant(ButtonVariant::Ghost).on_press(|s: &mut State| s.review.all_artifacts = !s.review.all_artifacts).build(k).key("drawer-artifacts-all"),
        );
    }
    frame.child(col().w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec::default()).child(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_captured_twice_lists_once_newest_first() {
        let a = |id: &str, path: &str| RunArtifact {
            id: id.into(),
            run_id: "r".into(),
            stage_slug: String::new(),
            stage_name: String::new(),
            path: path.into(),
            kind: "markdown".into(),
            mime: "text/markdown".into(),
            size: 1,
            created_at: String::new(),
        };
        let list = [a("new", "plan.md"), a("shot", "shot.png"), a("old", "plan.md")];
        assert_eq!(newest(&list).iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["new", "shot"]);
        assert_eq!(kind_words("html"), "Page");
    }
}
