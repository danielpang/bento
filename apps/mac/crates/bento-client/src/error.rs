use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

/// Everything a call can fail with, split by what the caller can do about it.
#[derive(Debug, Clone)]
pub enum Error {
    /// The base URL could not be used.
    Url(String),
    /// No answer: the connection was refused, dropped, or timed out.
    Transport(String),
    /// The server answered with a status outside 2xx. `message` is the
    /// sentence inside the server's `{"error": ...}` body, or the raw body
    /// when it had no such field.
    Api {
        status: u16,
        message: String,
        code: Option<String>,
        body: String,
    },
    /// The server answered 2xx with a body this client could not read.
    Decode { message: String, body: String },
}

impl Error {
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
    }

    /// 401 or 403: retrying with the same credentials cannot help.
    pub fn is_auth(&self) -> bool {
        matches!(self.status(), Some(401 | 403))
    }

    /// Builds an `Api` error from a non-2xx response body.
    pub fn from_response(status: u16, body: String) -> Self {
        let (message, code) = unwrap_error_body(&body);
        Error::Api {
            status,
            message: message.unwrap_or_else(|| {
                if body.trim().is_empty() {
                    format!("HTTP {status}")
                } else {
                    body.clone()
                }
            }),
            code,
            body,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Url(m) => write!(f, "invalid server address: {m}"),
            Error::Transport(m) => write!(f, "could not reach the server: {m}"),
            Error::Api { status, message, .. } => write!(f, "{message} (HTTP {status})"),
            Error::Decode { message, .. } => write!(f, "unexpected response from the server: {message}"),
        }
    }
}

impl std::error::Error for Error {}

/// The sentence and code inside a refusal body. Handlers answer
/// `{"error": "a sentence", "code"?: "..."}`; a request the validator
/// rejects answers with the ZodError object under the same key, which is
/// summarised the way the console's `unwrapError` does it.
fn unwrap_error_body(body: &str) -> (Option<String>, Option<String>) {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(body) else {
        return (None, None);
    };
    let code = map.get("code").and_then(|c| c.as_str()).map(str::to_owned);
    let message = match map.get("error") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Object(e)) => e.get("issues").and_then(summarise_issues),
        _ => None,
    }
    .or_else(|| map.get("message").and_then(|m| m.as_str()).map(str::to_owned));
    (message, code)
}

fn summarise_issues(issues: &serde_json::Value) -> Option<String> {
    let issues = issues.as_array().filter(|a| !a.is_empty())?;
    let lines: Vec<String> = issues
        .iter()
        .take(3)
        .map(|issue| {
            let field = issue
                .get("path")
                .and_then(|p| p.as_array())
                .map(|p| {
                    p.iter()
                        .map(|seg| match seg {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            let options = issue.get("options").and_then(|o| o.as_array()).filter(|o| !o.is_empty());
            let detail = if let Some(options) = options {
                let names: Vec<String> = options
                    .iter()
                    .map(|o| o.as_str().map(str::to_owned).unwrap_or_else(|| o.to_string()))
                    .collect();
                format!("expected one of {}", names.join(", "))
            } else if issue.get("received").and_then(|r| r.as_str()) == Some("undefined") {
                "required".to_owned()
            } else {
                issue
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("is not valid")
                    .to_owned()
            };
            if field.is_empty() { detail } else { format!("{field}: {detail}") }
        })
        .collect();
    let more = if issues.len() > lines.len() {
        format!(", and {} more", issues.len() - lines.len())
    } else {
        String::new()
    };
    Some(format!("{}{more}", lines.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_refusal_keeps_its_sentence_and_code() {
        let e = Error::from_response(402, r#"{"error":"Out of agent hours","code":"PLAN_LIMIT"}"#.into());
        assert_eq!(e.status(), Some(402));
        assert_eq!(e.code(), Some("PLAN_LIMIT"));
        assert_eq!(e.to_string(), "Out of agent hours (HTTP 402)");
    }

    #[test]
    fn zod_refusal_is_summarised() {
        // Captured from POST /api/features/:id/move with a bad stage id.
        let body = r#"{"success":false,"error":{"issues":[{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":["stageId"]}],"name":"ZodError"}}"#;
        let Error::Api { message, .. } = Error::from_response(400, body.into()) else { panic!() };
        assert_eq!(message, "stageId: Invalid uuid");
    }

    #[test]
    fn enum_refusal_names_the_options() {
        let body = r#"{"error":{"issues":[{"path":["gateType"],"options":["manual","auto"]},{"path":["name"],"received":"undefined"},{"path":["a"]},{"path":["b"]}]}}"#;
        let Error::Api { message, .. } = Error::from_response(400, body.into()) else { panic!() };
        assert_eq!(message, "gateType: expected one of manual, auto; name: required; a: is not valid, and 1 more");
    }

    #[test]
    fn non_json_body_is_shown_as_is() {
        let Error::Api { message, .. } = Error::from_response(502, "Bad Gateway".into()) else { panic!() };
        assert_eq!(message, "Bad Gateway");
        let Error::Api { message, .. } = Error::from_response(500, String::new()) else { panic!() };
        assert_eq!(message, "HTTP 500");
    }
}
