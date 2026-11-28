//! Supervises the local server: `node sidecar.mjs`, JSON lines on stdout, stopped by closing
//! its stdin. The sidecar also stops on its own when this process dies (its stdin pipe closes,
//! and it watches its parent), so a crash or a kill leaves nothing running.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::shell_env;

/// What the boot screen says after the person cancelled a start, as the Electron launcher does.
pub const CANCELLED: &str = "Connection cancelled.";
const PORT_VAR: &str = "BENTO_SIDECAR_PORT";

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
    /// `env` is set over the inherited environment, with the login shell's PATH and the port
    /// the server had last time. Waits first for an earlier server that is still stopping, since
    /// two on one data folder fight over its Postgres.
    pub fn start(launch: &Launch, env: &[(String, String)], mut on_event: impl FnMut(Event) + Send + 'static) -> Result<Sidecar, String> {
        wait_for_stops(Duration::from_secs(25));
        let mut cmd = Command::new(&launch.node);
        cmd.arg(&launch.script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        cmd.env("PATH", with_node_dir(shell_env::path(), &launch.node));
        if std::env::var_os("HOME").is_none()
            && let Some(home) = shell_env::home()
        {
            cmd.env("HOME", home);
        }
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
        if let Ok(dir) = std::env::var("BENTO_DATA_DIR") {
            cmd.env("BENTO_DATA_DIR", dir);
        }
        // A stable port keeps the pages the app opened (GitHub, MCP and OAuth callbacks) working
        // across launches. The sidecar falls back to a free port when this one is taken.
        let port_file = crate::data::data_dir().join("mac-app").join("port");
        let chosen = env.iter().any(|(k, _)| k == PORT_VAR) || std::env::var_os(PORT_VAR).is_some_and(|v| !v.is_empty());
        let remember = (!chosen).then(|| port_file.clone());
        if !chosen && let Some(port) = std::fs::read_to_string(&port_file).ok().and_then(|t| saved_port(&t)) {
            cmd.env(PORT_VAR, port.to_string());
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
                        if let (Event::Ready(url), Some(file)) = (&event, &remember)
                            && let Some(port) = port_of(url)
                        {
                            let _ = std::fs::write(file, port.to_string());
                        }
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

    /// Stops it on a thread. The next `start` waits for it.
    pub fn stop_in_background(mut self) {
        let stopping = Stopping::begin();
        std::thread::spawn(move || {
            self.stop();
            drop(stopping);
        });
    }

    /// Closes stdin (the sidecar's clean stop), then SIGTERM, then SIGKILL, each with a bound.
    pub fn stop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _stopping = Stopping::begin();
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

static STOPPING: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

/// Counts a stop in progress for as long as it lives.
struct Stopping;

impl Stopping {
    fn begin() -> Stopping {
        *STOPPING.0.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        Stopping
    }
}

impl Drop for Stopping {
    fn drop(&mut self) {
        *STOPPING.0.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        STOPPING.1.notify_all();
    }
}

fn wait_for_stops(limit: Duration) {
    let count = STOPPING.0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = STOPPING.1.wait_timeout_while(count, limit, |n| *n > 0);
}

/// The bundled node's folder goes last, so scripts that run `node` (npm installed agent CLIs)
/// still find one on a Mac without it.
fn with_node_dir(path: &str, node: &Path) -> String {
    match node.parent().filter(|d| node.is_absolute() && !path.split(':').any(|p| Path::new(p) == *d)) {
        Some(dir) => format!("{path}:{}", dir.display()),
        None => path.to_owned(),
    }
}

fn saved_port(text: &str) -> Option<u16> {
    text.trim().parse().ok().filter(|p| *p >= 1024)
}

fn port_of(url: &str) -> Option<u16> {
    url.rsplit(':').next()?.trim_end_matches('/').parse().ok()
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
    fn ports_and_path() {
        assert_eq!(port_of("http://127.0.0.1:64500"), Some(64500));
        assert_eq!(port_of("http://127.0.0.1:64500/"), Some(64500));
        assert_eq!(saved_port("51234\n"), Some(51234));
        assert_eq!(saved_port("80"), None);
        assert_eq!(saved_port(""), None);
        let node = Path::new("/A/Bento.app/Contents/Resources/sidecar/bin/node");
        assert_eq!(with_node_dir("/usr/bin", node), "/usr/bin:/A/Bento.app/Contents/Resources/sidecar/bin");
        assert_eq!(with_node_dir("/usr/bin", Path::new("node")), "/usr/bin");
        assert_eq!(with_node_dir("/opt/n/bin:/usr/bin", Path::new("/opt/n/bin/node")), "/opt/n/bin:/usr/bin");
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
