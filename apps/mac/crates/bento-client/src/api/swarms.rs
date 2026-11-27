//! Swarms endpoints: `impl Client` methods and their types.
//!
//! A swarm is a goal a planner agent splits into a tree of tasks; workers take the leaves,
//! and finished branches merge one at a time through a merge queue onto the swarm's branch.
//! The detail route sends the tree flat, each node naming its parent.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::client::{Client, encode};
use crate::error::{Error, Result};
use crate::sse::Frame;
use crate::stream::{self, Consumer, Flow, StreamHandle};
use crate::types::{BoardEvent, RunStatus};

/// Postgres numerics arrive as strings ("0.4213"); a missing or null one reads as zero.
fn money<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    })
}

fn optional_money<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

/// The swarm row, as the server stores it. `status` is the table's word ("blocked",
/// "cancelled", ...), not the console's; the app translates.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swarm {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub goal: String,
    pub status: String,
    #[serde(default)]
    pub paused_reason: Option<String>,
    #[serde(default)]
    pub paused_until: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub planner_profile_id: Option<String>,
    #[serde(default)]
    pub worker_profile_id: Option<String>,
    #[serde(default, deserialize_with = "optional_money")]
    pub budget_usd: Option<f64>,
    #[serde(default)]
    pub max_workers: u32,
    #[serde(default)]
    pub time_limit_min: Option<u32>,
    #[serde(default, deserialize_with = "money")]
    pub spent_measured_usd: f64,
    #[serde(default, deserialize_with = "money")]
    pub spent_estimated_usd: f64,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub reopen_count: u32,
}

impl Swarm {
    /// What the swarm has spent, as the console's budget counts it: measured plus estimated.
    pub fn spent_usd(&self) -> f64 {
        self.spent_measured_usd + self.spent_estimated_usd
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct SwarmCounts {
    #[serde(default)]
    pub tasks: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub attention: u32,
}

/// A row of the list: the swarm and its task counts. No tree.
#[derive(Debug, Clone, Deserialize)]
pub struct SwarmRow {
    #[serde(flatten)]
    pub swarm: Swarm,
    #[serde(default)]
    pub counts: SwarmCounts,
}

/// One node of the plan. Everything an agent wrote here (title, description, report,
/// flags) is untrusted text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmTask {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// "contains" or "depends_on".
    #[serde(default)]
    pub parent_relation: Option<String>,
    #[serde(default)]
    pub position: i64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// "plan" or "leaf".
    pub node_type: String,
    pub status: String,
    #[serde(default)]
    pub attention: Option<String>,
    #[serde(default)]
    pub weight: u32,
    #[serde(default)]
    pub assigned_run_id: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    #[serde(default)]
    pub flags: Value,
    #[serde(default)]
    pub report: Option<String>,
    #[serde(default, deserialize_with = "money")]
    pub cost_measured_usd: f64,
    #[serde(default, deserialize_with = "money")]
    pub cost_estimated_usd: f64,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    /// The landing retry route's own answer for this task.
    #[serde(default)]
    pub can_retry_landing: bool,
    /// Where its report stands with the planner: waiting, reviewing, restarting, stopped, undecided.
    #[serde(default)]
    pub review: Option<String>,
}

impl SwarmTask {
    pub fn is_leaf(&self) -> bool {
        self.node_type == "leaf"
    }

    pub fn flag(&self, name: &str) -> Option<&Value> {
        self.flags.get(name)
    }
}

/// An agent run of this swarm that is queued, starting or running.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmActiveRun {
    pub id: String,
    #[serde(default)]
    pub role: Option<String>,
    pub status: RunStatus,
    #[serde(default)]
    pub swarm_task_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub agent_started_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlannerAgent {
    pub name: String,
    #[serde(default)]
    pub cli: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerRun {
    pub id: String,
    pub status: RunStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub agent: Option<PlannerAgent>,
    #[serde(default)]
    pub queued_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
}

/// One branch on the merge queue.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub position: i64,
    /// queued, landing, landed, conflicted, failed, cancelled.
    pub status: String,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub resolver_run_id: Option<String>,
    #[serde(default)]
    pub not_before: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct LandingSummary {
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub committed: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmPullRequest {
    pub id: String,
    #[serde(default)]
    pub repo_url: String,
    pub number: u64,
    #[serde(default)]
    pub url: Option<String>,
}

/// One swarm with its plan, its runs and its merge queue.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmDetail {
    pub swarm: Swarm,
    #[serde(default)]
    pub tasks: Vec<SwarmTask>,
    #[serde(default)]
    pub active_runs: Vec<SwarmActiveRun>,
    #[serde(default)]
    pub agent_time_ms: f64,
    #[serde(default)]
    pub planner_run: Option<PlannerRun>,
    #[serde(default)]
    pub landings: Vec<Landing>,
    #[serde(default)]
    pub landing_summary: LandingSummary,
    #[serde(default)]
    pub pull_requests: Vec<SwarmPullRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub from_status: Option<String>,
    #[serde(default)]
    pub to_status: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub detail: Option<Value>,
}

/// A worker attempt on a task, newest first.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub status: RunStatus,
    #[serde(default)]
    pub queued_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub quiet_ms: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskCommit {
    pub sha: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
}

/// What the drawer asks for when a node is opened: its history, its worker attempts and
/// the commits made for it.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskDetail {
    #[serde(default)]
    pub events: Vec<TaskEvent>,
    #[serde(default)]
    pub runs: Vec<TaskRun>,
    #[serde(default)]
    pub commits: Vec<TaskCommit>,
}

/// Whether a message reached a running agent now (`live`) or waits for the next one.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct MessageReceipt {
    #[serde(default)]
    pub live: bool,
}

