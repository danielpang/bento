//! Headless fixture scenes for the drawer's tabs. Nothing here reaches a server.

use std::sync::Arc;

use bento_client::{AgentEvent, AgentProfile, FeatureChanges, FeatureDetail, FeatureEvent, GateState, MessageRole, RunArtifact, RunStatus, ToolPhase};
use rune::ImageCache;
use serde_json::{Value, json};

use super::{Review, RunPage, Tab, changes};
use crate::data;
use crate::pages::Scene;
use crate::pages::artifacts::{Body, Load};
use crate::state::{Block, State, Transcript};

const DIFF: &str = "diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
new file mode 100644
--- /dev/null
+++ b/CONTRIBUTING.md
@@ -0,0 +1,9 @@
+# Contributing
+
+Thanks for helping. Before you open a pull request:
+
+1. Run `pnpm install` and `pnpm test`.
+2. Keep each change to one idea, with a test that shows it.
+3. Write the commit message as a sentence about what changed.
+
+Questions go in Discussions, not issues.
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -12,4 +12,5 @@ Bento runs coding agents against cards on a board.
 ## Development

-See the docs folder.
+See the docs folder, and [CONTRIBUTING.md](CONTRIBUTING.md) before your first
+pull request.
";

const PLAN: &str = "# Contributing guide\n\n## What exists\n\nThe README points at `docs/` and nothing tells a newcomer how to run the tests.\n\n<script>alert('raw html is dropped')</script>\n\n## Plan\n\n1. Add `CONTRIBUTING.md` at the root.\n2. Link it from the README.\n\n## Open questions\n\n- Should it name a code of conduct?\n";

fn tool(name: &str, end: bool, raw: Value) -> AgentEvent {
    let block = &raw["message"]["content"][0];
    let detail = if end { block["content"].clone() } else { block["input"].clone() };
    AgentEvent::Tool { name: name.into(), phase: if end { ToolPhase::End } else { ToolPhase::Start }, detail: Some(detail), raw: Some(raw) }
}

fn call(id: &str, name: &str, input: Value) -> AgentEvent {
    tool(name, false, json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}}))
}

