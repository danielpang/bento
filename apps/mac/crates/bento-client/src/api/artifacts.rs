//! Artifacts endpoints: what agents produced, per project and per card, and one artifact's bytes.

use std::io::Read;

use serde::Deserialize;

use crate::client::{Client, encode};
use crate::error::{Error, Result};

/// The largest body the app reads for a preview; bigger artifacts are left to the browser.
pub const ARTIFACT_PREVIEW_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// One card in the project's artifacts list, newest activity first.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArtifactCard {
    pub feature_id: String,
    pub title: String,
    pub artifact_count: u32,
    /// "markdown", "mermaid", "image", "html" or "file", in that order.
    #[serde(default)]
    pub kinds: Vec<String>,
    pub latest_created_at: String,
    /// Every artifact's path on the card, newest first.
    #[serde(default)]
    pub paths: Vec<String>,
}

/// One file an agent produced for people. Metadata only; the body comes from `artifact_content`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    pub id: String,
    pub run_id: String,
    #[serde(default)]
    pub stage_slug: String,
    #[serde(default)]
    pub stage_name: String,
    /// Where the agent wrote it, relative to the workspace.
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub size: u64,
    pub created_at: String,
}

impl Client {
    /// Every card in the project that has artifacts, newest activity first.
    pub fn project_artifacts(&self, project_id: &str) -> Result<Vec<ProjectArtifactCard>> {
        self.get(&format!("/api/projects/{}/artifacts", encode(project_id)))
    }

    /// The card's artifacts, newest first, at most 200.
    pub fn feature_artifacts(&self, feature_id: &str) -> Result<Vec<RunArtifact>> {
        self.get(&format!("/api/features/{}/artifacts", encode(feature_id)))
    }

    /// Where the server serves an artifact's bytes (as a download for anything that could run).
    pub fn artifact_content_url(&self, artifact_id: &str) -> String {
        format!("{}/api/artifacts/{}/content", self.base_url(), encode(artifact_id))
    }

    /// The web console's page for one artifact, which renders HTML in a sandboxed frame.
    pub fn artifact_console_url(&self, artifact_id: &str) -> String {
        format!("{}/artifact/{}", self.base_url(), encode(artifact_id))
    }

    /// One artifact's bytes, refused past `ARTIFACT_PREVIEW_MAX_BYTES`.
    pub fn artifact_content(&self, artifact_id: &str) -> Result<Vec<u8>> {
        let req = self.request("GET", &format!("/api/artifacts/{}/content", encode(artifact_id))).set("accept", "*/*");
        let res = match req.call() {
            Ok(res) => res,
            Err(ureq::Error::Status(status, res)) => return Err(Error::from_response(status, res.into_string().unwrap_or_default())),
            Err(ureq::Error::Transport(t)) => return Err(Error::Transport(t.to_string())),
        };
        let mut bytes = Vec::new();
        res.into_reader()
            .take(ARTIFACT_PREVIEW_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| Error::Transport(e.to_string()))?;
        if bytes.len() as u64 > ARTIFACT_PREVIEW_MAX_BYTES {
            return Err(Error::Decode { message: "Artifact exceeds the preview size limit. Save it to inspect it.".into(), body: String::new() });
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_servers_shapes() {
        let cards: Vec<ProjectArtifactCard> = serde_json::from_str(
            r#"[{"featureId":"f1","title":"Plan","artifactCount":2,"kinds":["markdown","image"],"latestCreatedAt":"2026-11-27T06:30:54.000Z",
                "paths":["artifacts/a.png","docs/bento/plan.md"],"preview":{"artifactId":"a1","kind":"image"}}]"#,
        )
        .unwrap();
        assert_eq!(cards[0].artifact_count, 2);
        assert_eq!(cards[0].paths.len(), 2);
        let rows: Vec<RunArtifact> = serde_json::from_str(
            r#"[{"id":"a1","runId":"r1","stageSlug":"plan","stageName":"Plan","path":"docs/bento/plan.md","kind":"markdown",
                "mime":"text/markdown","size":120,"createdAt":"2026-11-27T06:30:54.000Z"}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].stage_name, "Plan");
        assert_eq!(rows[0].size, 120);
    }

    #[test]
    fn urls_escape_the_id() {
        let c = Client::new("http://127.0.0.1:4400").unwrap();
        assert_eq!(c.artifact_content_url("a/b"), "http://127.0.0.1:4400/api/artifacts/a%2Fb/content");
        assert_eq!(c.artifact_console_url("a1"), "http://127.0.0.1:4400/artifact/a1");
    }
}
