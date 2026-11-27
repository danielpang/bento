//! Headless fixture scenes. Nothing here reaches a server.

use bento_client::{AgentEvent, AgentProfile, FeatureChanges, FeatureDetail, MessageRole, ProjectSession, RunStatus, ToolPhase};
use rune_kit::diff::{self, DiffState};
use serde_json::json;

use super::{Compose, List, Open, Pane};
use crate::data;
use crate::pages::Scene;
use crate::state::{Block, Screen, State, Transcript};

const DIFF: &str = "diff --git a/webhook/sender.ts b/webhook/sender.ts
--- a/webhook/sender.ts
+++ b/webhook/sender.ts
@@ -41,5 +41,10 @@ export async function deliver(row: Delivery) {
   const res = await post(row.url, body)
-  if (!res.ok) return markFailed(row)
+  if (!res.ok) {
+    if (row.attempts >= MAX_ATTEMPTS) return markFailed(row)
+    return scheduleRetry(row, backoff(row.attempts))
+  }
   return markDelivered(row)
 }
diff --git a/webhook/backoff.ts b/webhook/backoff.ts
new file mode 100644
--- /dev/null
+++ b/webhook/backoff.ts
@@ -0,0 +1,3 @@
+export const MAX_ATTEMPTS = 12
+
+export const backoff = (n: number) => Math.min(2 ** n * 1000, 3_600_000)
";

fn iso(ago: i64) -> String {
    let t = super::now_unix() - ago;
    let (days, secs) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", secs / 3600, secs / 60 % 60, secs % 60)
}

fn session(id: &str, title: &str, status: &str, agent: &str, ago: i64, runs: u64, cost: Option<f64>) -> ProjectSession {
    serde_json::from_value(json!({
        "featureId": id, "title": title, "runCount": runs, "totalCostUsd": cost,
        "latestRun": {"id": format!("run-{id}"), "status": status, "agentProfileId": "engineer", "queuedAt": iso(ago), "agentName": agent, "agentCli": "claude-code", "agentModel": "claude-sonnet-5"}
    }))
    .unwrap()
}

fn sessions() -> Vec<ProjectSession> {
    vec![
        session("webhooks", "Retry failed webhook deliveries", "running", "Software Engineer", 60, 3, Some(1.84)),
        session("launcher", "Dark blue theme for the launcher", "running", "Claude Code (claude-sonnet-5)", 200, 1, None),
        session("contributing", "Add a CONTRIBUTING guide", "succeeded", "Product Manager", 7200, 2, Some(0.31)),
        session("events", "Paginate run events", "failed", "Code Reviewer", 90_000, 4, Some(2.07)),
        session("copy", "Rename stage gate copy", "cancelled", "Software Engineer", 9 * 86_400, 1, Some(0.12)),
    ]
}

