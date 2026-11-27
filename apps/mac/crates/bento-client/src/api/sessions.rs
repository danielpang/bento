//! The Sessions page: every conversation in a project, starting one without a stage, and what
//! a card's agents have committed.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::client::{Client, encode};
use crate::error::Result;
use crate::types::{AgentRun, RunStatus};

fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

/// A session's newest run, with its agent named by the server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRun {
    pub id: String,
    pub status: RunStatus,
    pub agent_profile_id: String,
    #[serde(default)]
    pub queued_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub cost_usd: Option<f64>,
    /// None when that agent no longer exists.
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub agent_cli: Option<String>,
    #[serde(default)]
    pub agent_model: Option<String>,
}

/// One conversation: a card that has runs (judge runs left out).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    pub feature_id: String,
    pub title: String,
    pub run_count: u64,
    /// None when no run reported a cost, which is not zero.
    #[serde(default, deserialize_with = "lenient_f64")]
    pub total_cost_usd: Option<f64>,
    pub latest_run: SessionRun,
}

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<ProjectSession>,
}

/// The body of `POST /api/projects/:id/sessions`.
#[derive(Debug, Clone, Serialize)]
pub struct NewSession {
    pub cli: String,
    pub model: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedSession {
    pub feature_id: String,
    pub run: AgentRun,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChanges {
    pub name: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub files: Vec<ChangedFile>,
    /// `git diff` output against the base branch.
    #[serde(default)]
    pub diff: String,
    #[serde(default)]
    pub truncated: bool,
}

/// What the card's agents have committed so far, per repository.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureChanges {
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repositories: Vec<RepositoryChanges>,
}

impl Client {
    /// Every conversation in the project, newest activity first.
    pub fn list_sessions(&self, project_id: &str) -> Result<Vec<ProjectSession>> {
        Ok(self.get::<Sessions>(&format!("/api/projects/{}/sessions", encode(project_id)))?.sessions)
    }

    /// Starts an agent with no stage: a standalone card in the backlog and its first run.
    pub fn start_session(&self, project_id: &str, input: &NewSession) -> Result<StartedSession> {
        self.post(&format!("/api/projects/{}/sessions", encode(project_id)), Some(input))
    }

    pub fn feature_changes(&self, feature_id: &str) -> Result<FeatureChanges> {
        self.get(&format!("/api/features/{}/changes", encode(feature_id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_decode_with_string_costs_and_missing_agents() {
        let body = serde_json::json!({"sessions": [{
            "featureId": "f", "title": "T", "runCount": 2, "totalCostUsd": "0.42",
            "latestRun": {"id": "r", "status": "running", "agentProfileId": "a", "queuedAt": "2026-11-27T10:00:00.000Z",
                "startedAt": null, "endedAt": null, "costUsd": null, "agentName": null}
        }]});
        let s: Sessions = serde_json::from_value(body).unwrap();
        let s = &s.sessions[0];
        assert_eq!(s.total_cost_usd, Some(0.42));
        assert_eq!(s.latest_run.status, RunStatus::Running);
        assert!(s.latest_run.agent_name.is_none() && s.latest_run.cost_usd.is_none());
    }

    #[test]
    fn a_session_without_a_title_sends_none() {
        let body = serde_json::to_value(NewSession { cli: "fake".into(), model: "fake-1".into(), prompt: "hi".into(), title: None }).unwrap();
        assert_eq!(body, serde_json::json!({"cli": "fake", "model": "fake-1", "prompt": "hi"}));
    }
}
