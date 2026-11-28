//! A card's pull requests: Create PR, each one's state and link, Fix conflicts and Fix CI Tests,
//! offered when and how the console's drawer offers them.

use bento_client::{CardPullRequest, Published, PullRequest};
use rune::{El, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, Kit};

use super::{CardState, Msg};
use crate::data::err;
use crate::state::State;
use crate::theme::{Tokens, label};

pub const REPOSITORY_SETUP_MESSAGE: &str = "This project has no repositories, so agents cannot run. Open Repositories in the top bar and add one.";
const NO_BRANCH: &str = "Run an agent on this card first.";
const NO_GITHUB: &str = "Needs a GitHub connection. Save a GitHub token under Settings, GitHub.";
const NO_REMOTE: &str = "This repository has no GitHub remote configured.";

impl CardState {
    fn finished(&self) -> bool {
        self.detail.as_ref().is_some_and(|d| d.feature.status.is_finished())
    }

    /// The stage pushes a branch and opens pull requests, so every repository gets a row.
    pub fn shows_pull_requests(&self) -> bool {
        self.stage().is_some_and(|st| st.create_pr)
    }

    /// Why Create PR cannot be pressed, in the console's words; None when it can.
    pub fn publish_refusal(&self) -> Option<&'static str> {
        let d = self.detail.as_ref()?;
        if d.feature.branch_name.is_none() {
            Some(NO_BRANCH)
        } else if self.can_publish == Some(false) {
            Some(NO_GITHUB)
        } else if self.run_active() {
            Some("An agent is working this card. Publish when it finishes.")
        } else if self.no_repositories() {
            Some(REPOSITORY_SETUP_MESSAGE)
        } else {
            None
        }
    }

    fn state_of<'a>(list: &'a [bento_client::PullRequestState], url: &str) -> Option<&'a str> {
        list.iter().find(|p| p.url == url).map(|p| p.state.as_str())
    }
}

fn create_pr(s: &State, k: &Kit, refusal: Option<&'static str>, key: String) -> El {
    let name = if s.card.publishing { "Creating..." } else { "Create PR" };
    let mut b = Button::new(name).variant(ButtonVariant::Neutral).disabled(s.busy || refusal.is_some()).on_press(publish);
    if let Some(r) = refusal {
        b = b.help(r);
    }
    b.build(k).key(key)
}

/// Create PR beside the other card actions, on a stage that opens pull requests.
pub fn create_pr_action(s: &State, k: &Kit) -> Option<El> {
    s.card.shows_pull_requests().then(|| create_pr(s, k, s.card.publish_refusal(), "create-pr".into()))
}

pub fn publish(s: &mut State) {
    let Some(feature) = s.card.feature.clone() else { return };
    if s.card.publishing || s.card.publish_refusal().is_some() {
        return;
    }
    s.card.publishing = true;
    s.card.notes.clear();
    s.busy = true;
    s.toast("Creating the pull request. It will show up here shortly.");
    s.conn.spawn(move |c| Msg::Published { result: c.publish_feature(&feature).map_err(err), feature });
}

pub fn published(s: &mut State, feature: &str, result: Result<Published, String>) {
    let p = match result {
        Ok(p) => p,
        Err(e) => {
            s.toast(e);
            return;
        }
    };
    if p.rebase_run.is_some() {
        s.toast("The branch is behind the base branch. A rebase run was started; the pull request will be created when it finishes.");
    } else if p.published.iter().any(|pr| pr.draft == Some(true)) {
        s.toast("Opened draft pull requests for repositories that could not be rebased automatically. They may have merge conflicts until rebased.");
    }
    if s.card.feature.as_deref() != Some(feature) {
        return;
    }
    s.card.notes = if !p.failures.is_empty() {
        p.failures.iter().map(|f| (format!("Could not publish {}: {}", f.name, f.reason), true)).collect()
    } else if p.published.is_empty() {
        vec![("Nothing to publish: the branch has no commits beyond the base branch.".into(), false)]
    } else {
        Vec::new()
    };
    // Merge rather than replace: a repository with no new commits is not in this answer.
    if let Some(d) = s.card.detail.as_mut() {
        for pr in &p.published {
            d.pull_requests.retain(|x| x.url != pr.url);
            d.pull_requests.push(PullRequest { name: pr.name.clone(), number: pr.pr_number, url: pr.url.clone() });
        }
    }
    crate::data::refetch_board(s);
    super::load(s);
}

