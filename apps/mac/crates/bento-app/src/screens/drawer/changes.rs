//! A card's committed changes: the files per repository and the diff. The Sessions page's
//! inspector and the card drawer both draw them from here.

use bento_client::FeatureChanges;
use rune::{El, ScrollSpec, Tx, col, el, row};
use rune_kit::Kit;
use rune_kit::diff::{self, DiffState, DiffView};

use crate::pages::artifacts::Load;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

pub fn has_diff(c: &FeatureChanges) -> bool {
    c.repositories.iter().any(|r| !r.diff.trim().is_empty())
}

pub fn is_empty(c: &FeatureChanges) -> bool {
    c.repositories.iter().all(|r| r.files.is_empty())
}

/// Puts the changes' diff in `state`, keeping how it is shown when it already held one.
pub fn show(state: &mut DiffState, c: &FeatureChanges) {
    let files = c.repositories.iter().flat_map(|r| diff::parse(&r.diff)).collect::<Vec<_>>();
    if state.files().is_empty() {
        let wrap = state.wrap();
        *state = DiffState::new(files);
        state.set_wrap(wrap);
    } else {
        state.set_files(files);
    }
}

/// One row per changed file with its line counts; pressing one calls `pick` with its path.
pub fn files(c: &FeatureChanges, t: &Tokens, pick: fn(&mut State, &str, &mut Tx)) -> El {
    let many = c.repositories.len() > 1;
    let mut list = col().w_full().gap(2.0);
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
                .on_press_tx(move |s: &mut State, tx: &mut Tx| pick(s, &path, tx))
                .child(mono(shown, 11.5, t.dim).truncate().grow(1.0).shrink())
                .child(mono(format!("+{}", file.additions), 11.5, t.succeeded))
                .child(if file.deletions > 0 { mono(format!("-{}", file.deletions), 11.5, t.failed) } else { el() });
            list = list.child(row_el);
        }
        if r.truncated {
            list = list.child(label("The diff is too large to show in full.", 11.5, 400.0, t.faint).wrap());
        }
    }
    list
}

fn pick(s: &mut State, path: &str, tx: &mut Tx) {
    if let Some(i) = s.review.diff.file_index(path) {
        s.review.diff.scroll_to_file(i, tx);
    }
}

/// A read that failed, in the console's words, with the reason under it.
pub fn failed(message: &str, t: &Tokens) -> El {
    col()
        .w_full()
        .gap(4.0)
        .child(label("Could not load this card's details. Check the connection and reopen the card.", 12.5, 450.0, t.failed).wrap())
        .child(label(message.to_owned(), 11.5, 400.0, t.faint).wrap().selectable(true))
}

fn note(text: &str, t: &Tokens) -> El {
    label(text.to_owned(), 12.5, 400.0, t.faint).wrap()
}

/// The drawer's Changes tab: each repository's counts, its files, then the diff.
pub fn tab(s: &State, card: &str, t: &Tokens, k: &Kit) -> El {
    let frame = col().key("drawer-changes").w_full().grow(1.0).shrink().min_h(0.0).gap(10.0);
    let Some(r) = s.review.of(card) else { return frame.child(note("Loading the changes.", t)) };
    let c = match &r.changes {
        Load::Loading => return frame.child(note("Loading the changes.", t)),
        Load::Failed { message, .. } => {
            return frame.child(failed(message, t));
        }
        Load::Ready(c) => c,
    };
    if c.repositories.is_empty() || is_empty(c) {
        return frame.child(note("Nothing committed yet. Changes and stage write-ups appear once an agent commits.", t));
    }
    let mut head = col().key("drawer-files").w_full().gap(6.0);
    for repo in &c.repositories {
        let (adds, dels) = repo.files.iter().fold((0, 0), |(a, d), f| (a + f.additions, d + f.deletions));
        let n = repo.files.len();
        head = head.child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .flex_wrap()
                .child(label(repo.name.clone(), 12.5, 600.0, t.text))
                .child(mono(format!("+{adds}"), 11.5, t.succeeded))
                .child(mono(format!("-{dels}"), 11.5, t.failed))
                .child(label(format!("in {n} file{}", if n == 1 { "" } else { "s" }), 12.0, 400.0, t.faint)),
        );
    }
    head = head.child(files(c, t, pick));
    let head = col().key("drawer-files-scroll").w_full().max_h(180.0).scroll(ScrollSpec::default()).child(head);
    let mut out = frame.child(head);
    if has_diff(c) {
        let view = DiffView::new(|s: &State| &s.review.diff, |s: &mut State| &mut s.review.diff).key("drawer-diff").scroll_bar(true).build(s, k);
        out = out.child(col().w_full().grow(1.0).shrink().min_h(0.0).border(1.0, t.line).radius(8.0).clip_rounded(8.0).child(view.w_full().h_full()));
    }
    out
}
