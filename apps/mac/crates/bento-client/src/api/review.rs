//! What a card drawer shows for review: the stage's requirements, the card's history, and the
//! earlier lines of a long run.

use serde::Deserialize;

use crate::client::{Client, encode};
use crate::error::Result;
use crate::types::{AgentEvent, Feature, FeatureStatus};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckCriterion {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub cmd: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CheckDetail {
    #[serde(default)]
    pub message: Option<String>,
}

/// One requirement's verdict for the card's current stage.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateCheck {
    pub id: String,
    pub criterion: CheckCriterion,
    /// "pending", "passed" or "failed".
    pub status: String,
    #[serde(default)]
    pub detail: Option<CheckDetail>,
}

/// `GET /api/features/:id/gate`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateState {
    pub status: FeatureStatus,
    #[serde(default)]
    pub current_stage_id: Option<String>,
    #[serde(default)]
    pub checks: Vec<GateCheck>,
}

/// One thing that happened to a card: a stage move or a status change.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureEvent {
    pub id: String,
    /// "stage_moved" or "status_changed".
    pub kind: String,
    #[serde(default)]
    pub from_stage_id: Option<String>,
    #[serde(default)]
    pub to_stage_id: Option<String>,
    #[serde(default)]
    pub from_status: Option<String>,
    #[serde(default)]
    pub to_status: Option<String>,
    pub trigger: String,
    #[serde(default)]
    pub actor_name: Option<String>,
    #[serde(default)]
    pub actor_email: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    pub at: String,
}

/// A page of a run's events before a sequence number, oldest first.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    pub events: Vec<AgentEvent>,
    #[serde(default)]
    pub first_seq: Option<u64>,
    #[serde(default)]
    pub earlier: u64,
}

impl Client {
    pub fn feature_gate(&self, feature_id: &str) -> Result<GateState> {
        self.get(&format!("/api/features/{}/gate", encode(feature_id)))
    }

    /// Evaluates the stage's requirements again. Refused for a card in no stage, or finished.
    pub fn recheck_gate(&self, feature_id: &str) -> Result<Feature> {
        self.post_empty(&format!("/api/features/{}/recheck", encode(feature_id)))
    }

    /// Everything that has happened to the card, oldest first.
    pub fn feature_history(&self, feature_id: &str) -> Result<Vec<FeatureEvent>> {
        self.get(&format!("/api/features/{}/history", encode(feature_id)))
    }

    pub fn run_events_before(&self, run_id: &str, seq: u64, limit: u32) -> Result<EventsPage> {
        self.get(&format!("/api/runs/{}/events/before?seq={seq}&limit={limit}", encode(run_id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_servers_shapes() {
        let gate: GateState = serde_json::from_str(
            r#"{"status":"gated","currentStageId":"s1","checks":[
                {"id":"c1","featureId":"f","stageId":"s1","criterion":{"type":"command","cmd":"pnpm test"},"status":"failed","detail":{"message":"exit 1"},"evaluatedAt":"2026-11-27T06:30:54.000Z"},
                {"id":"c2","criterion":{"type":"run_succeeded"},"status":"pending","detail":null}]}"#,
        )
        .unwrap();
        assert_eq!(gate.checks[0].criterion.cmd.as_deref(), Some("pnpm test"));
        assert_eq!(gate.checks[0].detail.as_ref().and_then(|d| d.message.as_deref()), Some("exit 1"));
        assert!(gate.checks[1].detail.is_none());
        let history: Vec<FeatureEvent> = serde_json::from_str(
            r#"[{"id":"e1","featureId":"f","kind":"stage_moved","fromStageId":null,"toStageId":"s1","fromStatus":null,"toStatus":null,
                "trigger":"manual","actorUserId":null,"actorName":null,"actorEmail":null,"runId":null,"detail":null,"at":"2026-11-27T06:30:54.000Z"}]"#,
        )
        .unwrap();
        assert_eq!(history[0].to_stage_id.as_deref(), Some("s1"));
        let page: EventsPage = serde_json::from_str(
            r#"{"events":[{"type":"message","role":"assistant","text":"hi","recordedAt":"2026-11-27T06:30:54.000Z"}],"firstSeq":3,"earlier":2}"#,
        )
        .unwrap();
        assert_eq!((page.first_seq, page.earlier, page.events.len()), (Some(3), 2, 1));
    }
}
