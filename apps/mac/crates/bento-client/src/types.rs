//! Response and request shapes. Only the fields the app plausibly needs are
//! modelled; serde ignores the rest, so a field added on the server never
//! breaks a decode. Enums keep an `Unknown` or `Other` arm for the same reason.

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// Distinguishes `"field": null` (Some(None)) from an absent field (None).
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Postgres numerics arrive as strings ("0.4213"); some routes send numbers.
fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Multi,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub mode: Mode,
    /// The default sandbox driver: "docker", "local-process", "sprite", ...
    #[serde(default)]
    pub driver: Option<String>,
    #[serde(default)]
    pub build: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub repo_url: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// The body of `POST /api/projects`. In local mode `local_path` is a git
/// checkout on this machine; the server expands `~` and refuses a path that
/// does not exist.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
}

impl NewProject {
    pub fn local(name: impl Into<String>, path: impl Into<String>) -> Self {
        Self { name: name.into(), local_path: Some(path.into()), default_branch: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GateType {
    Manual,
    Auto,
    #[serde(other)]
    Other,
}

/// One exit criterion of an automatic stage (`packages/core/src/gates.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum GateCriterion {
    Manual,
    RunSucceeded,
    AgentJudge { agent_profile_id: String },
    PrCommentsResolved,
    ChecksPass,
    Command {
        cmd: String,
        #[serde(default)]
        timeout_sec: Option<u32>,
    },
    #[serde(other)]
    Unknown,
}

/// How a card leaves a stage, as the board's lane shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvanceRule<'a> {
    /// A person approves or rejects ("Review before advancing").
    Manual,
    /// Advances once every criterion passes ("Advances automatically").
    /// An empty list means the stage's own run succeeding.
    Automatic(&'a [GateCriterion]),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub pipeline_id: String,
    pub position: i64,
    pub name: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub description: String,
    /// The agent assigned to the lane; resolve its name with `profiles`.
    #[serde(default)]
    pub default_agent_profile_id: Option<String>,
    pub gate_type: GateType,
    #[serde(default)]
    pub gate_criteria: Vec<GateCriterion>,
    #[serde(default)]
    pub create_pr: bool,
}

impl Stage {
    /// A stage carrying a legacy `manual` criterion is manual whatever its
    /// mode says, as the server reads it.
    pub fn advance_rule(&self) -> AdvanceRule<'_> {
        if self.gate_type == GateType::Manual || self.gate_criteria.contains(&GateCriterion::Manual) {
            AdvanceRule::Manual
        } else {
            AdvanceRule::Automatic(&self.gate_criteria)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    pub id: String,
    pub name: String,
    /// In lane order (the server sorts by position).
    pub stages: Vec<Stage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureStatus {
    Backlog,
    Active,
    Gated,
    Done,
    Cancelled,
    #[serde(other)]
    Unknown,
}

impl FeatureStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, FeatureStatus::Done | FeatureStatus::Cancelled)
    }
}

/// A card.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub pipeline_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: FeatureStatus,
    /// None is the backlog, unless the card is finished (a done card keeps
    /// the stage it finished in).
    #[serde(default)]
    pub current_stage_id: Option<String>,
    /// A decimal string; lexical order is not numeric order.
    #[serde(default)]
    pub board_position: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub pr_number: Option<u64>,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Started from the Sessions tab rather than the board.
    #[serde(default)]
    pub standalone: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFeature {
    pub project_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

impl NewFeature {
    pub fn new(project_id: impl Into<String>, title: impl Into<String>) -> Self {
        Self { project_id: project_id.into(), title: title.into(), description: None, parent_id: None }
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub name: String,
    pub number: u64,
    pub url: String,
}

/// `GET /api/features/:id`: the card plus its runs, newest first.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDetail {
    #[serde(flatten)]
    pub feature: Feature,
    #[serde(default)]
    pub runs: Vec<AgentRun>,
    #[serde(default)]
    pub pull_requests: Vec<PullRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Queued,
    Starting,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

impl RunStatus {
    pub fn is_active(self) -> bool {
        matches!(self, RunStatus::Queued | RunStatus::Starting | RunStatus::Running)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled)
    }

    fn parse(s: &str) -> Self {
        serde_json::from_value(Value::String(s.to_owned())).unwrap_or(RunStatus::Unknown)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub feature_id: String,
    #[serde(default)]
    pub stage_id: Option<String>,
    pub agent_profile_id: String,
    pub status: RunStatus,
    /// "stage", "judge" or "rebase".
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub cli_session_id: Option<String>,
    /// Whether a message reaches the agent mid run. Null until it starts.
    #[serde(default)]
    pub live_session: Option<bool>,
    #[serde(default)]
    pub queued_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
}

/// The body of `POST /api/runs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRun {
    pub feature_id: String,
    pub agent_profile_id: String,
    /// Defaults to the card's current stage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    /// Replaces the generated stage prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    /// "claude-code", "codex", "opencode", "pi", ...
    pub cli: String,
    pub model: String,
    #[serde(default)]
    pub skill: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    pub feature: Feature,
    #[serde(default)]
    pub gate_checks: Vec<Value>,
}

/// What `POST /api/features/:id/message` did with the message.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResult {
    /// Parked for delivery when the working run ends.
    pub queued: bool,
    /// A live session took it mid run.
    #[serde(default)]
    pub live: Option<bool>,
    /// "steer" or "queue", for a live delivery.
    #[serde(default)]
    pub delivery: Option<String>,
    /// The run it started, when the agent was idle.
    #[serde(default)]
    pub run: Option<AgentRun>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptResult {
    pub interrupted: bool,
    /// "sent", "stopped", "waiting", "closed" or "requested".
    pub outcome: String,
}

/// One finished run in a card's conversation: the tail of its events.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBlock {
    pub run_id: String,
    pub agent_name: String,
    #[serde(default)]
    pub queued_at: Option<String>,
    pub status: RunStatus,
    pub events: Vec<AgentEvent>,
    /// The seq of `events[0]`; page earlier lines from there.
    #[serde(default)]
    pub first_seq: Option<u64>,
    /// How many lines precede `events[0]`.
    #[serde(default)]
    pub earlier: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    pub id: String,
    pub text: String,
    /// "queued" or "sent".
    pub status: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// `GET /api/features/:id/conversation`. The live run is not in `blocks`:
/// stream it with `Client::stream_run`.
#[derive(Debug, Clone, Deserialize)]
pub struct Conversation {
    pub blocks: Vec<ConversationBlock>,
    #[serde(default)]
    pub pending: Vec<PendingMessage>,
}

/// A card's newest run, from the board's line snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct CardRun {
    pub run_id: Option<String>,
    pub status: RunStatus,
    /// Summed over runs that reported one; None is "not reported", not zero.
    pub cost_usd: Option<f64>,
    /// The agent's latest line, for a card starting, running or just failed.
    pub output: Option<String>,
}

/// Parses `GET /api/projects/:id/board/plain` into the newest run per card.
pub fn parse_board_plain(text: &str) -> HashMap<String, CardRun> {
    let dash = |s: &str| (s != "-" && !s.is_empty()).then(|| s.to_owned());
    let mut out = HashMap::new();
    for line in text.lines() {
        // feature|id|stage|status|runStatus|runId|cost|output|title (title may hold pipes)
        let parts: Vec<&str> = line.splitn(9, '|').collect();
        if parts.len() < 8 || parts[0] != "feature" || parts[1].is_empty() {
            continue;
        }
        let Some(status) = dash(parts[4]) else { continue };
        out.insert(
            parts[1].to_owned(),
            CardRun {
                run_id: dash(parts[5]),
                status: RunStatus::parse(&status),
                cost_usd: dash(parts[6]).and_then(|c| c.parse().ok()),
                output: dash(parts[7]),
            },
        );
    }
    out
}

/// A project's board: lanes in order, the cards, and each card's newest run.
#[derive(Debug, Clone)]
pub struct Board {
    pub pipeline: Pipeline,
    pub features: Vec<Feature>,
    pub runs: HashMap<String, CardRun>,
}

impl Board {
    /// Cards with no stage that are not finished, as the Backlog lane shows them.
    pub fn backlog(&self) -> impl Iterator<Item = &Feature> {
        self.features.iter().filter(|f| f.current_stage_id.is_none() && !f.status.is_finished())
    }

