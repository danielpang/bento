//! Fixture state for the Settings scenes. Nothing here reaches a server or a file.

use rune::TextEdit;
use serde_json::json;

use super::agent_form;
use super::connections::Login;
use super::local::Options;
use super::projects::{Remove, StageDraft};
use super::{Load, Section, Theme};
use crate::state::{Screen, State};

macro_rules! from {
    ($v:expr) => {
        serde_json::from_value($v).expect("fixture shape")
    };
}

fn base(s: &mut State, section: Section) {
    crate::fixtures::board(s);
    s.screen = Screen::Settings;
    let p = &mut s.settings;
    p.section = section;
    p.agents.profiles = Load::Ready(from!(json!([
        {"id": "pm", "name": "Product Manager", "cli": "claude-code", "model": "claude-opus-4-1"},
        {"id": "se", "name": "Software Engineer", "cli": "codex", "model": "gpt-5-codex"},
        {"id": "judge", "name": "Reviewer", "cli": "pi", "model": "anthropic/claude-sonnet-4-5", "skill": "Review the diff against the card. Your write-up must list what blocks a merge, then what can wait."},
    ])));
    p.agents.catalog = Load::Ready(from!(json!([
        {"id": "anthropic", "name": "Anthropic", "models": [
            {"id": "claude-sonnet-5", "name": "Claude Sonnet 5"}, {"id": "claude-opus-5", "name": "Claude Opus 5"}, {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"}]},
        {"id": "openai", "name": "OpenAI", "models": [{"id": "gpt-5-codex", "name": "GPT-5 Codex"}, {"id": "gpt-5.4", "name": "GPT-5.4"}]},
        {"id": "google", "name": "Google", "models": [{"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro"}]},
        {"id": "openrouter", "name": "OpenRouter", "models": [{"id": "z-ai/glm-4.6", "name": "GLM 4.6"}]},
        {"id": "ollama", "name": "Ollama", "models": [{"id": "glm-5.1", "name": "GLM 5.1"}]},
    ])));
    p.agents.tools = Load::Ready(from!(json!([
        {"cli": "claude-code", "label": "Claude Code", "installed": true},
        {"cli": "codex", "label": "Codex CLI", "installed": true},
        {"cli": "cursor", "label": "Cursor CLI", "installed": false, "installUrl": "https://cursor.com/cli", "installCommand": "curl -fsS https://cursor.com/install | bash"},
    ])));
    p.agents.connections.accounts = Load::Ready(Vec::new());
    p.agents.connections.machine = Some(from!(json!({"mode": "local", "shareAgentAuth": false, "pinnedByEnv": false, "canShareMachineLogin": true, "claude": {"loggedIn": false}})));
    // The hint is the server's mask of a fake value.
    p.agents.secrets = Load::Ready(from!(json!([{"id": "k1", "name": "ANTHROPIC_API_KEY", "hint": "••••••••0000", "scope": "user"}])));
    p.projects.list = Load::Ready(from!(json!([
        {"id": "bento", "name": "bento", "localPath": "/Users/me/projects/bento"},
        {"id": "site", "name": "usebento.ai", "localPath": "/Users/me/projects/site"},
    ])));
    p.local.running = Some(Options::DEFAULT);
    p.local.draft = Some(Options::DEFAULT);
    p.local.health = Load::Ready(from!(json!({"ok": true, "mode": "local", "driver": "local-process"})));
}

pub fn agents(s: &mut State) {
    base(s, Section::Agents);
}

pub fn agent_new(s: &mut State) {
    agents(s);
    agent_form::open_new(s);
}

fn edit(s: &mut State, id: &str) {
    agents(s);
    let Load::Ready(list) = &s.settings.agents.profiles else { return };
    let p = list.iter().find(|p| p.id == id).cloned().expect("fixture agent");
    agent_form::open_edit(s, &p);
}

pub fn agent_edit(s: &mut State) {
    edit(s, "judge");
}

/// A model the catalog does not list, on a tool the sandbox lacks.
pub fn agent_typed(s: &mut State) {
    agents(s);
    let p = from!(json!({"id": "cu", "name": "Cursor agent", "cli": "cursor", "model": "composer-3-preview"}));
    agent_form::open_edit(s, &p);
}

pub fn agent_refused(s: &mut State) {
    agent_new(s);
    let f = s.settings.agents.form.as_mut().expect("open");
    f.name = TextEdit::new("Implementer");
    f.error = Some("This tool cannot run Anthropic models. It reaches OpenAI, OpenRouter, Vercel AI Gateway.".into());
}

pub fn claude_login(s: &mut State) {
    agents(s);
    let c = &mut s.settings.agents.connections;
    c.accounts = Load::Ready(from!(json!([{"id": "a1", "provider": "openai-codex", "reconnectRequired": false}])));
    c.login = Some(Login::new("anthropic", from!(json!({"id": "l1", "url": "https://claude.ai/oauth/authorize", "userCode": null, "interval": 0}))));
    c.machine = Some(from!(json!({"mode": "local", "shareAgentAuth": true, "pinnedByEnv": false, "canShareMachineLogin": true,
        "claude": {"loggedIn": true, "subscriptionType": "max", "email": "me@example.com"}})));
    if let Load::Ready(list) = &mut s.settings.agents.secrets {
        list.push(from!(json!({"id": "k2", "name": "CLAUDE_CODE_OAUTH_TOKEN", "hint": "••••••••0000", "scope": "user"})));
    }
}

pub fn chatgpt_login(s: &mut State) {
    agents(s);
    let c = &mut s.settings.agents.connections;
    c.login = Some(Login::new("openai-codex", from!(json!({"id": "l2", "url": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234", "interval": 5}))));
}

pub fn projects(s: &mut State) {
    base(s, Section::Projects);
}

pub fn project(s: &mut State) {
    base(s, Section::Projects);
    let p = &mut s.settings.projects;
    p.open = Some("bento".into());
    let pipeline = from!(json!({"id": "pl", "name": "Default", "stages": [
        {"id": "s1", "pipelineId": "pl", "position": 0, "name": "Product investigation", "defaultAgentProfileId": "pm", "gateType": "manual", "gateCriteria": [], "createPr": false},
        {"id": "s2", "pipelineId": "pl", "position": 1, "name": "Implementation", "defaultAgentProfileId": "se", "gateType": "auto",
         "gateCriteria": [{"type": "run_succeeded"}, {"type": "command", "cmd": "pnpm test", "timeoutSec": 600}], "createPr": true},
        {"id": "s3", "pipelineId": "pl", "position": 2, "name": "Code review", "defaultAgentProfileId": null, "gateType": "manual", "gateCriteria": [], "createPr": true},
    ]}));
    let features = from!(json!([{"id": "f1", "projectId": "bento", "title": "x", "status": "active", "currentStageId": "s2"}]));
    p.pipeline = Load::Ready((pipeline, features));
}

pub fn stage(s: &mut State) {
    project(s);
    let Load::Ready((pipeline, _)) = &s.settings.projects.pipeline else { return };
    let st = pipeline.stages[1].clone();
    s.settings.projects.stage = Some(StageDraft {
        id: Some(st.id.clone()),
        title: format!("Edit {}", st.name),
        name: TextEdit::new(&st.name),
        agent: st.default_agent_profile_id.clone(),
        gate: st.gate_type,
        create_pr: st.create_pr,
        criteria: st.gate_criteria.clone(),
    });
}

pub fn remove_project(s: &mut State) {
    projects(s);
    s.settings.projects.remove = Some(Remove { id: "site".into(), name: "usebento.ai".into(), cards: Some(3), typed: TextEdit::new("usebento") });
}

pub fn local(s: &mut State) {
    base(s, Section::Local);
}

pub fn local_changed(s: &mut State) {
    local(s);
    s.settings.local.draft = Some(Options { docker: true, beta: true, model_proxy: true });
}

pub fn appearance(s: &mut State) {
    base(s, Section::Appearance);
    s.settings.theme = Theme::Dark;
}

pub fn loading(s: &mut State) {
    base(s, Section::Agents);
    s.settings.agents.profiles = Load::Loading;
    s.settings.agents.secrets = Load::Loading;
}

pub fn failed(s: &mut State) {
    base(s, Section::Agents);
    s.settings.agents.profiles = Load::Failed("connect ECONNREFUSED 127.0.0.1:64500".into());
    s.settings.agents.secrets = Load::Failed("connect ECONNREFUSED 127.0.0.1:64500".into());
}

pub fn no_projects(s: &mut State) {
    base(s, Section::Projects);
    s.projects.clear();
    s.project = None;
    s.lanes.clear();
    s.settings.projects.list = Load::Ready(Vec::new());
    s.settings.agents.profiles = Load::Ready(Vec::new());
}
