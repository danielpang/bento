use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{Error, Result};
use crate::stream::{self, BoardUpdate, RunUpdate, StreamHandle};
use crate::types::*;

const MAX_BODY: u64 = 64 * 1024 * 1024;

/// A blocking client for one Bento server. Cheap to clone; clones share the
/// connection pool and the bearer token, so it can be handed to a worker pool.
#[derive(Clone)]
pub struct Client {
    base: Arc<str>,
    token: Arc<RwLock<Option<String>>>,
    agent: ureq::Agent,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).finish_non_exhaustive()
    }
}

/// Percent-encodes one path segment or query value.
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Client {
    /// `base_url` is the server's origin, such as `http://127.0.0.1:4400`.
    pub fn new(base_url: &str) -> Result<Self> {
        let base = base_url.trim().trim_end_matches('/');
        let host = base.strip_prefix("http://").or_else(|| base.strip_prefix("https://"));
        if host.is_none_or(str::is_empty) {
            return Err(Error::Url(format!("{base_url:?} must start with http:// or https://")));
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(60))
            .timeout_write(Duration::from_secs(60))
            .build();
        Ok(Self { base: base.into(), token: Arc::new(RwLock::new(None)), agent })
    }

    /// Sends `Authorization: Bearer <token>` on every request. Local mode
    /// needs none; a hosted server will.
    pub fn with_token(self, token: impl Into<String>) -> Self {
        self.set_token(Some(token.into()));
        self
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.write().unwrap_or_else(|e| e.into_inner()) = token;
    }

    pub(crate) fn token(&self) -> Option<String> {
        self.token.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub(crate) fn request(&self, method: &str, path: &str) -> ureq::Request {
        let mut req = self.agent.request(method, &format!("{}{path}", self.base)).set("accept", "application/json");
        if let Some(token) = self.token() {
            req = req.set("authorization", &format!("Bearer {token}"));
        }
        req
    }

    pub(crate) fn send(&self, req: ureq::Request, body: Option<String>) -> Result<String> {
        let result = match body {
            Some(b) => req.set("content-type", "application/json").send_string(&b),
            None => req.call(),
        };
        match result {
            Ok(res) => read_body(res),
            Err(ureq::Error::Status(status, res)) => Err(Error::from_response(status, read_body(res).unwrap_or_default())),
            Err(ureq::Error::Transport(t)) => Err(Error::Transport(t.to_string())),
        }
    }

    pub(crate) fn decode<T: DeserializeOwned>(body: String) -> Result<T> {
        serde_json::from_str(&body).map_err(|e| Error::Decode { message: e.to_string(), body })
    }

    pub(crate) fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        Self::decode(self.send(self.request("GET", path), None)?)
    }

    pub(crate) fn post<T: DeserializeOwned>(&self, path: &str, body: Option<&impl Serialize>) -> Result<T> {
        let body = body
            .map(|b| serde_json::to_string(b).map_err(|e| Error::Decode { message: e.to_string(), body: String::new() }))
            .transpose()?;
        Self::decode(self.send(self.request("POST", path), body)?)
    }

    pub(crate) fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.post(path, None::<&()>)
    }

    pub fn health(&self) -> Result<Health> {
        self.get("/api/health")
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.get("/api/projects")
    }

    pub fn get_project(&self, project_id: &str) -> Result<Project> {
        self.get(&format!("/api/projects/{}", encode(project_id)))
    }

    /// Creates the project and seeds its default pipeline and agents.
    pub fn create_project(&self, input: &NewProject) -> Result<Project> {
        self.post("/api/projects", Some(input))
    }

    pub fn pipeline(&self, project_id: &str) -> Result<Pipeline> {
        self.get(&format!("/api/projects/{}/pipeline", encode(project_id)))
    }

    pub fn list_features(&self, project_id: &str) -> Result<Vec<Feature>> {
        self.get(&format!("/api/features?projectId={}", encode(project_id)))
    }

    /// Each card's newest run status, cost and latest line, in one request.
    pub fn board_runs(&self, project_id: &str) -> Result<HashMap<String, CardRun>> {
        let text = self.send(self.request("GET", &format!("/api/projects/{}/board/plain", encode(project_id))), None)?;
        Ok(parse_board_plain(&text))
    }

    /// The pipeline, the cards and their runs: three requests.
    pub fn board(&self, project_id: &str) -> Result<Board> {
        Ok(Board {
            pipeline: self.pipeline(project_id)?,
            features: self.list_features(project_id)?,
            runs: self.board_runs(project_id)?,
        })
    }

    pub fn get_feature(&self, feature_id: &str) -> Result<FeatureDetail> {
        self.get(&format!("/api/features/{}", encode(feature_id)))
    }

    /// The new card lands in the backlog. The server emits no board event
    /// for a create, so refetch or insert it yourself.
    pub fn create_feature(&self, input: &NewFeature) -> Result<Feature> {
        self.post("/api/features", Some(input))
    }

    /// Puts the card in any stage, or the backlog with None. Entering a stage
    /// with an assigned agent starts that agent.
    pub fn move_feature(&self, feature_id: &str, stage_id: Option<&str>) -> Result<Feature> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            stage_id: Option<&'a str>,
        }
        self.post(&format!("/api/features/{}/move", encode(feature_id)), Some(&Body { stage_id }))
    }

    /// The next stage, or the first from the backlog.
    pub fn advance_feature(&self, feature_id: &str) -> Result<Feature> {
        self.post_empty(&format!("/api/features/{}/advance", encode(feature_id)))
    }

    /// One stage back; from done this reopens the card in its last stage.
    pub fn move_feature_back(&self, feature_id: &str) -> Result<Feature> {
        self.post_empty(&format!("/api/features/{}/back", encode(feature_id)))
    }

    /// Marks the card done from any stage (the Completed lane's drop).
    pub fn finish_feature(&self, feature_id: &str) -> Result<Feature> {
        self.post_empty(&format!("/api/features/{}/finish", encode(feature_id)))
    }

    /// Approves a manual stage, which advances the card.
    pub fn approve_feature(&self, feature_id: &str) -> Result<ApproveResult> {
        self.post_empty(&format!("/api/features/{}/approve", encode(feature_id)))
    }

    /// Rejects a manual stage, sending the card back one stage.
    pub fn reject_feature(&self, feature_id: &str, reason: Option<&str>) -> Result<Feature> {
        let query = reason.map(|r| format!("?reason={}", encode(r))).unwrap_or_default();
        self.post_empty(&format!("/api/features/{}/reject{query}", encode(feature_id)))
    }

    pub fn conversation(&self, feature_id: &str) -> Result<Conversation> {
        self.get(&format!("/api/features/{}/conversation", encode(feature_id)))
    }

    /// Says something to the card's agent: resumes an idle session, or is
    /// delivered to (or queued behind) a working one.
    pub fn message_feature(&self, feature_id: &str, text: &str) -> Result<MessageResult> {
        #[derive(Serialize)]
        struct Body<'a> {
            text: &'a str,
        }
        self.post(&format!("/api/features/{}/message", encode(feature_id)), Some(&Body { text }))
    }

    /// Starts an agent on a card's stage. 409 with the server's sentence when
    /// the card already has a run active.
    pub fn start_run(&self, input: &StartRun) -> Result<AgentRun> {
        self.post("/api/runs", Some(input))
    }

    pub fn get_run(&self, run_id: &str) -> Result<AgentRun> {
        self.get(&format!("/api/runs/{}", encode(run_id)))
    }

    /// Ends the run.
    pub fn cancel_run(&self, run_id: &str) -> Result<AgentRun> {
        self.post_empty(&format!("/api/runs/{}/cancel", encode(run_id)))
    }

    /// Stops the current turn and keeps the session open. Only a running
    /// live session of a stage run on an agent that supports it; otherwise
    /// 409.
    pub fn interrupt_run(&self, run_id: &str) -> Result<InterruptResult> {
        self.post_empty(&format!("/api/runs/{}/interrupt", encode(run_id)))
    }

    /// The caller's agent profiles, by name.
    pub fn profiles(&self) -> Result<Vec<AgentProfile>> {
        self.get("/api/profiles")
    }

    /// Follows the project's board on its own thread until the handle is
    /// dropped. Board events are not persisted, so after
    /// `BoardUpdate::Reconnected` refetch the board to fill the gap.
    pub fn stream_board(&self, project_id: &str, on_update: impl FnMut(BoardUpdate) + Send + 'static) -> Result<StreamHandle> {
        stream::board(self, project_id, Box::new(on_update))
    }

    /// Replays a run's events after `since` and follows it live until it
    /// ends, reconnecting from the last seq it delivered.
    pub fn stream_run(&self, run_id: &str, since: u64, on_update: impl FnMut(RunUpdate) + Send + 'static) -> Result<StreamHandle> {
        stream::run(self, run_id, since, Box::new(on_update))
    }

    /// `stream_board` delivering into a channel.
    pub fn board_channel(&self, project_id: &str) -> Result<(StreamHandle, std::sync::mpsc::Receiver<BoardUpdate>)> {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = self.stream_board(project_id, move |u| {
            let _ = tx.send(u);
        })?;
        Ok((handle, rx))
    }

    /// `stream_run` delivering into a channel.
    pub fn run_channel(&self, run_id: &str, since: u64) -> Result<(StreamHandle, std::sync::mpsc::Receiver<RunUpdate>)> {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = self.stream_run(run_id, since, move |u| {
            let _ = tx.send(u);
        })?;
        Ok((handle, rx))
    }
}

fn read_body(res: ureq::Response) -> Result<String> {
    let mut body = String::new();
    res.into_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|e| Error::Transport(e.to_string()))?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_validated_and_trimmed() {
        assert_eq!(Client::new("http://127.0.0.1:4400/").unwrap().base_url(), "http://127.0.0.1:4400");
        assert!(matches!(Client::new("127.0.0.1:4400"), Err(Error::Url(_))));
        assert!(matches!(Client::new("http://"), Err(Error::Url(_))));
    }

    #[test]
    fn encoding_leaves_ids_alone_and_escapes_the_rest() {
        assert_eq!(encode("d65bccc0-5ece-4277-bfe1-d25527e9b933"), "d65bccc0-5ece-4277-bfe1-d25527e9b933");
        assert_eq!(encode("a b/c?&"), "a%20b%2Fc%3F%26");
    }

    #[test]
    fn transport_failure_is_its_own_kind() {
        // Port 9 (discard) on loopback is closed on a normal machine.
        let err = Client::new("http://127.0.0.1:9").unwrap().health().unwrap_err();
        assert!(matches!(err, Error::Transport(_)), "{err:?}");
    }
}