/// What a new swarm is made from. Absent agents are the install's own Swarm Planner and
/// Swarm Worker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSwarm {
    pub project_id: String,
    pub title: String,
    pub goal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planner_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_profile_id: Option<String>,
    pub deliverable: &'static str,
    pub max_workers: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_limit_min: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum SwarmUpdate {
    /// Something on this swarm changed. Events carry ids, not the new rows, so refetch.
    Changed(BoardEvent),
    /// The stream came back after a drop; what fired meanwhile is gone, so refetch.
    Reconnected,
    /// The server refused the stream for good (401, 403, 404).
    Ended(Error),
}

struct SwarmConsumer {
    path: String,
    on_update: Box<dyn FnMut(SwarmUpdate) + Send>,
}

impl Consumer for SwarmConsumer {
    fn path(&self) -> String {
        self.path.clone()
    }

    fn opened(&mut self, reconnect: bool) {
        if reconnect {
            (self.on_update)(SwarmUpdate::Reconnected);
        }
    }

    fn frame(&mut self, frame: Frame) -> Flow {
        if frame.event == "swarm_event"
            && let Ok(value) = serde_json::from_str::<Value>(&frame.data)
        {
            (self.on_update)(SwarmUpdate::Changed(BoardEvent::from_value(value)));
        }
        Flow::Continue
    }

    fn ended(&mut self, error: Error) {
        (self.on_update)(SwarmUpdate::Ended(error));
    }
}

impl Client {
    /// The project's swarms, newest first, with their task counts.
    pub fn list_swarms(&self, project_id: &str) -> Result<Vec<SwarmRow>> {
        self.get(&format!("/api/swarms?projectId={}", encode(project_id)))
    }

    pub fn get_swarm(&self, swarm_id: &str) -> Result<SwarmDetail> {
        self.get(&format!("/api/swarms/{}", encode(swarm_id)))
    }

    /// One node's history, worker attempts and commits.
    pub fn swarm_task(&self, swarm_id: &str, task_id: &str) -> Result<TaskDetail> {
        self.get(&format!("/api/swarms/{}/tasks/{}", encode(swarm_id), encode(task_id)))
    }

    /// Starts the planner on a new swarm, in the planning state.
    pub fn create_swarm(&self, input: &NewSwarm) -> Result<Swarm> {
        self.post("/api/swarms", Some(input))
    }

    fn swarm_action(&self, swarm_id: &str, action: &str) -> Result<()> {
        self.post_empty::<Value>(&format!("/api/swarms/{}/{action}", encode(swarm_id))).map(drop)
    }

    /// Approves a planned swarm, or resumes a paused one: one route decides when a swarm runs.
    pub fn start_swarm(&self, swarm_id: &str) -> Result<()> {
        self.swarm_action(swarm_id, "start")
    }

    pub fn pause_swarm(&self, swarm_id: &str) -> Result<()> {
        self.swarm_action(swarm_id, "pause")
    }

    /// Stops the swarm for good, agents included.
    pub fn cancel_swarm(&self, swarm_id: &str) -> Result<()> {
        self.swarm_action(swarm_id, "cancel")
    }

    pub fn retry_planner(&self, swarm_id: &str) -> Result<()> {
        self.swarm_action(swarm_id, "planner/retry")
    }

    pub fn stop_planner(&self, swarm_id: &str) -> Result<()> {
        self.swarm_action(swarm_id, "planner/stop")
    }

    fn task_action(&self, swarm_id: &str, task_id: &str, action: &str, body: Option<&Value>) -> Result<()> {
        let path = format!("/api/swarms/{}/tasks/{}/{action}", encode(swarm_id), encode(task_id));
        self.post::<Value>(&path, body).map(drop)
    }

    /// Stops the worker on one leaf; the coordinator then fails the leaf.
    pub fn stop_swarm_task(&self, swarm_id: &str, task_id: &str) -> Result<()> {
        self.task_action(swarm_id, task_id, "stop", None)
    }

    pub fn mark_swarm_task_done(&self, swarm_id: &str, task_id: &str) -> Result<()> {
        self.task_action(swarm_id, task_id, "done", None)
    }

    /// `fresh` starts the task over in a new sandbox from the swarm's branch ("Retry task");
    /// otherwise it continues in the same sandbox on the same branch.
    pub fn retry_swarm_task(&self, swarm_id: &str, task_id: &str, fresh: bool) -> Result<()> {
        let body = if fresh { serde_json::json!({ "fresh": true }) } else { serde_json::json!({}) };
        self.task_action(swarm_id, task_id, "retry", Some(&body))
    }

