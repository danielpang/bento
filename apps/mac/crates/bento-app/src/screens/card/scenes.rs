//! Headless fixture scenes for the drawer's actions. Nothing here reaches a server.

use bento_client::{CardDetail, PullRequestState, RunQuestion, TurnState};
use rune::TextEdit;
use serde_json::{Value, json};

use super::questions::Asked;
use super::{CardState, Dialog};
use crate::pages::Scene;
use crate::state::{NewCard, State};

const AGENTS: &str = r#"[{"id": "agent-implementation", "name": "Software Engineer", "cli": "claude-code", "model": "claude-sonnet-5"},
    {"id": "agent-investigation", "name": "Product Manager", "cli": "claude-code", "model": "claude-sonnet-5"}]"#;

fn stages(create_pr: bool) -> Value {
    json!([
        {"id": "investigation", "pipelineId": "pl", "position": 0, "name": "Product investigation", "gateType": "manual", "defaultAgentProfileId": "agent-investigation"},
        {"id": "implementation", "pipelineId": "pl", "position": 1, "name": "Implementation", "gateType": "auto", "defaultAgentProfileId": "agent-implementation", "createPr": create_pr},
        {"id": "review", "pipelineId": "pl", "position": 2, "name": "Code review", "gateType": "manual"}
    ])
}

/// The board with `id` open, and the drawer's reads already in.
fn open(s: &mut State, id: &str, detail: Value, create_pr: bool) {
    crate::fixtures::board(s);
    s.selected = Some(id.into());
    if s.transcript.feature != id {
        s.transcript = crate::state::Transcript { feature: id.into(), ..Default::default() };
    }
    let detail: CardDetail = serde_json::from_value(detail).unwrap();
    s.card = CardState {
        feature: Some(id.into()),
        detail: Some(detail),
        stages: serde_json::from_value(stages(create_pr)).unwrap(),
        profiles: serde_json::from_str(AGENTS).unwrap(),
        can_publish: Some(true),
        repos: serde_json::from_value(json!([{"id": "repo", "name": "bento", "repoUrl": "https://github.com/acme/bento"}])).unwrap(),
        ..CardState::default()
    };
}

fn running(s: &mut State, live: bool) {
    open(
        s,
        "webhooks",
        json!({"id": "webhooks", "projectId": "bento", "title": "Retry failed webhook deliveries", "status": "active", "currentStageId": "implementation",
            "branchName": "bento/retry-failed-webhook-deliveries-1f2a",
            "runs": [{"id": "run-webhooks", "featureId": "webhooks", "agentProfileId": "agent-implementation", "status": "running", "role": "stage", "liveSession": live}]}),
        false,
    );
}

fn ask(s: &mut State, questions: Value) {
    let q: RunQuestion = serde_json::from_value(json!({"id": "q1", "runId": "run-webhooks", "questions": questions})).unwrap();
    s.card.questions.feature = "webhooks".into();
    s.card.questions.run = Some("run-webhooks".into());
    s.card.questions.list = vec![Asked::new(q)];
    s.card.asking = vec!["webhooks".into()];
    s.card.turn.on_turn(TurnState::Waiting);
}

fn one_question() -> Value {
    json!([{"question": "Should retries stop after a day, or after a fixed number of attempts?", "header": "Retry limit", "multiSelect": false, "options": [
        {"label": "After a day", "description": "Keep trying with backoff until 24 hours have passed."},
        {"label": "Twelve attempts", "description": "Stop after the twelfth failure, whatever the time."}
    ]}])
}

fn two_questions() -> Value {
    json!([
        {"question": "Which queue should hold the retries?", "header": "Queue", "multiSelect": false, "options": [{"label": "pg-boss"}, {"label": "A new table"}]},
        {"question": "Which checks should run before it opens the pull request?", "header": "Checks", "multiSelect": true, "options": [{"label": "Lint"}, {"label": "Unit tests"}, {"label": "Type check"}]}
    ])
}

fn with_pull_requests(s: &mut State) {
    open(
        s,
        "events",
        json!({"id": "events", "projectId": "bento", "title": "Paginate run events", "status": "active", "currentStageId": "implementation",
            "branchName": "bento/paginate-run-events-9c1d", "prNumber": 412, "prUrl": "https://github.com/acme/bento/pull/412",
            "runs": [{"id": "run-events", "featureId": "events", "agentProfileId": "agent-implementation", "status": "failed", "role": "stage", "checkpointId": "c1", "costUsd": "2.07"}],
            "pullRequests": [{"name": "bento", "number": 412, "url": "https://github.com/acme/bento/pull/412"}],
            "pullRequestHistory": [
                {"name": "bento", "number": 412, "url": "https://github.com/acme/bento/pull/412", "branch": "bento/paginate-run-events-9c1d", "current": true},
                {"name": "bento", "number": 388, "url": "https://github.com/acme/bento/pull/388", "branch": "bento/paginate-run-events", "current": false}
            ]}),
        true,
    );
    let state = |url: &str, n: u64, st: &str| PullRequestState { url: url.into(), number: n, state: st.into() };
    s.card.merge = vec![state("https://github.com/acme/bento/pull/412", 412, "conflicted")];
    s.card.checks = vec![state("https://github.com/acme/bento/pull/412", 412, "failed")];
    s.card.ended = vec![state("https://github.com/acme/bento/pull/412", 412, "open"), state("https://github.com/acme/bento/pull/388", 388, "merged")];
}

