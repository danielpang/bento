//! Supervises the local server: `node sidecar.mjs`, JSON lines on stdout, stopped by closing
//! its stdin. The sidecar also stops on its own when this process dies (its stdin pipe closes,
//! and it watches its parent), so a crash or a kill leaves nothing running.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Progress(String),
    Ready(String),
    Error(String),
    /// The process exited. `None` when it was killed by a signal.
    Exited(Option<i32>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub node: PathBuf,
    pub script: PathBuf,
}

/// Where the sidecar is: the environment, then a `.app` bundle's Resources, then this repo.
pub fn resolve(env: impl Fn(&str) -> Option<String>, exe: Option<&Path>, exists: impl Fn(&Path) -> bool) -> Result<Launch, String> {
    let env_path = |name: &str| env(name).filter(|v| !v.trim().is_empty()).map(PathBuf::from);
    let node_override = env_path("BENTO_NODE");
    if let Some(script) = env_path("BENTO_SIDECAR_JS") {
        return Ok(Launch { node: node_override.unwrap_or_else(|| "node".into()), script });
    }
    if let Some(resources) = exe.and_then(Path::parent).map(|macos| macos.join("../Resources")) {
        let script = resources.join("sidecar/bin/sidecar.mjs");
        if exists(&script) {
            let bundled = ["sidecar/bin/node", "node/bin/node", "bin/node"].map(|p| resources.join(p)).into_iter().find(|p| exists(p));
            return Ok(Launch { node: node_override.or(bundled).unwrap_or_else(|| "node".into()), script });
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/dist/bin/sidecar.mjs");
    if exists(&dev) {
        return Ok(Launch { node: node_override.unwrap_or_else(|| "node".into()), script: dev });
    }
    Err(format!(
        "Could not find the local server. Run `pnpm --filter @bento/mac-sidecar bundle`, or set BENTO_SIDECAR_JS. Looked in {}.",
        dev.display()
    ))
}

/// Reads one stdout line. Unknown events and anything that is not JSON are ignored.
pub fn parse_line(line: &str) -> Option<Event> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let text = |k: &str| v.get(k).and_then(|m| m.as_str()).map(str::to_owned);
    match v.get("event")?.as_str()? {
        "progress" => text("message").map(Event::Progress),
        "ready" => text("url").map(Event::Ready),
        "error" => text("message").map(Event::Error),
        _ => None,
    }
}

pub struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl Sidecar {
    /// Starts it and reads its stdout on a thread, handing each event to `on_event`.
    /// `env` is set over the inherited environment.
    pub fn start(launch: &Launch, env: &[(String, String)], mut on_event: impl FnMut(Event) + Send + 'static) -> Result<Sidecar, String> {
        let mut cmd = Command::new(&launch.node);
        cmd.arg(&launch.script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
        if let Ok(dir) = std::env::var("BENTO_DATA_DIR") {
            cmd.env("BENTO_DATA_DIR", dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start the local server with {}: {e}", launch.node.display()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("the local server has no stdout")?;
        std::thread::Builder::new()
            .name("bento-sidecar".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Some(event) = parse_line(&line) {
                        on_event(event);
                    }
                }
                // stdout closes as the process exits; its code is collected by `exit_code`.
                on_event(Event::Exited(None));
            })
            .map_err(|e| e.to_string())?;
        Ok(Sidecar { child, stdin })
    }

    pub fn exit_code(&mut self) -> Option<Option<i32>> {
        self.child.try_wait().ok().flatten().map(|s| s.code())
    }

    fn wait_for(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// Closes stdin (the sidecar's clean stop), then SIGTERM, then SIGKILL, each with a bound.
    pub fn stop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        drop(self.stdin.take());
        if self.wait_for(Duration::from_secs(8)) {
            return;
        }
        let _ = Command::new("kill").arg("-TERM").arg(self.child.id().to_string()).status();
        // The sidecar's own limit for stopping Postgres is 12 seconds.
        if self.wait_for(Duration::from_secs(13)) {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn lines_parse() {
        assert_eq!(parse_line(r#"{"event":"progress","message":"Starting the local database."}"#), Some(Event::Progress("Starting the local database.".into())));
        assert_eq!(
            parse_line(r#"{"event":"ready","url":"http://127.0.0.1:64500","port":64500,"databasePort":null,"sandbox":"local-process"}"#),
            Some(Event::Ready("http://127.0.0.1:64500".into()))
        );
        assert_eq!(parse_line(r#"{"event":"error","message":"boom"}"#), Some(Event::Error("boom".into())));
        assert_eq!(parse_line(r#"{"event":"stopping","reason":"SIGTERM"}"#), None);
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line(r#"{"event":"ready"}"#), None);
    }

    #[test]
    fn resolution_order() {
        let env = |vars: &[(&str, &str)]| {
            let m: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            move |k: &str| m.get(k).cloned()
        };
        let exe = Path::new("/Apps/Bento.app/Contents/MacOS/bento-mac");
        let bundle_js = exe.parent().unwrap().join("../Resources/sidecar/bin/sidecar.mjs");
        let bundle_node = exe.parent().unwrap().join("../Resources/node/bin/node");

        let l = resolve(env(&[("BENTO_SIDECAR_JS", "/x/s.mjs"), ("BENTO_NODE", "/x/node")]), Some(exe), |_| true).unwrap();
        assert_eq!(l, Launch { node: "/x/node".into(), script: "/x/s.mjs".into() });

        let (js, node) = (bundle_js.clone(), bundle_node.clone());
        let l = resolve(env(&[]), Some(exe), move |p| p == js || p == node).unwrap();
        assert_eq!(l, Launch { node: bundle_node.clone(), script: bundle_js.clone() });

        let js = bundle_js.clone();
        let l = resolve(env(&[]), Some(exe), move |p| p == js).unwrap();
        assert_eq!(l.node, PathBuf::from("node"));

        let l = resolve(env(&[("BENTO_NODE", "/opt/node")]), None, |p| p.ends_with("sidecar/dist/bin/sidecar.mjs")).unwrap();
        assert_eq!(l.node, PathBuf::from("/opt/node"));
        assert!(l.script.ends_with("sidecar/dist/bin/sidecar.mjs"));

        assert!(resolve(env(&[]), Some(exe), |_| false).is_err());
    }

    #[test]
    fn stops_a_real_child_by_closing_stdin() {
        // `cat` exits at end of input, as the sidecar does.
        let launch = Launch { node: "cat".into(), script: "-".into() };
        let (tx, rx) = std::sync::mpsc::channel();
        let mut s = Sidecar::start(&launch, &[], move |e| tx.send(e).unwrap()).unwrap();
        let started = Instant::now();
        s.stop();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Event::Exited(None));
        assert!(s.exit_code().is_some());
    }
}
