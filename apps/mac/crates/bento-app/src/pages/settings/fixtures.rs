//! Fixture state for the Settings scenes. Nothing here reaches a server or a file.

use rune::TextEdit;
use serde_json::json;

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
        {"id": "judge", "name": "Reviewer", "cli": "pi", "model": "anthropic/claude-sonnet-4-5"},
    ])));
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
