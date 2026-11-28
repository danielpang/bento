//! Settings endpoints: saved credentials, agents, projects and their stages.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::client::{Client, encode};
use crate::error::{Error, Result};
use crate::types::{GateType, Stage};

/// A saved credential. The server never returns its value, only a masked hint.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecret {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub hint: Option<String>,
    /// "user" for a personal key, "org" for a shared one.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretList {
    pub secrets: Vec<SavedSecret>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    #[serde(default)]
    pub deleted_cards: Option<u64>,
    #[serde(default)]
    pub deleted_runs: Option<u64>,
}

/// What `PATCH /api/stages/:id` changes; absent fields stay as they are. The
/// stage's requirements are never sent from here, so ones this client cannot
/// read survive an edit.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `Some(None)` unassigns the agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_profile_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_type: Option<GateType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_pr: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmSummary {
    pub id: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    #[serde(default)]
    pub beta_testers: bool,
}

impl Client {
    pub(crate) fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Option<String>) -> Result<T> {
        Self::decode(self.send(self.request(method, path), body)?)
    }

    pub(crate) fn json(body: &impl Serialize) -> Result<String> {
        serde_json::to_string(body).map_err(|e| Error::Decode { message: e.to_string(), body: String::new() })
    }

    /// The caller's saved credentials, masked.
    pub fn list_secrets(&self) -> Result<SecretList> {
        self.get("/api/secrets")
    }

    /// Saves a credential for this person, replacing one saved under the same name.
    pub fn save_secret(&self, name: &str, value: &str) -> Result<SavedSecret> {
        #[derive(Serialize)]
        struct Body<'a> {
            name: &'a str,
            value: &'a str,
            scope: &'a str,
        }
        let body = Self::json(&Body { name, value, scope: "user" })?;
        self.call("POST", "/api/secrets", Some(body))
    }

    pub fn delete_secret(&self, id: &str) -> Result<()> {
        self.call::<serde_json::Value>("DELETE", &format!("/api/secrets/{}", encode(id)), None).map(drop)
    }

    /// Removes an agent with its recorded runs; stages using it are left with none.
    pub fn delete_profile(&self, id: &str) -> Result<Removed> {
        self.call("DELETE", &format!("/api/profiles/{}", encode(id)), None)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<crate::types::Project> {
        #[derive(Serialize)]
        struct Body<'a> {
            name: &'a str,
        }
        self.call("PATCH", &format!("/api/projects/{}", encode(id)), Some(Self::json(&Body { name })?))
    }

    /// Removes the project with its cards, runs, repositories and pipeline. 409
    /// while an agent is working one of its cards.
    pub fn delete_project(&self, id: &str) -> Result<Removed> {
        self.call("DELETE", &format!("/api/projects/{}", encode(id)), None)
    }

    /// Appends a manual stage with no agent to the pipeline.
    pub fn create_stage(&self, pipeline_id: &str, name: &str) -> Result<Stage> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            pipeline_id: &'a str,
            name: &'a str,
        }
        self.post("/api/stages", Some(&Body { pipeline_id, name }))
    }

    pub fn update_stage(&self, id: &str, patch: &StagePatch) -> Result<Stage> {
        self.call("PATCH", &format!("/api/stages/{}", encode(id)), Some(Self::json(patch)?))
    }

    /// 409 while cards are in the stage.
    pub fn delete_stage(&self, id: &str) -> Result<()> {
        self.call::<serde_json::Value>("DELETE", &format!("/api/stages/{}", encode(id)), None).map(drop)
    }

    pub fn list_all_swarms(&self) -> Result<Vec<SwarmSummary>> {
        self.get("/api/swarms")
    }

    pub fn flags(&self) -> Result<Flags> {
        self.get("/api/flags")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stage_patch_sends_only_what_changed() {
        let patch = StagePatch { default_agent_profile_id: Some(None), gate_type: Some(GateType::Auto), ..StagePatch::default() };
        assert_eq!(serde_json::to_string(&patch).unwrap(), r#"{"defaultAgentProfileId":null,"gateType":"auto"}"#);
        assert_eq!(serde_json::to_string(&StagePatch::default()).unwrap(), "{}");
    }

    #[test]
    fn a_secret_list_reads_without_values() {
        let list: SecretList = serde_json::from_str(
            r#"{"secrets":[{"id":"a","name":"OPENAI_API_KEY","hint":"••••••••0000","createdAt":"x","scope":"user"}],"canManage":true}"#,
        )
        .unwrap();
        assert_eq!(list.secrets[0].name, "OPENAI_API_KEY");
        assert_eq!(list.secrets[0].scope.as_deref(), Some("user"));
    }
}