fn start(s: &mut State, conflicts: bool) {
    let Some(feature) = s.card.feature.clone() else { return };
    s.busy = true;
    s.conn.spawn(move |c| {
        let (result, note) = if conflicts {
            (c.resolve_conflicts(&feature), "Fixing conflicts. The stage agent rebases the branch, and the pull request updates when it finishes.")
        } else {
            (c.fix_ci_tests(&feature), "Fixing CI. The stage agent will commit fixes, and the pull request updates when it finishes.")
        };
        Msg::Started { result: result.map(drop).map_err(err), note, feature }
    });
}

fn chip(text: &str, color: rune::color::Color, t: &Tokens) -> El {
    label(text.to_owned(), 11.0, 500.0, color).px(8.0).py(2.0).radius(9.0).border(1.0, t.line)
}

struct RowSpec<'a> {
    name: &'a str,
    repo_url: Option<&'a str>,
    pr: Option<(u64, &'a str)>,
    branch: Option<&'a str>,
    live: bool,
}

fn pr_row(s: &State, r: RowSpec, n: usize, t: &Tokens, k: &Kit) -> El {
    let c = &s.card;
    let finished = c.finished();
    let url = r.pr.map(|(_, u)| u);
    let conflicted = r.live && url.is_some_and(|u| CardState::state_of(&c.merge, u) == Some("conflicted"));
    let ci_failed = r.live && url.is_some_and(|u| CardState::state_of(&c.checks, u) == Some("failed"));
    let state = url.and_then(|u| CardState::state_of(&c.ended, u)).filter(|st| *st != "unknown" && (!r.live || *st != "open"));
    let mut line = row().key(format!("pr-row-{n}")).w_full().gap(8.0).center_y().flex_wrap().child(label(r.name.to_owned(), 12.5, 500.0, t.text));
    if let Some(b) = r.branch {
        line = line.child(label(b.to_owned(), 11.5, 400.0, t.faint).truncate().shrink());
    }
    if conflicted {
        line = line.child(chip("Merge conflict", t.failed, t));
    }
    if ci_failed {
        line = line.child(chip("CI failing", t.failed, t));
    }
    if let Some(st) = state {
        let (word, color) = match st {
            "merged" => ("Merged", t.succeeded),
            "open" => ("Open", t.running),
            _ => ("Closed", t.faint),
        };
        line = line.child(chip(word, color, t));
    }
    line = line.child(spacer());
    let mut buttons = row().w_full().gap(8.0).justify_end();
    let mut any = false;
    let busy = s.busy || c.run_active();
    if r.pr.is_none() && r.live {
        let refusal = if r.repo_url.is_none() && c.detail.as_ref().is_some_and(|d| d.feature.branch_name.is_some()) { Some(NO_REMOTE) } else { c.publish_refusal() };
        buttons = buttons.child(create_pr(s, k, refusal, format!("pr-create-{n}")));
        any = true;
    }
    let working = c.run_active().then_some(());
    if conflicted && !finished {
        let help = working.map_or("The stage agent rebases the branch onto the latest base branch and resolves the conflicts.", |_| {
            "An agent is working this card. Fix conflicts when it finishes."
        });
        let b = Button::new("Fix conflicts").variant(ButtonVariant::Ghost).disabled(busy).help(help).on_press(|s: &mut State| start(s, true));
        buttons = buttons.child(b.build(k).key(format!("pr-fix-conflicts-{n}")));
        any = true;
    }
    if ci_failed && !finished {
        let help = working.map_or("The stage agent fixes the failing CI checks and commits the result.", |_| "An agent is working this card. Fix CI tests when it finishes.");
        let b = Button::new("Fix CI Tests").variant(ButtonVariant::Ghost).disabled(busy).help(help).on_press(|s: &mut State| start(s, false));
        buttons = buttons.child(b.build(k).key(format!("pr-fix-ci-{n}")));
        any = true;
    }
    if let Some((number, url)) = r.pr {
        let url = url.to_owned();
        let open = Button::new(format!("#{number} ↗"))
            .variant(ButtonVariant::Ghost)
            .help(format!("Open pull request #{number} in {} on GitHub", r.name))
            .on_press_tx(move |s: &mut State, tx: &mut Tx| {
                if let Err(e) = tx.open_url(&url) {
                    s.toast(e.to_string());
                }
            });
        line = line.child(open.build(k).key(format!("pr-open-{n}")));
    }
    if any { col().w_full().gap(4.0).child(line).child(buttons) } else { line }
}