    pub fn in_stage<'a>(&'a self, stage_id: &'a str) -> impl Iterator<Item = &'a Feature> + 'a {
        self.features
            .iter()
            .filter(move |f| f.current_stage_id.as_deref() == Some(stage_id) && !f.status.is_finished())
    }

    /// Done and cancelled cards, as the Completed lane shows them.
    pub fn completed(&self) -> impl Iterator<Item = &Feature> {
        self.features.iter().filter(|f| f.status.is_finished())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    Assistant,
    User,
    System,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPhase {
    Start,
    End,
    #[serde(other)]
    Other,
}

/// One normalized agent event (`packages/core/src/events.ts`). An event type
/// this client does not know arrives as `Unknown` with its JSON intact.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    Init {
        session_id: Option<String>,
        model: Option<String>,
    },
    Message {
        role: MessageRole,
        text: String,
    },
    Tool {
        name: String,
        phase: ToolPhase,
        detail: Option<Value>,
    },
    Result {
        ok: bool,
        session_id: Option<String>,
        cost_usd: Option<f64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        num_turns: Option<u64>,
        error: Option<String>,
        /// The turn ended because a person interrupted it.
        interrupted: bool,
    },
    Unknown(Value),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum KnownAgentEvent {
    Init {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    Message {
        role: MessageRole,
        text: String,
    },
    Tool {
        name: String,
        phase: ToolPhase,
        #[serde(default)]
        detail: Option<Value>,
    },
    Result {
        ok: bool,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        cost_usd: Option<f64>,
        #[serde(default)]
        input_tokens: Option<u64>,
        #[serde(default)]
        output_tokens: Option<u64>,
        #[serde(default)]
        num_turns: Option<u64>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        interrupted: Option<bool>,
    },
}

impl AgentEvent {
    pub fn from_value(value: Value) -> Self {
        match KnownAgentEvent::deserialize(&value) {
            Ok(KnownAgentEvent::Init { session_id, model }) => AgentEvent::Init { session_id, model },
            Ok(KnownAgentEvent::Message { role, text }) => AgentEvent::Message { role, text },
            Ok(KnownAgentEvent::Tool { name, phase, detail }) => AgentEvent::Tool { name, phase, detail },
            Ok(KnownAgentEvent::Result {
                ok,
                session_id,
                cost_usd,
                input_tokens,
                output_tokens,
                num_turns,
                error,
                interrupted,
            }) => AgentEvent::Result {
                ok,
                session_id,
                cost_usd,
                input_tokens,
                output_tokens,
                num_turns,
                error,
                interrupted: interrupted.unwrap_or(false),
            },
            Err(_) => AgentEvent::Unknown(value),
        }
    }
}

impl<'de> Deserialize<'de> for AgentEvent {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Value::deserialize(d).map(AgentEvent::from_value)
    }
}

/// A token sized slice of the message the agent is composing. Live only.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDelta {
    /// "text" or "thinking".
    pub channel: String,
    pub text: String,
    /// Characters of this channel's message that streamed before this one;
    /// a viewer whose draft is shorter than this holds a torn draft.
    pub offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Working,
    Waiting,
    #[serde(other)]
    Other,
}

