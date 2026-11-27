//! What the window shows, derived from server data. Pure, so it is tested without a server.

use std::collections::HashMap;

use bento_client::{AdvanceRule, AgentEvent, AgentProfile, Board, CardRun, Feature, FeatureStatus, MessageRole, RunStatus, ToolPhase};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Idle,
    Running,
    Gated,
    Failed,
    Succeeded,
}

impl Status {
    pub fn word(self) -> &'static str {
        match self {
            Status::Idle => "idle",
            Status::Running => "running",
            Status::Gated => "gated",
            Status::Failed => "failed",
            Status::Succeeded => "succeeded",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LaneKind {
    Backlog,
    Stage(String),
    Completed,
}

#[derive(Clone, Debug)]
pub struct Card {
    pub id: String,
    pub title: String,
    pub description: String,
    /// The agent's latest line, or a short note.
    pub note: String,
    /// Who is working it, for a running card.
    pub agent: String,
    pub status: Status,
    pub run_id: Option<String>,
    pub run_status: Option<RunStatus>,
}

#[derive(Clone, Debug)]
pub struct Lane {
    pub kind: LaneKind,
    pub name: String,
    /// "Review before advancing" or "Advances automatically"; empty for Backlog and Completed.
    pub rule: String,
    /// The assigned agent's name, "no agent assigned", or empty for Backlog and Completed.
    pub agent: String,
    pub agent_profile_id: Option<String>,
    pub cards: Vec<Card>,
}

impl Lane {
    pub fn key(&self) -> String {
        match &self.kind {
            LaneKind::Backlog => "backlog".into(),
            LaneKind::Stage(id) => format!("stage-{id}"),
            LaneKind::Completed => "completed".into(),
        }
    }
}

pub const REVIEW_RULE: &str = "Review before advancing";
pub const AUTO_RULE: &str = "Advances automatically";
pub const NO_AGENT: &str = "no agent assigned";

/// A card's status from its feature and its newest run: an active run wins, then a gate,
/// then how the last run ended.
pub fn status(feature: FeatureStatus, run: Option<&CardRun>) -> Status {
    let run = run.map(|r| r.status);
    if run.is_some_and(RunStatus::is_active) {
        return Status::Running;
    }
    if feature == FeatureStatus::Gated {
        return Status::Gated;
    }
    match run {
        Some(RunStatus::Failed) => Status::Failed,
        Some(RunStatus::Succeeded) => Status::Succeeded,
        _ if feature == FeatureStatus::Done => Status::Succeeded,
        _ => Status::Idle,
    }
}

fn board_order(a: &Feature, b: &Feature) -> std::cmp::Ordering {
    // board_position is a decimal string; lexical order is not numeric order.
    let pos = |f: &Feature| f.board_position.as_deref().and_then(|p| p.parse::<f64>().ok()).unwrap_or(f64::MAX);
    pos(a).total_cmp(&pos(b)).then_with(|| a.created_at.cmp(&b.created_at))
}

pub fn lanes(board: &Board, profiles: &[AgentProfile]) -> Vec<Lane> {
    let names: HashMap<&str, &str> = profiles.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
    let card = |f: &Feature, lane_agent: &str| {
        let run = board.runs.get(&f.id);
        let status = status(f.status, run);
        Card {
            id: f.id.clone(),
            title: f.title.clone(),
            description: f.description.clone(),
            note: run.and_then(|r| r.output.clone()).unwrap_or_default(),
            agent: if status == Status::Running { lane_agent.to_owned() } else { String::new() },
            status,
            run_id: run.and_then(|r| r.run_id.clone()),
            run_status: run.map(|r| r.status),
        }
    };
    fn sorted<'a>(it: impl Iterator<Item = &'a Feature>) -> Vec<&'a Feature> {
        let mut v: Vec<&Feature> = it.collect();
        v.sort_by(|a, b| board_order(a, b));
        v
    }
    let mut out = vec![Lane {
        kind: LaneKind::Backlog,
        name: "Backlog".into(),
        rule: String::new(),
        agent: String::new(),
        agent_profile_id: None,
        cards: sorted(board.backlog()).into_iter().map(|f| card(f, "")).collect(),
    }];
    for stage in &board.pipeline.stages {
        let agent_id = stage.default_agent_profile_id.clone();
        let agent = agent_id.as_deref().and_then(|id| names.get(id).copied());
        let manual = stage.advance_rule() == AdvanceRule::Manual;
        out.push(Lane {
            kind: LaneKind::Stage(stage.id.clone()),
            name: stage.name.clone(),
            rule: if manual { REVIEW_RULE } else { AUTO_RULE }.into(),
            agent: agent.unwrap_or(NO_AGENT).into(),
            agent_profile_id: agent.and(agent_id),
            cards: sorted(board.in_stage(&stage.id)).into_iter().map(|f| card(f, agent.unwrap_or(""))).collect(),
        });
    }
    out.push(Lane {
        kind: LaneKind::Completed,
        name: "Completed".into(),
        rule: String::new(),
        agent: String::new(),
        agent_profile_id: None,
        cards: sorted(board.completed()).into_iter().map(|f| card(f, "")).collect(),
    });
    out
}