    pub fn retry_swarm_landing(&self, swarm_id: &str, task_id: &str) -> Result<()> {
        self.task_action(swarm_id, task_id, "landing/retry", None)
    }

    /// Withdraws the task and everything under it.
    pub fn cancel_swarm_task(&self, swarm_id: &str, task_id: &str) -> Result<()> {
        self.task_action(swarm_id, task_id, "cancel", None)
    }

    /// To the planner, or to the agent on one task when `task_id` is given.
    pub fn message_swarm(&self, swarm_id: &str, task_id: Option<&str>, text: &str) -> Result<MessageReceipt> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            text: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            task_id: Option<&'a str>,
        }
        self.post(&format!("/api/swarms/{}/messages", encode(swarm_id)), Some(&Body { text, task_id }))
    }

    /// Follows one swarm on its own thread until the handle is dropped.
    pub fn stream_swarm(&self, swarm_id: &str, on_update: impl FnMut(SwarmUpdate) + Send + 'static) -> Result<StreamHandle> {
        let consumer = SwarmConsumer { path: format!("/api/swarms/{}/events", encode(swarm_id)), on_update: Box::new(on_update) };
        stream::spawn(self, consumer, "bento-swarm-stream")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_detail_as_the_server_sent_it_decodes() {
        // Trimmed from a real local server's answer for a fake-agent swarm.
        let body = r#"{
          "swarm": {"id":"s","projectId":"p","slug":"x","title":"Cursor pagination","goal":"Page events.","status":"blocked",
                    "pausedReason":null,"branchName":"swarm/x","budgetUsd":"5","maxWorkers":2,"timeLimitMin":null,
                    "spentMeasuredUsd":"0.02","spentEstimatedUsd":"0","spentAssumedUsd":"0","createdAt":"2026-11-27T15:23:29.908Z"},
          "tasks": [{"id":"t","parentId":null,"parentRelation":"contains","position":0,"title":"Cursor type","description":"",
                     "nodeType":"leaf","status":"working","attention":"failed","weight":1,"assignedRunId":"r","branchName":"swarm/x-t",
                     "flags":{"plannerRetells":3},"report":"Working on it.","costMeasuredUsd":"0.01","costEstimatedUsd":"0",
                     "startedAt":null,"endedAt":null,"canRetryLanding":false,"review":"undecided"}],
          "activeRuns": [{"id":"r2","role":"worker","status":"running","swarmTaskId":"t2","queuedAt":"x","startedAt":null,"agentStartedAt":null}],
          "agentTimeMs": 75279.347,
          "plannerRun": {"id":"pr","status":"succeeded","error":null,"agent":{"name":"Fake Planner","cli":"fake","model":"fake-1"},"queuedAt":"q"},
          "landings": [], "landingSummary": {"total":0,"committed":0}, "pullRequests": [],
          "branchCheckout": {"mode":"worktree","released":false}
        }"#;
        let d: SwarmDetail = serde_json::from_str(body).unwrap();
        assert_eq!(d.swarm.budget_usd, Some(5.0));
        assert!((d.swarm.spent_usd() - 0.02).abs() < 1e-9);
        assert_eq!(d.tasks[0].review.as_deref(), Some("undecided"));
        assert_eq!(d.tasks[0].flag("plannerRetells").and_then(Value::as_u64), Some(3));
        assert_eq!(d.active_runs[0].status, RunStatus::Running);
        assert_eq!(d.planner_run.unwrap().agent.unwrap().name, "Fake Planner");
    }

    #[test]
    fn a_list_row_keeps_its_counts() {
        let row: SwarmRow = serde_json::from_str(
            r#"{"id":"s","projectId":"p","title":"T","status":"running","counts":{"tasks":5,"done":3,"attention":1}}"#,
        )
        .unwrap();
        assert_eq!((row.swarm.title.as_str(), row.counts.tasks, row.counts.done), ("T", 5, 3));
    }

    #[test]
    fn stream_frames_are_changes_and_the_rest_is_ignored() {
        let (tx, rx) = mpsc::channel();
        let mut c = SwarmConsumer { path: String::new(), on_update: Box::new(move |u| tx.send(u).unwrap()) };
        c.frame(Frame { event: "keepalive".into(), data: String::new(), id: None });
        c.frame(Frame { event: "swarm_event".into(), data: "{broken".into(), id: None });
        c.frame(Frame {
            event: "swarm_event".into(),
            data: r#"{"type":"swarm_task_updated","projectId":"p","swarmId":"s","taskId":"t","status":"working"}"#.into(),
            id: None,
        });
        c.opened(true);
        drop(c);
        let got: Vec<SwarmUpdate> = rx.iter().collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(matches!(&got[0], SwarmUpdate::Changed(BoardEvent::SwarmTaskUpdated { task_id: Some(t), .. }) if t == "t"));
        assert!(matches!(got[1], SwarmUpdate::Reconnected));
    }
}
