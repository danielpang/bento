//! The card drawer's actions: pull requests, an agent's questions, delete and undo.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::client::{Client, encode};
use crate::error::Result;
use crate::types::{AgentRun, Feature, PullRequest, RunStatus};

fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

/// One of the card's runs, with what the drawer's actions need.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRunRow {
    pub id: String,
    pub status: RunStatus,
    #[serde(default)]
    pub stage_id: Option<String>,
    pub agent_profile_id: String,
    /// "stage", "judge" or "rebase".
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub live_session: Option<bool>,
    /// A snapshot taken before the run, which Undo restores.
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A pull request the card has opened, live or merged.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPullRequest {
    pub name: String,
    pub number: u64,
    pub url: String,
    pub branch: String,
    /// On the branch the card is on now.
    pub current: bool,
}

/// `GET /api/features/:id`, read for the drawer's actions.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    #[serde(flatten)]
    pub feature: Feature,
    /// Newest first.
    #[serde(default)]
    pub runs: Vec<CardRunRow>,
    #[serde(default)]
    pub pull_requests: Vec<PullRequest>,
    #[serde(default)]
    pub pull_request_history: Vec<CardPullRequest>,
}

/// What GitHub says about one pull request: its merge ("clean", "conflicted", "unknown"), its
/// checks ("passed", "pending", "failed", "unknown"), or how it ended ("merged", "open",
/// "closed", "unknown").
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestState {
    pub url: String,
    pub number: u64,
    pub state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// Something can push: an App installation or a saved token.
    pub can_publish: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepository {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub repo_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPullRequest {
    pub name: String,
    pub pr_number: u64,
    pub url: String,
    #[serde(default)]
    pub draft: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublishFailure {
    pub name: String,
    pub reason: String,
}

/// What `POST /api/features/:id/publish` did.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    #[serde(default)]
    pub published: Vec<PublishedPullRequest>,
    #[serde(default)]
    pub failures: Vec<PublishFailure>,
    /// The branch was behind; this run rebases it and publishes when it ends.
    #[serde(default)]
    pub rebase_run: Option<AgentRun>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskedQuestion {
    pub question: String,
    /// A short label for the question.
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

/// Questions the agent is blocked on until a person answers them.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQuestion {
    pub id: String,
    pub run_id: String,
    pub questions: Vec<AskedQuestion>,
}

/// A person's answer to one question: options picked by label, and words beside or instead.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestionChoice {
    pub question: String,
    pub selected: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
}

impl Client {
    pub fn card_detail(&self, feature_id: &str) -> Result<CardDetail> {
        self.get(&format!("/api/features/{}", encode(feature_id)))
    }

    pub fn github_status(&self) -> Result<GithubStatus> {
        self.get("/api/github/status")
    }

    pub fn project_repositories(&self, project_id: &str) -> Result<Vec<ProjectRepository>> {
        self.get(&format!("/api/projects/{}/repositories", encode(project_id)))
    }

    /// Whether each live pull request merges cleanly.
    pub fn merge_status(&self, feature_id: &str) -> Result<Vec<PullRequestState>> {
        self.get(&format!("/api/features/{}/merge-status", encode(feature_id)))
    }

    /// How CI is doing on each live pull request's head.
    pub fn check_status(&self, feature_id: &str) -> Result<Vec<PullRequestState>> {
        self.get(&format!("/api/features/{}/check-status", encode(feature_id)))
    }

    /// How each pull request the card has opened ended.
    pub fn pull_request_status(&self, feature_id: &str) -> Result<Vec<PullRequestState>> {
        self.get(&format!("/api/features/{}/pull-request-status", encode(feature_id)))
    }

    /// Pushes the branch and opens (or updates) its pull requests. 409 with the server's
    /// sentence when there is no branch, no GitHub connection, or no repository.
    pub fn publish_feature(&self, feature_id: &str) -> Result<Published> {
        self.post_empty(&format!("/api/features/{}/publish", encode(feature_id)))
    }

    /// Starts the stage agent rebasing the branch onto its base and resolving the conflicts.
    pub fn resolve_conflicts(&self, feature_id: &str) -> Result<AgentRun> {
        self.post_empty(&format!("/api/features/{}/resolve-conflicts", encode(feature_id)))
    }

    /// Starts the stage agent fixing the failing CI checks.
    pub fn fix_ci_tests(&self, feature_id: &str) -> Result<AgentRun> {
        self.post_empty(&format!("/api/features/{}/fix-ci-tests", encode(feature_id)))
    }

    /// Removes the card, its runs and its sandbox. 409 while an agent works it.
    pub fn delete_feature(&self, feature_id: &str) -> Result<()> {
        self.send(self.request("DELETE", &format!("/api/features/{}", encode(feature_id))), None).map(drop)
    }

    /// Restores the sandbox to the snapshot taken before the run.
    pub fn rollback_run(&self, run_id: &str) -> Result<()> {
        self.post_empty::<Value>(&format!("/api/runs/{}/rollback", encode(run_id))).map(drop)
    }

    /// The questions the run's agent is waiting on; empty once it is not running.
    pub fn run_questions(&self, run_id: &str) -> Result<Vec<RunQuestion>> {
        self.get(&format!("/api/runs/{}/questions", encode(run_id)))
    }

    pub fn answer_question(&self, run_id: &str, question_id: &str, answers: &[QuestionChoice]) -> Result<()> {
        #[derive(Serialize)]
        struct Body<'a> {
            answers: &'a [QuestionChoice],
        }
        let path = format!("/api/runs/{}/questions/{}/answer", encode(run_id), encode(question_id));
        self.post::<Value>(&path, Some(&Body { answers })).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_question_decodes_without_its_optional_fields() {
        let q: RunQuestion = serde_json::from_value(serde_json::json!({
            "id": "q", "runId": "r", "createdAt": "2026-11-27T10:00:00.000Z",
            "questions": [{"question": "Which?", "multiSelect": false, "options": [{"label": "A"}, {"label": "B", "description": "the second"}]}]
        }))
        .unwrap();
        assert_eq!(q.questions[0].options[1].description.as_deref(), Some("the second"));
        assert!(q.questions[0].header.is_none());
    }

    #[test]
    fn an_answer_leaves_out_empty_words() {
        let body = serde_json::to_value(QuestionChoice { question: "Which?".into(), selected: vec!["A".into()], other: None }).unwrap();
        assert_eq!(body, serde_json::json!({"question": "Which?", "selected": ["A"]}));
    }

    #[test]
    fn card_detail_keeps_checkpoints_and_history() {
        let d: CardDetail = serde_json::from_value(serde_json::json!({
            "id": "f", "projectId": "p", "title": "T", "status": "active", "branchName": "bento/t",
            "runs": [{"id": "r", "featureId": "f", "agentProfileId": "a", "status": "succeeded", "checkpointId": "c1", "costUsd": "0.25"}],
            "pullRequests": [{"name": "bento", "number": 7, "url": "https://github.com/o/r/pull/7"}],
            "pullRequestHistory": [{"name": "bento", "number": 7, "url": "https://github.com/o/r/pull/7", "branch": "bento/t", "current": true}]
        }))
        .unwrap();
        assert_eq!(d.runs[0].checkpoint_id.as_deref(), Some("c1"));
        assert_eq!(d.runs[0].cost_usd, Some(0.25));
        assert!(d.pull_request_history[0].current);
    }
}
