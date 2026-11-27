//! Fixture state for headless scenes. Nothing here reaches a server.

use bento_client::{AgentEvent, MessageRole, RunStatus, ToolPhase};

use crate::data;
use crate::model::{AUTO_RULE, Card, Lane, LaneKind, NO_AGENT, REVIEW_RULE, Status};
use crate::state::{Block, NewCard, Phase, ProjectRow, State, Transcript};

fn card(id: &str, title: &str, note: &str, agent: &str, status: Status) -> Card {
    let run_status = match status {
        Status::Running => Some(RunStatus::Running),
        Status::Gated | Status::Succeeded => Some(RunStatus::Succeeded),
        Status::Failed => Some(RunStatus::Failed),
        Status::Idle => None,
    };
    Card {
        id: id.into(),
        title: title.into(),
        description: String::new(),
        note: note.into(),
        agent: agent.into(),
        status,
        run_id: run_status.map(|_| format!("run-{id}")),
        run_status,
    }
}

fn stage(id: &str, name: &str, manual: bool, agent: Option<&str>, cards: Vec<Card>) -> Lane {
    Lane {
        kind: LaneKind::Stage(id.into()),
        name: name.into(),
        rule: if manual { REVIEW_RULE } else { AUTO_RULE }.into(),
        agent: agent.unwrap_or(NO_AGENT).into(),
        agent_profile_id: agent.map(|_| format!("agent-{id}")),
        cards,
    }
}

pub fn board(s: &mut State) {
    s.phase = Phase::Ready;
    s.loaded = true;
    s.projects = vec![ProjectRow { id: "bento".into(), name: "bento".into() }, ProjectRow { id: "site".into(), name: "usebento.ai".into() }];
    s.project = Some("bento".into());
    let other = |id, name| Lane { kind: id, name, rule: String::new(), agent: String::new(), agent_profile_id: None, cards: Vec::new() };
    let mut backlog = other(LaneKind::Backlog, "Backlog".into());
    backlog.cards = vec![card("image", "Audit sandbox image size", "", "", Status::Idle)];
    let mut completed = other(LaneKind::Completed, "Completed".into());
    completed.cards = vec![card("copy", "Rename stage gate copy", "Pull request created", "", Status::Succeeded)];
    s.lanes = vec![
        backlog,
        stage(
            "investigation",
            "Product investigation",
            true,
            Some("Product Manager"),
            vec![card("contributing", "Add a CONTRIBUTING guide", "Write-up ready. Two open questions.", "", Status::Gated)],
        ),
        stage(
            "implementation",
            "Implementation",
            false,
            Some("Software Engineer"),
            vec![
                card("webhooks", "Retry failed webhook deliveries", "Editing webhook/sender.ts", "Software Engineer", Status::Running),
                card("launcher", "Dark blue theme for the launcher", "Reading launcher/styles.css", "Software Engineer", Status::Running),
            ],
        ),
        stage(
            "review",
            "Code review",
            true,
            None,
            vec![card("events", "Paginate run events", "Checks failed on the pull request.", "", Status::Failed)],
        ),
        completed,
    ];
    s.selected = Some("webhooks".into());
    let msg = |role, text: &str| AgentEvent::Message { role, text: text.into() };
    let tool = |name: &str| AgentEvent::Tool { name: name.into(), phase: ToolPhase::Start, detail: None };
    s.transcript = Transcript {
        feature: "webhooks".into(),
        blocks: vec![Block {
            agent: "Software Engineer".into(),
            status: RunStatus::Succeeded,
            entries: data::entries(&[
                msg(MessageRole::User, "Retry deliveries that fail with a 5xx, with backoff, at most five times."),
                tool("Read"),
                tool("Read"),
                tool("Grep"),
                msg(MessageRole::Assistant, "The sender gives up after the first failure. I will add a retry loop in `webhook/sender.ts` with exponential backoff, capped at **five** attempts."),
            ]),
        }],
        live: Some(Block {
            agent: "Software Engineer".into(),
            status: RunStatus::Running,
            entries: data::entries(&[tool("Edit"), tool("Bash")]),
        }),
        draft: "Running the webhook tests now".into(),
        ..Transcript::default()
    };
}

pub fn no_inspector(s: &mut State) {
    board(s);
    s.inspector = rune_kit::shell::PaneState::new(400.0).range(320.0, 560.0).collapsed();
}

pub fn boot(s: &mut State) {
    s.phase = Phase::Booting("Starting the local database.".into());
}

pub fn boot_failed(s: &mut State) {
    s.phase = Phase::Failed("BENTO_SANDBOX_DRIVER must be \"local-process\" or \"docker\", not \"sprite\".".into());
}

pub fn empty(s: &mut State) {
    s.phase = Phase::Ready;
}

pub fn new_card(s: &mut State) {
    board(s);
    let mut form = NewCard::new();
    form.title = rune::TextEdit::new("Add a rate limit to the public API");
    s.new_card = Some(form);
}

pub fn gated(s: &mut State) {
    board(s);
    s.selected = Some("contributing".into());
    s.transcript = Transcript { feature: "contributing".into(), ..Transcript::default() };
    s.toast("feature is not in a stage");
}