/// The Pull requests section, when the stage opens them or the card has opened any.
pub fn panel(s: &State, t: &Tokens, k: &Kit) -> Option<El> {
    let c = &s.card;
    let d = c.detail.as_ref()?;
    let show = c.shows_pull_requests() && d.feature.current_stage_id.is_some();
    let listed: Vec<&CardPullRequest> = d.pull_request_history.iter().filter(|pr| !show || !pr.current).collect();
    if !show && listed.is_empty() {
        return None;
    }
    let finished = c.finished();
    let mut p = col().key("pull-requests").w_full().gap(8.0).child(label("PULL REQUESTS", 11.0, 500.0, t.faint));
    let conflicted = c.merge.iter().filter(|m| m.state == "conflicted").count();
    let failing = c.checks.iter().filter(|m| m.state == "failed").count();
    if show && conflicted > 0 && !finished {
        let which = if conflicted == 1 { "this card's pull request" } else { "some of this card's pull requests" };
        p = p.child(
            label(format!("GitHub cannot merge {which}: the base branch has moved and the changes collide. Use Fix conflicts on the row below."), 12.0, 400.0, t.gated)
                .wrap(),
        );
    }
    if show && failing > 0 && !finished {
        let which = if failing == 1 { "CI checks are failing on this card's pull request." } else { "CI checks are failing on some of this card's pull requests." };
        p = p.child(label(format!("{which} Use Fix CI Tests on the row below."), 12.0, 400.0, t.gated).wrap());
    }
    let mut n = 0;
    let mut next = || {
        n += 1;
        n - 1
    };
    if show && c.no_repositories() {
        p = p.child(label(REPOSITORY_SETUP_MESSAGE, 12.0, 400.0, t.dim).wrap());
    } else {
        if show {
            let repos = c.repos.as_deref().unwrap_or_default();
            for repo in repos {
                let pr = d.pull_requests.iter().find(|pr| pr.name == repo.name);
                let spec = RowSpec { name: &repo.name, repo_url: repo.repo_url.as_deref(), pr: pr.map(|pr| (pr.number, pr.url.as_str())), branch: None, live: true };
                p = p.child(pr_row(s, spec, next(), t, k));
            }
            for pr in d.pull_requests.iter().filter(|pr| !repos.iter().any(|r| r.name == pr.name)) {
                let spec = RowSpec { name: &pr.name, repo_url: Some(&pr.url), pr: Some((pr.number, &pr.url)), branch: None, live: true };
                p = p.child(pr_row(s, spec, next(), t, k));
            }
        }
        for pr in listed {
            let spec = RowSpec { name: &pr.name, repo_url: Some(&pr.url), pr: Some((pr.number, &pr.url)), branch: (!pr.current).then_some(pr.branch.as_str()), live: false };
            p = p.child(pr_row(s, spec, next(), t, k));
        }
    }
    if show && let Some(r) = c.publish_refusal().filter(|_| d.pull_requests.is_empty() && !c.no_repositories()) {
        p = p.child(label(r, 12.0, 400.0, t.faint).wrap().key("publish-refusal"));
    }
    for (i, (text, failed)) in c.notes.iter().enumerate() {
        p = p.child(label(text.clone(), 12.0, 400.0, if *failed { t.failed } else { t.dim }).wrap().selectable(true).key(format!("publish-note-{i}")));
    }
    Some(p)
}