/// What `GET /api/board/:projectId/events` delivers (`apps/server/src/events.ts`).
/// The frames say what changed; the app refetches what it needs.
#[derive(Debug, Clone, PartialEq)]
pub enum BoardEvent {
    FeatureUpdated {
        project_id: String,
        feature_id: String,
        status: Option<FeatureStatus>,
        /// Some(None) when the card moved to the backlog; None when not sent.
        current_stage_id: Option<Option<String>>,
    },
    FeatureDeleted {
        project_id: String,
        feature_id: String,
    },
    RunUpdated {
        project_id: String,
        feature_id: String,
        run_id: Option<String>,
        status: Option<RunStatus>,
    },
    /// The agent's latest line, truncated for a card.
    RunOutput {
        project_id: String,
        feature_id: String,
        run_id: Option<String>,
        text: Option<String>,
    },
    StageUpdated {
        project_id: String,
        stage_id: String,
    },
    SwarmUpdated {
        project_id: String,
        swarm_id: String,
        status: Option<String>,
    },
    SwarmTaskUpdated {
        project_id: String,
        swarm_id: String,
        task_id: Option<String>,
        status: Option<String>,
    },
    Unknown(Value),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum KnownBoardEvent {
    FeatureUpdated {
        project_id: String,
        feature_id: String,
        #[serde(default)]
        status: Option<FeatureStatus>,
        #[serde(default, deserialize_with = "double_option")]
        current_stage_id: Option<Option<String>>,
    },
    FeatureDeleted {
        project_id: String,
        feature_id: String,
    },
    RunUpdated {
        project_id: String,
        feature_id: String,
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        status: Option<RunStatus>,
    },
    RunOutput {
        project_id: String,
        feature_id: String,
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    StageUpdated {
        project_id: String,
        stage_id: String,
    },
    SwarmUpdated {
        project_id: String,
        swarm_id: String,
        #[serde(default)]
        status: Option<String>,
    },
    SwarmTaskUpdated {
        project_id: String,
        swarm_id: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        status: Option<String>,
    },
}

impl BoardEvent {
    pub fn from_value(value: Value) -> Self {
        use KnownBoardEvent as K;
        match K::deserialize(&value) {
            Ok(K::FeatureUpdated { project_id, feature_id, status, current_stage_id }) => {
                BoardEvent::FeatureUpdated { project_id, feature_id, status, current_stage_id }
            }
            Ok(K::FeatureDeleted { project_id, feature_id }) => BoardEvent::FeatureDeleted { project_id, feature_id },
            Ok(K::RunUpdated { project_id, feature_id, run_id, status }) => {
                BoardEvent::RunUpdated { project_id, feature_id, run_id, status }
            }
            Ok(K::RunOutput { project_id, feature_id, run_id, text }) => {
                BoardEvent::RunOutput { project_id, feature_id, run_id, text }
            }
            Ok(K::StageUpdated { project_id, stage_id }) => BoardEvent::StageUpdated { project_id, stage_id },
            Ok(K::SwarmUpdated { project_id, swarm_id, status }) => {
                BoardEvent::SwarmUpdated { project_id, swarm_id, status }
            }
            Ok(K::SwarmTaskUpdated { project_id, swarm_id, task_id, status }) => {
                BoardEvent::SwarmTaskUpdated { project_id, swarm_id, task_id, status }
            }
            Err(_) => BoardEvent::Unknown(value),
        }
    }

    /// The card this event is about, for the card kinds.
    pub fn feature_id(&self) -> Option<&str> {
        match self {
            BoardEvent::FeatureUpdated { feature_id, .. }
            | BoardEvent::FeatureDeleted { feature_id, .. }
            | BoardEvent::RunUpdated { feature_id, .. }
            | BoardEvent::RunOutput { feature_id, .. } => Some(feature_id),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for BoardEvent {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Value::deserialize(d).map(BoardEvent::from_value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every sample below was captured from a local mode server (BENTO_MODE=local,
    // local-process driver) on 2026-11-27 and trimmed.

    #[test]
    fn health() {
        let h: Health = serde_json::from_str(r#"{"ok":true,"mode":"local","driver":"local-process","selectableSandboxProviders":[],"contact":false,"social":{"github":false,"google":false}}"#).unwrap();
        assert!(h.ok);
        assert_eq!(h.mode, Mode::Local);
        assert_eq!(h.driver.as_deref(), Some("local-process"));
        let h: Health = serde_json::from_str(r#"{"ok":true,"mode":"something-new"}"#).unwrap();
        assert_eq!(h.mode, Mode::Other);
    }

    #[test]
    fn project() {
        let p: Project = serde_json::from_str(r#"{"id":"162bbe5c-abf7-417b-b597-2bc1619a27f9","ownerId":"local-user","organizationId":null,"name":"Sample","repoUrl":null,"defaultBranch":"main","localPath":"/tmp/repo1","githubRepoId":null,"executor":"server","sandboxProvider":"auto","autoStartPipeline":false,"linearCreateIssues":true,"createdAt":"2026-11-27T06:24:00.333Z","updatedAt":"2026-11-27T06:24:00.333Z"}"#).unwrap();
        assert_eq!(p.name, "Sample");
        assert_eq!(p.local_path.as_deref(), Some("/tmp/repo1"));
        assert_eq!(p.repo_url, None);
    }

    #[test]
    fn new_project_serializes_camel_case_and_skips_absent_fields() {
        let body = serde_json::to_string(&NewProject::local("App", "/tmp/app")).unwrap();
        assert_eq!(body, r#"{"name":"App","localPath":"/tmp/app"}"#);
        let body = serde_json::to_string(&NewFeature::new("p", "T").description("d")).unwrap();
        assert_eq!(body, r#"{"projectId":"p","title":"T","description":"d"}"#);
    }

    #[test]
    fn pipeline_and_gate_rules() {
        let p: Pipeline = serde_json::from_str(r#"{"id":"250edbef","projectId":"162bbe5c","organizationId":null,"name":"Default","isDefault":true,"stages":[
            {"id":"44866512","pipelineId":"250edbef","organizationId":null,"position":0,"name":"Engineering requirements","slug":"engineering-requirements","description":"Define engineering requirements and technical system design.","defaultAgentProfileId":"b72cb62b","gateType":"manual","gateCriteria":[],"createPr":true},
            {"id":"8c609a6c","pipelineId":"250edbef","position":1,"name":"Implementation","slug":"implementation","description":"","defaultAgentProfileId":null,"gateType":"auto","gateCriteria":[{"type":"run_succeeded"},{"type":"command","cmd":"pnpm test","timeoutSec":600},{"type":"agent_judge","agentProfileId":"55a014b4"},{"type":"from_the_future","x":1}],"createPr":false},
            {"id":"addc63ea","pipelineId":"250edbef","position":2,"name":"Legacy","slug":"legacy","description":"","defaultAgentProfileId":null,"gateType":"auto","gateCriteria":[{"type":"manual"}],"createPr":false}
        ]}"#).unwrap();
        assert_eq!(p.stages.len(), 3);
        assert_eq!(p.stages[0].default_agent_profile_id.as_deref(), Some("b72cb62b"));
        assert_eq!(p.stages[0].advance_rule(), AdvanceRule::Manual);
        let AdvanceRule::Automatic(criteria) = p.stages[1].advance_rule() else { panic!() };
        assert_eq!(
            criteria,
            &[
                GateCriterion::RunSucceeded,
                GateCriterion::Command { cmd: "pnpm test".into(), timeout_sec: Some(600) },
                GateCriterion::AgentJudge { agent_profile_id: "55a014b4".into() },
                GateCriterion::Unknown,
            ]
        );
        assert_eq!(p.stages[2].advance_rule(), AdvanceRule::Manual);
    }

    const FEATURE_DETAIL: &str = r#"{"id":"d65bccc0-5ece-4277-bfe1-d25527e9b933","projectId":"162bbe5c-abf7-417b-b597-2bc1619a27f9","organizationId":null,"pipelineId":"250edbef-06b2-4c11-8b53-c16d1a010772","title":"First card","description":"hello","status":"gated","currentStageId":"8c609a6c-7152-4c86-b248-427efcd3d283","boardPosition":"0","branchName":"feature/first-card-d65bccc0","prNumber":null,"pushedHeads":{},"parentId":null,"standalone":false,"createdAt":"2026-11-27T06:24:07.001Z","updatedAt":"2026-11-27T06:24:09.439Z","prUrl":null,"runs":[{"id":"b267ea2b-bb9f-4951-8c52-d878b404899b","featureId":"d65bccc0-5ece-4277-bfe1-d25527e9b933","organizationId":null,"stageId":"8c609a6c-7152-4c86-b248-427efcd3d283","swarmId":null,"swarmTaskId":null,"agentProfileId":"b01cfb8a-0ecd-4375-9403-ed2069cd224f","sandboxId":"544b8712-c56e-449c-ae14-3ff0e2aff8ab","startedBy":null,"status":"failed","prompt":"","type":"pipeline","role":"stage","executor":"server","cliSessionId":null,"liveSession":null,"exitCode":null,"costUsd":"0.4213","inputTokens":null,"outputTokens":null,"numTurns":null,"error":"No ANTHROPIC_API_KEY is configured, so Claude Code cannot start.","queuedAt":"2026-11-27T06:24:08.100Z","startedAt":"2026-11-27T06:24:08.134Z","agentStartedAt":null,"endedAt":"2026-11-27T06:24:08.257Z","billable":true}],"pullRequests":[],"pullRequestHistory":[]}"#;

    #[test]
    fn feature_detail() {
        let d: FeatureDetail = serde_json::from_str(FEATURE_DETAIL).unwrap();
        assert_eq!(d.feature.status, FeatureStatus::Gated);
        assert_eq!(d.feature.branch_name.as_deref(), Some("feature/first-card-d65bccc0"));
        assert_eq!(d.feature.board_position.as_deref(), Some("0"));
        assert_eq!(d.runs.len(), 1);
        let run = &d.runs[0];
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(run.cost_usd, Some(0.4213));
        assert_eq!(run.role.as_deref(), Some("stage"));
        assert!(run.status.is_terminal());
    }

    #[test]
    fn unknown_statuses_do_not_fail_the_decode() {
        let f: Feature = serde_json::from_str(r#"{"id":"a","projectId":"p","title":"t","status":"archived"}"#).unwrap();
        assert_eq!(f.status, FeatureStatus::Unknown);
        assert_eq!(f.current_stage_id, None);
    }

    #[test]
    fn conversation() {
        let c: Conversation = serde_json::from_str(r#"{"blocks":[{"runId":"b267ea2b","agentName":"Software Engineer","queuedAt":"2026-11-27T06:24:08.100Z","status":"failed","events":[
            {"role":"system","text":"MCP servers are not attached when agents run as a local process.","type":"message"},
            {"type":"init","sessionId":"s-1","model":"claude-sonnet-5"},
            {"type":"tool","name":"Bash","phase":"start","detail":{"command":"ls"}},
            {"type":"result","ok":false,"error":"boom","interrupted":true,"costUsd":0.01,"numTurns":2},
            {"type":"result","ok":true}
        ],"firstSeq":1,"earlier":0}],"pending":[{"id":"m1","text":"also this","status":"queued","createdAt":"2026-11-27T06:30:00.000Z"}]}"#).unwrap();
        let block = &c.blocks[0];
        assert_eq!(block.agent_name, "Software Engineer");
        assert_eq!(block.first_seq, Some(1));
        assert!(matches!(&block.events[0], AgentEvent::Message { role: MessageRole::System, .. }));
        assert_eq!(block.events[1], AgentEvent::Init { session_id: Some("s-1".into()), model: Some("claude-sonnet-5".into()) });
        assert!(matches!(&block.events[2], AgentEvent::Tool { name, phase: ToolPhase::Start, detail: Some(_) } if name == "Bash"));
        assert!(matches!(&block.events[3], AgentEvent::Result { ok: false, interrupted: true, num_turns: Some(2), .. }));
        assert!(matches!(&block.events[4], AgentEvent::Result { ok: true, interrupted: false, .. }));
        assert_eq!(c.pending[0].status, "queued");
    }

    #[test]
    fn malformed_known_event_falls_back_to_unknown() {
        let e: AgentEvent = serde_json::from_str(r#"{"type":"message","role":"assistant"}"#).unwrap();
        assert!(matches!(e, AgentEvent::Unknown(_)));
        let e: AgentEvent = serde_json::from_str(r#"{"type":"message","role":"narrator","text":"hi"}"#).unwrap();
        assert!(matches!(e, AgentEvent::Message { role: MessageRole::Other, .. }));
    }

    #[test]
    fn board_events() {
        let parse = |s: &str| BoardEvent::from_value(serde_json::from_str(s).unwrap());
        assert_eq!(
            parse(r#"{"type":"feature_updated","projectId":"p","featureId":"f","status":"active","currentStageId":"s"}"#),
            BoardEvent::FeatureUpdated { project_id: "p".into(), feature_id: "f".into(), status: Some(FeatureStatus::Active), current_stage_id: Some(Some("s".into())) }
        );
        assert_eq!(
            parse(r#"{"type":"feature_updated","projectId":"p","featureId":"f","status":"backlog","currentStageId":null}"#),
            BoardEvent::FeatureUpdated { project_id: "p".into(), feature_id: "f".into(), status: Some(FeatureStatus::Backlog), current_stage_id: Some(None) }
        );
        assert_eq!(
            parse(r#"{"type":"feature_updated","projectId":"p","featureId":"f"}"#),
            BoardEvent::FeatureUpdated { project_id: "p".into(), feature_id: "f".into(), status: None, current_stage_id: None }
        );
        assert_eq!(
            parse(r#"{"type":"run_updated","projectId":"p","featureId":"f","runId":"r","status":"starting"}"#),
            BoardEvent::RunUpdated { project_id: "p".into(), feature_id: "f".into(), run_id: Some("r".into()), status: Some(RunStatus::Starting) }
        );
        let output = parse(r#"{"type":"run_output","projectId":"p","featureId":"f","runId":"r","text":"No ANTHROPIC_API_KEY is configured, so Claude Code cannot start."}"#);
        assert!(matches!(&output, BoardEvent::RunOutput { text: Some(t), .. } if t.starts_with("No ANTHROPIC")));
        assert_eq!(output.feature_id(), Some("f"));
        assert_eq!(parse(r#"{"type":"feature_deleted","projectId":"p","featureId":"f"}"#).feature_id(), Some("f"));
        assert!(matches!(parse(r#"{"type":"swarm_task_updated","projectId":"p","swarmId":"s","taskId":"t","status":"working"}"#), BoardEvent::SwarmTaskUpdated { .. }));
        assert!(matches!(parse(r#"{"type":"card_split","projectId":"p"}"#), BoardEvent::Unknown(_)));
        assert!(matches!(parse(r#"{"type":"stage_updated"}"#), BoardEvent::Unknown(_)));
    }

    #[test]
    fn profiles() {
        let p: Vec<AgentProfile> = serde_json::from_str(r#"[{"id":"55a014b4","ownerId":"local-user","organizationId":null,"name":"Code Reviewer","cli":"claude-code","model":"claude-sonnet-5","skill":"Review the changes.","permissionPreset":"sandboxed-full","extraArgs":[],"envRefs":[]}]"#).unwrap();
        assert_eq!((p[0].name.as_str(), p[0].cli.as_str()), ("Code Reviewer", "claude-code"));
    }

    #[test]
    fn small_results() {
        let m: MessageResult = serde_json::from_str(r#"{"queued":false,"live":true,"delivery":"steer"}"#).unwrap();
        assert!(!m.queued && m.live == Some(true) && m.run.is_none());
        let i: InterruptResult = serde_json::from_str(r#"{"interrupted":false,"outcome":"waiting"}"#).unwrap();
        assert_eq!(i.outcome, "waiting");
        let a: ApproveResult = serde_json::from_str(r#"{"feature":{"id":"a","projectId":"p","title":"t","status":"active","currentStageId":"s2"},"gateChecks":[]}"#).unwrap();
        assert_eq!(a.feature.current_stage_id.as_deref(), Some("s2"));
    }

    #[test]
    fn board_plain() {
        let text = "stage|44866512|0|Engineering requirements\n\
            feature|d65bccc0|8c609a6c|gated|failed|b267ea2b|-|No ANTHROPIC_API_KEY is configured|First card\n\
            feature|aaaa|-|backlog|-|-|-|-|Untouched | with a pipe\n\
            feature|bbbb|s|active|running|r2|1.25|-|Working";
        let runs = parse_board_plain(text);
        assert_eq!(runs.len(), 2);
        assert_eq!(
            runs["d65bccc0"],
            CardRun { run_id: Some("b267ea2b".into()), status: RunStatus::Failed, cost_usd: None, output: Some("No ANTHROPIC_API_KEY is configured".into()) }
        );
        assert_eq!(runs["bbbb"].cost_usd, Some(1.25));
        assert!(!runs.contains_key("aaaa"));
    }

    #[test]
    fn board_lanes() {
        let f = |id: &str, status: &str, stage: Option<&str>| -> Feature {
            serde_json::from_value(serde_json::json!({"id": id, "projectId": "p", "title": id, "status": status, "currentStageId": stage})).unwrap()
        };
        let board = Board {
            pipeline: Pipeline { id: "pl".into(), name: "Default".into(), stages: vec![] },
            features: vec![f("a", "backlog", None), f("b", "active", Some("s1")), f("c", "done", Some("s1")), f("d", "cancelled", None)],
            runs: HashMap::new(),
        };
        let ids = |it: Box<dyn Iterator<Item = &Feature> + '_>| it.map(|f| f.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(Box::new(board.backlog())), ["a"]);
        assert_eq!(ids(Box::new(board.in_stage("s1"))), ["b"]);
        assert_eq!(ids(Box::new(board.completed())), ["c", "d"]);
    }
}