fn result(id: &str, content: &str, error: bool) -> AgentEvent {
    tool("tool_result", true, json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": content, "is_error": error}]}}))
}

fn msg(role: MessageRole, text: &str) -> AgentEvent {
    AgentEvent::Message { role, text: text.into() }
}

fn artifact(id: &str, path: &str, kind: &str, mime: &str) -> RunArtifact {
    RunArtifact {
        id: id.into(),
        run_id: "run-contributing".into(),
        stage_slug: "investigation".into(),
        stage_name: "Product investigation".into(),
        path: path.into(),
        kind: kind.into(),
        mime: mime.into(),
        size: 1840,
        created_at: "2026-11-27T06:30:54.000Z".into(),
    }
}

fn history() -> Vec<FeatureEvent> {
    serde_json::from_value(json!([
        {"id": "h1", "kind": "stage_moved", "fromStageId": null, "toStageId": "investigation", "trigger": "manual", "actorName": "Dana Reyes", "actorEmail": "dana@example.com", "at": "2026-11-27T06:12:03.000Z"},
        {"id": "h2", "kind": "status_changed", "fromStatus": "active", "toStatus": "gated", "trigger": "agent_run", "at": "2026-11-27T06:30:54.000Z"}
    ]))
    .unwrap()
}

/// The gated card, reviewed: a finished run with tool calls (one failed), lines above its tail,
/// requirements, a history, a diff and artifacts.
fn fixture(s: &mut State) {
    crate::fixtures::board(s);
    s.selected = Some("contributing".into());
    s.inspector = rune_kit::shell::PaneState::new(440.0).range(320.0, 760.0);
    let events = [
        msg(MessageRole::User, "Write a CONTRIBUTING guide and link it from the README."),
        call("t1", "Read", json!({"file_path": "CONTRIBUTING.md"})),
        result("t1", "<tool_use_error>File does not exist.</tool_use_error>", true),
        call("t2", "Read", json!({"file_path": "README.md"})),
        result("t2", "# Bento\n\nBento runs coding agents against cards on a board.\n\n## Development\n\nSee the docs folder.", false),
        call("t3", "Bash", json!({"command": "pnpm test --run", "description": "Run the tests"})),
        result("t3", "Test Files  41 passed (41)\n     Tests  412 passed (412)", false),
        call("t4", "Write", json!({"file_path": "CONTRIBUTING.md", "content": "# Contributing\n..."})),
        result("t4", "File created successfully at: CONTRIBUTING.md", false),
        msg(MessageRole::Assistant, "The guide is in `CONTRIBUTING.md`, linked from the README. Two open questions are in the write-up."),
    ];
    s.transcript = Transcript {
        feature: "contributing".into(),
        blocks: vec![Block { agent: "Product Manager".into(), status: RunStatus::Succeeded, entries: data::entries(&events) }],
        ..Transcript::default()
    };
    let detail: FeatureDetail = serde_json::from_value(json!({
        "id": "contributing", "projectId": "bento", "title": "Add a CONTRIBUTING guide", "status": "gated",
        "currentStageId": "investigation", "branchName": "feature/add-a-contributing-guide-6999e2e6",
        "runs": [
            {"id": "run-contributing", "featureId": "contributing", "agentProfileId": "pm", "status": "succeeded", "costUsd": "0.31", "queuedAt": "2026-11-27T06:12:04.000Z"},
            {"id": "run-first", "featureId": "contributing", "agentProfileId": "pm", "status": "failed", "error": "The model provider returned 529 Overloaded.", "queuedAt": "2026-11-27T06:02:00.000Z"}
        ]
    }))
    .unwrap();
    let profiles: Vec<AgentProfile> = serde_json::from_value(json!([{"id": "pm", "name": "Product Manager", "cli": "claude-code", "model": "claude-sonnet-5"}])).unwrap();
    let gate: GateState = serde_json::from_value(json!({"status": "gated", "currentStageId": "investigation", "checks": [
        {"id": "c1", "criterion": {"type": "run_succeeded"}, "status": "passed", "detail": {"message": "The agent finished"}},
        {"id": "c2", "criterion": {"type": "command", "cmd": "test -f CHANGELOG.md"}, "status": "failed", "detail": {"message": "test -f CHANGELOG.md exited 1"}},
        {"id": "c3", "criterion": {"type": "agent_judge", "agentProfileId": "pm"}, "status": "pending", "detail": null}
    ]}))
    .unwrap();
    let changes: FeatureChanges = serde_json::from_value(json!({"branch": "feature/add-a-contributing-guide-6999e2e6", "repositories": [{
        "name": "bento", "branch": "feature/add-a-contributing-guide-6999e2e6", "diff": DIFF, "truncated": false,
        "files": [{"path": "CONTRIBUTING.md", "additions": 9, "deletions": 0}, {"path": "README.md", "additions": 2, "deletions": 1}]
    }]}))
    .unwrap();
    let mut r = Review { feature: "contributing".into(), ..Review::default() };
    changes::show(&mut r.diff, &changes);
    r.detail = Some(detail);
    r.profiles = profiles;
    r.gate = Load::Ready(gate);
    r.history = Load::Ready(history());
    r.changes = Load::Ready(changes);
    r.artifacts = Load::Ready(vec![
        artifact("a-plan", "docs/bento/product-investigation.md", "markdown", "text/markdown"),
        artifact("a-shot", "artifacts/readme-before.png", "image", "image/png"),
        artifact("a-mock", "artifacts/contributing-page.html", "html", "text/html"),
        artifact("a-svg", "artifacts/flow.svg", "file", "image/svg+xml"),
        artifact("a-old", "docs/bento/product-investigation.md", "markdown", "text/markdown"),
    ]);
    r.tokens = 48_211;
    r.pages = vec![RunPage::new("run-contributing", Some(213), 212, events.to_vec())];
    r.open.insert("tools-0-1".into());
    r.open.insert("tools-0-1-0".into());
    s.review = r;
}

fn tab(s: &mut State, tab: Tab) {
    fixture(s);
    s.review.tab = tab;
}

pub const SCENES: &[Scene] = &[
    ("drawer", fixture),
    ("drawer/changes", |s| tab(s, Tab::Changes)),
    ("drawer/artifacts", |s| tab(s, Tab::Artifacts)),
    ("drawer/artifact", |s| {
        tab(s, Tab::Artifacts);
        s.review.reading = Some("a-plan".into());
        s.review.body = Some(("a-plan".into(), Load::Ready(Body::Text(PLAN.into()))));
    }),
    ("drawer/artifact-image", |s| {
        tab(s, Tab::Artifacts);
        s.review.reading = Some("a-shot".into());
        let (w, h) = (360u32, 220u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[(x * 255 / w) as u8, 0x8a, (y * 255 / h) as u8, 0xff]);
            }
        }
        let cache = ImageCache::new(Arc::new(|| {}));
        let img = cache.rgba(w, h, rgba);
        let _ = img.wait();
        s.review.body = Some(("a-shot".into(), Load::Ready(Body::Image(img))));
        s.review.images = Some(cache);
    }),
    ("drawer/artifact-html", |s| {
        tab(s, Tab::Artifacts);
        s.review.reading = Some("a-mock".into());
    }),
    ("drawer/details", |s| tab(s, Tab::Details)),
    ("drawer/working", |s| {
        crate::fixtures::board(s);
        // The live run has used tools and says nothing yet: the agent is working, no draft.
        s.transcript.draft.clear();
        s.review = Review { feature: "webhooks".into(), changes: Load::Ready(FeatureChanges { branch: None, repositories: Vec::new() }), ..Review::default() };
    }),
    ("drawer/empty-changes", |s| {
        tab(s, Tab::Changes);
        s.review.changes = Load::Ready(FeatureChanges { branch: None, repositories: Vec::new() });
    }),
];