fn publishable(s: &mut State, can_publish: Option<bool>) {
    open(
        s,
        "events",
        json!({"id": "events", "projectId": "bento", "title": "Paginate run events", "status": "active", "currentStageId": "implementation",
            "branchName": "bento/paginate-run-events-9c1d",
            "runs": [{"id": "run-events", "featureId": "events", "agentProfileId": "agent-implementation", "status": "succeeded", "role": "stage"}]}),
        true,
    );
    s.card.can_publish = can_publish;
}

fn gated(s: &mut State) {
    open(
        s,
        "contributing",
        json!({"id": "contributing", "projectId": "bento", "title": "Add a CONTRIBUTING guide", "status": "gated", "currentStageId": "investigation",
            "branchName": "bento/add-a-contributing-guide-77aa",
            "runs": [{"id": "run-c", "featureId": "contributing", "agentProfileId": "agent-investigation", "status": "succeeded", "role": "stage", "checkpointId": "c2", "costUsd": "0.31"},
                     {"id": "run-c0", "featureId": "contributing", "agentProfileId": "agent-investigation", "status": "succeeded", "role": "stage", "costUsd": "0.12"}]}),
        false,
    );
}

pub const SCENES: &[Scene] = &[
    ("card/question", |s| {
        running(s, true);
        ask(s, one_question());
    }),
    ("card/question-picked", |s| {
        running(s, true);
        ask(s, one_question());
        s.card.questions.list[0].pick(0, "Twelve attempts", true);
    }),
    ("card/questions", |s| {
        running(s, true);
        ask(s, two_questions());
        let a = &mut s.card.questions.list[0];
        a.pick(0, "pg-boss", true);
        a.step = 1;
        a.pick(1, "Lint", true);
        a.pick(1, "Unit tests", true);
    }),
    ("card/questions-review", |s| {
        running(s, true);
        ask(s, two_questions());
        let a = &mut s.card.questions.list[0];
        a.pick(0, "A new table", true);
        a.pick(1, "Type check", true);
        a.other[1] = TextEdit::new("The webhook e2e suite");
        a.step = 2;
        a.error = Some("This question is no longer waiting for an answer.".into());
    }),
    ("card/stop-interrupt", |s| {
        running(s, true);
        s.card.turn.on_turn(TurnState::Working);
    }),
    ("card/pull-requests", with_pull_requests),
    ("card/publish", |s| publishable(s, Some(true))),
    ("card/publish-no-github", |s| publishable(s, Some(false))),
    ("card/publish-nothing", |s| {
        publishable(s, Some(true));
        s.card.notes = vec![("Nothing to publish: the branch has no commits beyond the base branch.".into(), false)];
    }),
    ("card/publish-no-branch", |s| {
        publishable(s, Some(true));
        if let Some(d) = s.card.detail.as_mut() {
            d.feature.branch_name = None;
        }
    }),
    ("card/more", |s| {
        gated(s);
        s.card.more = true;
    }),
    ("card/reject", |s| {
        gated(s);
        s.card.dialog = Some(Dialog::Reject(Box::new(TextEdit::new("The guide skips how to run the e2e tests."))));
    }),
    ("card/delete", |s| {
        with_pull_requests(s);
        s.card.dialog = Some(Dialog::Delete);
    }),
    ("card/rollback", |s| {
        gated(s);
        s.card.dialog = Some(Dialog::Rollback);
    }),
    ("card/move", |s| {
        gated(s);
        s.card.dialog = Some(Dialog::Move);
    }),
    ("card/board", |s| {
        running(s, true);
        ask(s, one_question());
        s.selected = None;
        if let Some(c) = s.lanes.iter_mut().flat_map(|l| l.cards.iter_mut()).find(|c| c.id == "copy") {
            c.pr = Some((377, Some("https://github.com/acme/bento/pull/377".into())));
        }
        if let Some(c) = s.lanes.iter_mut().flat_map(|l| l.cards.iter_mut()).find(|c| c.id == "events") {
            c.pr = Some((412, None));
        }
    }),
    ("card/new-start-now", |s| {
        crate::fixtures::board(s);
        let mut form = NewCard::new();
        form.title = TextEdit::new("Add a rate limit to the public API");
        form.description = TextEdit::new("Limit each API key to 100 requests a minute on the public routes. Leave the webhooks alone.");
        s.new_card = Some(form);
        s.card.start_now.on = true;
    }),
    ("card/session-question", |s| {
        let (_, live) = crate::pages::sessions::SCENES.iter().find(|(name, _)| *name == "sessions").expect("the Sessions scene");
        live(s);
        let q: RunQuestion = serde_json::from_value(json!({"id": "q1", "runId": "run-webhooks", "questions": one_question()})).unwrap();
        if let Some(o) = s.sessions.open.as_mut() {
            o.questions.feature = "webhooks".into();
            o.questions.run = Some("run-webhooks".into());
            o.questions.list = vec![Asked::new(q)];
        }
    }),
];
