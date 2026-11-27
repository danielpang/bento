//! Agents: the profiles themselves, the tools and models they can pair, this machine's
//! Claude login, and personal subscription connections.

use serde::{Deserialize, Serialize};

use crate::client::{Client, encode};
use crate::error::Result;
use crate::types::AgentProfile;

/// A coding agent the server knows, and whether its sandbox has it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTool {
    pub cli: String,
    pub label: String,
    /// None when the server could not tell, which is not the same as no.
    #[serde(default)]
    pub installed: Option<bool>,
    #[serde(default)]
    pub install_url: Option<String>,
    #[serde(default)]
    pub install_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
}

/// One provider in `/api/catalog/models`. The logo is left out: it is an SVG data URI.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
}

/// What `POST /api/profiles` and `PATCH /api/profiles/:id` take.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ProfileInput {
    pub name: String,
    pub cli: String,
    pub model: String,
    /// `Some(None)` clears it on an edit; a new agent leaves it out instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLogin {
    #[serde(default)]
    pub logged_in: bool,
    #[serde(default)]
    pub subscription_type: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// `GET /api/settings`: the machine the server runs on. A shared server says "multi" and
/// nothing else.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSettings {
    pub mode: String,
    #[serde(default)]
    pub share_agent_auth: bool,
    #[serde(default)]
    pub pinned_by_env: bool,
    /// Only an explicit false hides the offer; an older server does not send it.
    #[serde(default)]
    pub can_share_machine_login: Option<bool>,
    #[serde(default)]
    pub claude: Option<ClaudeLogin>,
}

/// A personal subscription connection. Its tokens never leave the server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub id: String,
    pub provider: String,
    #[serde(default)]
    pub reconnect_required: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentAccounts {
    pub accounts: Vec<AgentAccount>,
}

/// A login in progress. Claude hands back a code to paste; ChatGPT shows a user code
/// and is polled until approved.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLogin {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub user_code: Option<String>,
    #[serde(default)]
    pub interval: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoginStatus {
    /// "pending" or "connected".
    pub status: String,
}

impl Client {
    pub fn agent_tools(&self) -> Result<Vec<AgentTool>> {
        self.get("/api/profiles/tools")
    }

    pub fn model_catalog(&self) -> Result<Vec<CatalogProvider>> {
        self.get("/api/catalog/models")
    }

    /// 400 with the reason when the tool cannot run the model.
    pub fn create_profile(&self, input: &ProfileInput) -> Result<AgentProfile> {
        self.call("POST", "/api/profiles", Some(Self::json(input)?))
    }

    /// Every stage pointing at the agent follows the change.
    pub fn update_profile(&self, id: &str, input: &ProfileInput) -> Result<AgentProfile> {
        self.call("PATCH", &format!("/api/profiles/{}", encode(id)), Some(Self::json(input)?))
    }

    pub fn machine_settings(&self) -> Result<MachineSettings> {
        self.get("/api/settings")
    }

    pub fn set_share_agent_auth(&self, share: bool) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body {
            share_agent_auth: bool,
        }
        self.call::<serde_json::Value>("PATCH", "/api/settings", Some(Self::json(&Body { share_agent_auth: share })?)).map(drop)
    }

    pub fn agent_accounts(&self) -> Result<AgentAccounts> {
        self.get("/api/agent-accounts")
    }

    /// `provider` is "anthropic" or "openai-codex".
    pub fn connect_agent_account(&self, provider: &str) -> Result<AccountLogin> {
        self.call("POST", &format!("/api/agent-accounts/{}/login", encode(provider)), Some("{}".into()))
    }

    /// Claude needs the pasted `code#state`; ChatGPT is asked with none until it answers.
    pub fn complete_agent_account(&self, provider: &str, id: &str, code: Option<&str>) -> Result<LoginStatus> {
        #[derive(Serialize)]
        struct Body<'a> {
            id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            code: Option<&'a str>,
        }
        self.call("POST", &format!("/api/agent-accounts/{}/complete", encode(provider)), Some(Self::json(&Body { id, code })?))
    }

    pub fn cancel_agent_account_login(&self, provider: &str, id: &str) -> Result<()> {
        self.call::<serde_json::Value>("DELETE", &format!("/api/agent-accounts/{}/login/{}", encode(provider), encode(id)), None).map(drop)
    }

    pub fn disconnect_agent_account(&self, provider: &str) -> Result<()> {
        self.call::<serde_json::Value>("DELETE", &format!("/api/agent-accounts/{}", encode(provider)), None).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_agent_leaves_out_an_empty_skill_and_an_edit_clears_it() {
        let new = ProfileInput { name: "Implementer".into(), cli: "codex".into(), model: "gpt-5-codex".into(), skill: None };
        assert_eq!(serde_json::to_string(&new).unwrap(), r#"{"name":"Implementer","cli":"codex","model":"gpt-5-codex"}"#);
        let edit = ProfileInput { skill: Some(None), ..new };
        assert!(serde_json::to_string(&edit).unwrap().ends_with(r#""skill":null}"#));
    }

    #[test]
    fn machine_settings_read_from_a_local_and_a_shared_server() {
        let local: MachineSettings = serde_json::from_str(
            r#"{"mode":"local","shareAgentAuth":true,"pinnedByEnv":false,"logins":[],"canShareMachineLogin":true,"claude":{"loggedIn":true,"subscriptionType":"max","email":"a@b.c"}}"#,
        )
        .unwrap();
        assert!(local.share_agent_auth && local.claude.unwrap().logged_in);
        let multi: MachineSettings = serde_json::from_str(r#"{"mode":"multi","shareAgentAuth":false,"logins":[]}"#).unwrap();
        assert_eq!(multi.mode, "multi");
        assert!(multi.claude.is_none() && multi.can_share_machine_login.is_none());
    }

    #[test]
    fn catalog_and_logins_read() {
        let c: Vec<CatalogProvider> =
            serde_json::from_str(r#"[{"id":"anthropic","name":"Anthropic","env":["ANTHROPIC_API_KEY"],"logo":"data:","models":[{"id":"claude-sonnet-5","name":"Claude Sonnet 5","cost":{"input":3,"output":15}}]}]"#).unwrap();
        assert_eq!(c[0].models[0].id, "claude-sonnet-5");
        let l: AccountLogin = serde_json::from_str(r#"{"id":"x","url":"https://claude.ai/oauth/authorize?a","userCode":null,"interval":0,"expiresAt":"2026"}"#).unwrap();
        assert!(l.user_code.is_none());
    }
}