fn open(s: &mut State, status: &str, live: bool) {
    let msg = |role, text: &str| AgentEvent::Message { role, text: text.into() };
    let tool = |name: &str| AgentEvent::Tool { name: name.into(), phase: ToolPhase::Start, detail: None, raw: None };
    let mut detail: FeatureDetail = serde_json::from_value(json!({
        "id": "webhooks", "projectId": "bento", "title": "Retry failed webhook deliveries", "status": "active",
        "currentStageId": "implementation", "branchName": "bento/retry-failed-webhook-deliveries-1f2a",
        "runs": [
            {"id": "run-webhooks", "featureId": "webhooks", "agentProfileId": "engineer", "status": status, "costUsd": "1.12", "liveSession": false, "role": "stage"},
            {"id": "run-0", "featureId": "webhooks", "agentProfileId": "engineer", "status": "succeeded", "costUsd": "0.72"}
        ]
    }))
    .unwrap();
    detail.feature.description = "Failed deliveries are dropped. Retry them with backoff and stop after a day.".into();
    let profiles: Vec<AgentProfile> = serde_json::from_value(json!([{"id": "engineer", "name": "Software Engineer", "cli": "claude-code", "model": "claude-sonnet-5"}])).unwrap();
    let changes: FeatureChanges = serde_json::from_value(json!({"branch": "bento/retry", "repositories": [{
        "name": "bento", "branch": "bento/retry", "diff": DIFF, "truncated": false,
        "files": [{"path": "webhook/sender.ts", "additions": 4, "deletions": 1}, {"path": "webhook/backoff.ts", "additions": 3, "deletions": 0}]
    }]}))
    .unwrap();
    let first = Block {
        agent: "Software Engineer".into(),
        status: RunStatus::Succeeded,
        entries: data::entries(&[
            msg(MessageRole::User, "Failed deliveries are dropped. Retry them with backoff and stop after a day."),
            tool("Read"),
            tool("Read"),
            tool("Grep"),
            msg(MessageRole::Assistant, "The sender marks a delivery failed on the first error and never looks at it again. I'll add a retry queue and keep the delivery row as the record of each attempt."),
        ]),
    };
    let follow_up = data::entries(&[msg(MessageRole::User, "Cap it at twelve attempts."), tool("Edit"), tool("Edit"), tool("Bash")]);
    let mut o = Open::new("webhooks");
    o.detail = Some(detail);
    o.profiles = profiles;
    o.tokens = 64_612;
    o.transcript = if live {
        Transcript {
            feature: "webhooks".into(),
            blocks: vec![first],
            live: Some(Block { agent: "Software Engineer".into(), status: RunStatus::Running, entries: follow_up }),
            draft: "Running the webhook tests now. Two of them".into(),
            ..Transcript::default()
        }
    } else {
        let mut entries = follow_up;
        entries.extend(data::entries(&[msg(MessageRole::Assistant, "Done. Deliveries now retry with exponential backoff and stop after **twelve** attempts; the tests pass.")]));
        Transcript { feature: "webhooks".into(), blocks: vec![first, Block { agent: "Software Engineer".into(), status: RunStatus::Succeeded, entries }], ..Transcript::default() }
    };
    o.streaming = live.then(|| "run-webhooks".into());
    s.sessions.diff = DiffState::new(diff::parse(DIFF));
    o.changes = Some(changes);
    s.sessions.open = Some(o);
}

fn base(s: &mut State) {
    crate::fixtures::board(s);
    s.screen = Screen::Sessions;
    s.sessions.project = s.project.clone();
    s.sessions.list = List::Ready(sessions());
}

pub const SCENES: &[Scene] = &[
    ("sessions", |s| {
        base(s);
        open(s, "running", true);
    }),
    ("sessions/list", base),
    ("sessions/finished", |s| {
        base(s);
        if let List::Ready(rows) = &mut s.sessions.list {
            rows[0] = session("webhooks", "Retry failed webhook deliveries", "succeeded", "Software Engineer", 30, 3, Some(1.84));
        }
        open(s, "succeeded", false);
    }),
    ("sessions/changes", |s| {
        base(s);
        open(s, "succeeded", false);
        if let Some(o) = s.sessions.open.as_mut() {
            o.pane = Pane::Changes;
        }
    }),
    ("sessions/compose", |s| {
        base(s);
        let mut c = Compose::new(Some(("claude-code", "claude-sonnet-5")));
        c.prompt = rune::TextEdit::new("Where does the login flow live, and why does it redirect twice?");
        s.sessions.compose = Some(c);
    }),
    ("sessions/empty", |s| {
        base(s);
        s.sessions.list = List::Ready(Vec::new());
        s.sessions.compose = Some(Compose::new(None));
    }),
    ("sessions/error", |s| {
        base(s);
        s.sessions.list = List::Failed("connect ECONNREFUSED 127.0.0.1:4400".into());
    }),
    ("sessions/loading", |s| {
        base(s);
        s.sessions.list = List::Loading;
    }),
    ("sessions/deleted", |s| {
        base(s);
        let mut o = Open::new("gone");
        o.deleted = true;
        s.sessions.open = Some(o);
    }),
];