/// One line of a card's conversation, as the inspector draws it.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    User(String),
    Agent(String),
    System(String),
    /// Consecutive tool calls, by name, in order.
    Tools(Vec<String>),
    Failed(String),
}

/// A run's events as entries: tool calls that follow one another fold into one line.
pub fn push_event(entries: &mut Vec<Entry>, event: &AgentEvent) {
    match event {
        AgentEvent::Message { role, text } if !text.trim().is_empty() => entries.push(match role {
            MessageRole::User => Entry::User(text.clone()),
            MessageRole::Assistant => Entry::Agent(text.clone()),
            _ => Entry::System(text.clone()),
        }),
        AgentEvent::Tool { name, phase: ToolPhase::Start, .. } => match entries.last_mut() {
            Some(Entry::Tools(names)) => names.push(name.clone()),
            _ => entries.push(Entry::Tools(vec![name.clone()])),
        },
        AgentEvent::Result { ok: false, error: Some(e), interrupted: false, .. } if !e.trim().is_empty() => {
            entries.push(Entry::Failed(e.clone()))
        }
        _ => {}
    }
}

/// "Bash, Read ×3, Edit": names in first-use order with repeat counts.
pub fn tools_line(names: &[String]) -> String {
    let mut seen: Vec<(&str, usize)> = Vec::new();
    for n in names {
        match seen.iter_mut().find(|(s, _)| *s == n) {
            Some((_, c)) => *c += 1,
            None => seen.push((n, 1)),
        }
    }
    seen.iter().map(|(n, c)| if *c > 1 { format!("{n} ×{c}") } else { (*n).to_owned() }).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bento_client::{Pipeline, Stage};

    fn feature(id: &str, status: &str, stage: Option<&str>, pos: &str) -> Feature {
        serde_json::from_value(serde_json::json!({"id": id, "projectId": "p", "title": id, "status": status, "currentStageId": stage, "boardPosition": pos})).unwrap()
    }

    fn stage(id: &str, gate: &str, agent: Option<&str>) -> Stage {
        serde_json::from_value(serde_json::json!({"id": id, "pipelineId": "pl", "position": 0, "name": id, "gateType": gate, "defaultAgentProfileId": agent})).unwrap()
    }

    fn run(status: RunStatus, output: Option<&str>) -> CardRun {
        CardRun { run_id: Some("r".into()), status, cost_usd: None, output: output.map(Into::into) }
    }

    #[test]
    fn status_prefers_an_active_run_then_the_gate() {
        assert_eq!(status(FeatureStatus::Gated, Some(&run(RunStatus::Running, None))), Status::Running);
        assert_eq!(status(FeatureStatus::Active, Some(&run(RunStatus::Queued, None))), Status::Running);
        assert_eq!(status(FeatureStatus::Gated, Some(&run(RunStatus::Failed, None))), Status::Gated);
        assert_eq!(status(FeatureStatus::Active, Some(&run(RunStatus::Failed, None))), Status::Failed);
        assert_eq!(status(FeatureStatus::Active, Some(&run(RunStatus::Succeeded, None))), Status::Succeeded);
        assert_eq!(status(FeatureStatus::Done, None), Status::Succeeded);
        assert_eq!(status(FeatureStatus::Active, Some(&run(RunStatus::Cancelled, None))), Status::Idle);
        assert_eq!(status(FeatureStatus::Backlog, None), Status::Idle);
    }

    #[test]
    fn lanes_follow_the_pipeline_between_backlog_and_completed() {
        let board = Board {
            pipeline: Pipeline { id: "pl".into(), name: "Default".into(), stages: vec![stage("s1", "manual", Some("a1")), stage("s2", "auto", None), stage("s3", "auto", Some("gone"))] },
            features: vec![
                feature("b2", "backlog", None, "10"),
                feature("b1", "backlog", None, "9"),
                feature("w", "active", Some("s1"), "0"),
                feature("g", "gated", Some("s1"), "1"),
                feature("d", "done", Some("s2"), "0"),
            ],
            runs: HashMap::from([("w".to_owned(), run(RunStatus::Running, Some("Editing a.ts")))]),
        };
        let profiles: Vec<AgentProfile> = serde_json::from_value(serde_json::json!([{"id": "a1", "name": "Engineer", "cli": "fake", "model": "m"}])).unwrap();
        let lanes = lanes(&board, &profiles);
        let names: Vec<&str> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Backlog", "s1", "s2", "s3", "Completed"]);
        // Numeric order, not lexical: "9" before "10".
        assert_eq!(lanes[0].cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["b1", "b2"]);
        assert_eq!((lanes[1].rule.as_str(), lanes[1].agent.as_str()), (REVIEW_RULE, "Engineer"));
        assert_eq!(lanes[1].agent_profile_id.as_deref(), Some("a1"));
        assert_eq!((lanes[2].rule.as_str(), lanes[2].agent.as_str()), (AUTO_RULE, NO_AGENT));
        // A profile that no longer exists reads as no agent, and cannot be started.
        assert_eq!((lanes[3].agent.as_str(), lanes[3].agent_profile_id.as_deref()), (NO_AGENT, None));
        let w = &lanes[1].cards[0];
        assert_eq!((w.status, w.note.as_str(), w.agent.as_str()), (Status::Running, "Editing a.ts", "Engineer"));
        assert_eq!(lanes[1].cards[1].status, Status::Gated);
        assert!(lanes[1].cards[1].agent.is_empty());
        assert_eq!(lanes[4].cards[0].status, Status::Succeeded);
        assert_eq!(lanes[0].rule, "");
    }

    #[test]
    fn events_fold_tool_runs_and_keep_failures() {
        let mut entries = Vec::new();
        let tool = |n: &str, phase| AgentEvent::Tool { name: n.into(), phase, detail: None };
        for e in [
            AgentEvent::Message { role: MessageRole::User, text: "do it".into() },
            AgentEvent::Init { session_id: None, model: None },
            tool("Bash", ToolPhase::Start),
            tool("Bash", ToolPhase::End),
            tool("Read", ToolPhase::Start),
            tool("Read", ToolPhase::Start),
            AgentEvent::Message { role: MessageRole::Assistant, text: "Done.".into() },
            AgentEvent::Message { role: MessageRole::Assistant, text: "  ".into() },
            tool("Edit", ToolPhase::Start),
            AgentEvent::Result { ok: false, session_id: None, cost_usd: None, input_tokens: None, output_tokens: None, num_turns: None, error: Some("boom".into()), interrupted: false },
            AgentEvent::Result { ok: false, session_id: None, cost_usd: None, input_tokens: None, output_tokens: None, num_turns: None, error: Some("stopped".into()), interrupted: true },
        ] {
            push_event(&mut entries, &e);
        }
        assert_eq!(
            entries,
            [
                Entry::User("do it".into()),
                Entry::Tools(vec!["Bash".into(), "Read".into(), "Read".into()]),
                Entry::Agent("Done.".into()),
                Entry::Tools(vec!["Edit".into()]),
                Entry::Failed("boom".into()),
            ]
        );
        assert_eq!(tools_line(&["Bash".into(), "Read".into(), "Read".into(), "Bash".into()]), "Bash ×2, Read ×2");
    }
}
