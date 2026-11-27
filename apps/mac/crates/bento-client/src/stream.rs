//! SSE readers, each on its own thread.
//!
//! The request is written over a plain `TcpStream` rather than through ureq
//! because a reader blocked in `read` has to stop the moment its handle is
//! dropped: the handle keeps a clone of the socket and shuts it down, which
//! returns the blocked read at once. ureq does not expose its socket. Local
//! mode serves http only, so this transport speaks http only.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::client::{Client, encode};
use crate::error::{Error, Result};
use crate::sse::{Frame, SseParser};
use crate::types::{AgentDelta, AgentEvent, BoardEvent, RunStatus, TurnState};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The server writes a keepalive every 25 seconds, so a silence this long
/// is a dead connection.
const READ_TIMEOUT: Duration = Duration::from_secs(70);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_ERROR_BODY: u64 = 64 * 1024;
const MAX_BACKOFF_MS: u64 = 8_000;

#[derive(Debug, Clone)]
pub enum BoardUpdate {
    Event(BoardEvent),
    /// The stream opened again after a drop. Events emitted meanwhile are
    /// gone (the server keeps none), so refetch the board.
    Reconnected,
    /// The stream stopped for good: the server refused it (401, 403, 404).
    Ended(Error),
}

#[derive(Debug, Clone)]
pub enum RunUpdate {
    /// A persisted transcript line. `seq` is strictly increasing; replays
    /// after a reconnect are dropped before they reach here.
    Event {
        seq: u64,
        event: AgentEvent,
        recorded_at: Option<String>,
    },
    /// Live typing, never replayed. The finished `Message` supersedes it.
    Delta(AgentDelta),
    Turn(TurnState),
    /// The run ended; the stream stops after this.
    Done { status: RunStatus },
    Reconnected,
    Ended(Error),
}

struct Shared {
    stopped: Mutex<bool>,
    wake: Condvar,
    socket: Mutex<Option<TcpStream>>,
}

impl Shared {
    fn stopped(&self) -> bool {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
        if let Some(socket) = self.socket.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    /// Sleeps for `ms`, or until stopped. Returns whether it was stopped.
    fn sleep(&self, ms: u64) -> bool {
        let guard = self.stopped.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self
            .wake
            .wait_timeout_while(guard, Duration::from_millis(ms), |stopped| !*stopped)
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }
}

/// Owns a stream's thread. Dropping it stops the stream promptly without
/// waiting; `stop` also waits for the thread, and so for the last callback.
pub struct StreamHandle {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl StreamHandle {
    pub fn stop(mut self) {
        self.shared.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    /// True once the thread has exited (dropped, ended, or the run finished).
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

impl std::fmt::Debug for StreamHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamHandle").field("finished", &self.is_finished()).finish()
    }
}

#[derive(Debug, Clone)]
struct Target {
    host: String,
    port: u16,
    prefix: String,
}

fn target(base: &str) -> Result<Target> {
    let Some(rest) = base.strip_prefix("http://") else {
        return Err(Error::Url("event streams need an http:// server; https is not supported yet".into()));
    };
    let (authority, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
        None => (rest, ""),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !authority.ends_with(']') => match p.parse::<u16>() {
            Ok(port) => (h, port),
            Err(_) => return Err(Error::Url(format!("bad port in {base:?}"))),
        },
        _ => (authority, 80),
    };
    if host.is_empty() {
        return Err(Error::Url(format!("no host in {base:?}")));
    }
    Ok(Target { host: host.to_owned(), port, prefix: prefix.to_owned() })
}

enum Framing {
    Chunked { left: u64, done: bool },
    Length(u64),
    Close,
}

/// A response body read straight off the socket.
struct Body {
    reader: BufReader<TcpStream>,
    framing: Framing,
}

impl Read for Body {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match &mut self.framing {
            Framing::Close => self.reader.read(buf),
            Framing::Length(left) => {
                if *left == 0 {
                    return Ok(0);
                }
                let cap = buf.len().min(*left as usize);
                let n = self.reader.read(&mut buf[..cap])?;
                *left -= n as u64;
                Ok(n)
            }
            Framing::Chunked { left, done } => {
                if *done {
                    return Ok(0);
                }
                if *left == 0 {
                    let size = read_chunk_size(&mut self.reader)?;
                    if size == 0 {
                        // Trailers, then the blank line that ends the body.
                        loop {
                            let mut line = String::new();
                            if self.reader.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
                                break;
                            }
                        }
                        *done = true;
                        return Ok(0);
                    }
                    *left = size;
                }
                let cap = buf.len().min(*left as usize);
                let n = self.reader.read(&mut buf[..cap])?;
                if n == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                *left -= n as u64;
                if *left == 0 {
                    let mut crlf = String::new();
                    self.reader.read_line(&mut crlf)?;
                }
                Ok(n)
            }
        }
    }
}

fn read_chunk_size(reader: &mut impl BufRead) -> io::Result<u64> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let hex = line.trim().split(';').next().unwrap_or("").trim();
    u64::from_str_radix(hex, 16).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))
}

fn transport(e: io::Error) -> Error {
    Error::Transport(e.to_string())
}

fn open(target: &Target, path: &str, token: Option<&str>, shared: &Shared) -> Result<Body> {
    let addrs = (target.host.trim_start_matches('[').trim_end_matches(']'), target.port)
        .to_socket_addrs()
        .map_err(transport)?;
    let mut last = None;
    let mut socket = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                socket = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let mut socket = socket.ok_or_else(|| transport(last.unwrap_or_else(|| io::ErrorKind::NotFound.into())))?;
    socket.set_read_timeout(Some(READ_TIMEOUT)).map_err(transport)?;
    socket.set_write_timeout(Some(CONNECT_TIMEOUT)).map_err(transport)?;
    socket.set_nodelay(true).map_err(transport)?;

    *shared.socket.lock().unwrap_or_else(|e| e.into_inner()) = Some(socket.try_clone().map_err(transport)?);
    if shared.stopped() {
        let _ = socket.shutdown(Shutdown::Both);
        return Err(Error::Transport("stopped".into()));
    }

    let mut request = format!(
        "GET {}{path} HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\n",
        target.prefix, target.host, target.port
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    socket.write_all(request.as_bytes()).map_err(transport)?;

    let mut reader = BufReader::new(socket);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).map_err(transport)?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::Transport(format!("not an HTTP response: {:?}", status_line.trim())))?;

    let mut chunked = false;
    let mut length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(transport)?;
        header_bytes += n;
        if n == 0 || header_bytes > MAX_HEADER_BYTES {
            return Err(Error::Transport("response headers ended early".into()));
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            if name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            } else if name.eq_ignore_ascii_case("content-length") {
                length = value.parse::<u64>().ok();
            }
        }
    }
    let framing = match (chunked, length) {
        (true, _) => Framing::Chunked { left: 0, done: false },
        (false, Some(n)) => Framing::Length(n),
        (false, None) => Framing::Close,
    };
    let mut body = Body { reader, framing };
    if !(200..300).contains(&status) {
        let mut text = String::new();
        let _ = (&mut body).take(MAX_ERROR_BODY).read_to_string(&mut text);
        return Err(Error::from_response(status, text));
    }
    Ok(body)
}

pub(crate) enum Flow {
    Continue,
    Stop,
}

/// One kind of event stream: `spawn` reconnects, backs off, and stops on a final refusal; the
/// consumer names the path (again on each reconnect) and turns frames into updates.
pub(crate) trait Consumer: Send + 'static {
    fn path(&self) -> String;
    fn opened(&mut self, reconnect: bool);
    fn frame(&mut self, frame: Frame) -> Flow;
    fn ended(&mut self, error: Error);
}

/// Whether retrying the same request cannot help.
fn is_final(error: &Error) -> bool {
    matches!(error, Error::Url(_)) || matches!(error.status(), Some(401 | 403 | 404))
}

fn backoff_ms(failures: u32) -> u64 {
    (1_000u64 << failures.min(3)).min(MAX_BACKOFF_MS)
}

pub(crate) fn spawn(client: &Client, mut consumer: impl Consumer, name: &str) -> Result<StreamHandle> {
    let target = target(client.base_url())?;
    let token = client.token();
    let shared = Arc::new(Shared { stopped: Mutex::new(false), wake: Condvar::new(), socket: Mutex::new(None) });
    let inner = shared.clone();
    let thread = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let mut opened = false;
            // Grows on connections that fail or carry nothing, so a server
            // that accepts and closes at once is not hammered.
            let mut failures = 0u32;
            while !inner.stopped() {
                match open(&target, &consumer.path(), token.as_deref(), &inner) {
                    Ok(mut body) => {
                        if inner.stopped() {
                            return;
                        }
                        consumer.opened(opened);
                        opened = true;
                        let mut parser = SseParser::new();
                        let mut buf = [0u8; 16 * 1024];
                        let mut carried = false;
                        loop {
                            match body.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    carried = true;
                                    failures = 0;
                                    for frame in parser.push(&buf[..n]) {
                                        if inner.stopped() {
                                            return;
                                        }
                                        if let Flow::Stop = consumer.frame(frame) {
                                            return;
                                        }
                                    }
                                }
                                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                                Err(_) => break,
                            }
                        }
                        if !carried {
                            failures += 1;
                        }
                    }
                    Err(e) => {
                        if inner.stopped() {
                            return;
                        }
                        if is_final(&e) {
                            consumer.ended(e);
                            return;
                        }
                        failures += 1;
                    }
                }
                *inner.socket.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if inner.sleep(backoff_ms(failures.saturating_sub(1))) {
                    return;
                }
            }
        })
        .map_err(|e| Error::Transport(format!("could not start the stream thread: {e}")))?;
    Ok(StreamHandle { shared, thread: Some(thread) })
}

struct BoardConsumer {
    path: String,
    on_update: Box<dyn FnMut(BoardUpdate) + Send>,
}

impl Consumer for BoardConsumer {
    fn path(&self) -> String {
        self.path.clone()
    }

    fn opened(&mut self, reconnect: bool) {
        if reconnect {
            (self.on_update)(BoardUpdate::Reconnected);
        }
    }

    fn frame(&mut self, frame: Frame) -> Flow {
        if frame.event == "board_event"
            && let Ok(value) = serde_json::from_str::<Value>(&frame.data)
        {
            (self.on_update)(BoardUpdate::Event(BoardEvent::from_value(value)));
        }
        Flow::Continue
    }

    fn ended(&mut self, error: Error) {
        (self.on_update)(BoardUpdate::Ended(error));
    }
}

pub(crate) fn board(client: &Client, project_id: &str, on_update: Box<dyn FnMut(BoardUpdate) + Send>) -> Result<StreamHandle> {
    let consumer = BoardConsumer { path: format!("/api/board/{}/events", encode(project_id)), on_update };
    spawn(client, consumer, "bento-board-stream")
}

struct RunConsumer {
    run_id: String,
    last_seq: u64,
    on_update: Box<dyn FnMut(RunUpdate) + Send>,
}

#[derive(Deserialize)]
struct TurnFrame {
    state: TurnState,
}

#[derive(Deserialize)]
struct DoneFrame {
    status: RunStatus,
}

impl RunConsumer {
    fn handle(&mut self, frame: Frame) -> Option<(RunUpdate, Flow)> {
        let update = match frame.event.as_str() {
            "run_event" => {
                let seq = frame.id.as_deref().and_then(|id| id.parse::<u64>().ok()).unwrap_or(0);
                if seq > 0 {
                    if seq <= self.last_seq {
                        return None;
                    }
                    self.last_seq = seq;
                }
                let value: Value = serde_json::from_str(&frame.data).ok()?;
                let recorded_at = value.get("recordedAt").and_then(Value::as_str).map(str::to_owned);
                RunUpdate::Event { seq, event: AgentEvent::from_value(value), recorded_at }
            }
            "run_delta" => RunUpdate::Delta(serde_json::from_str(&frame.data).ok()?),
            "run_turn" => RunUpdate::Turn(serde_json::from_str::<TurnFrame>(&frame.data).ok()?.state),
            "done" => {
                let status = serde_json::from_str::<DoneFrame>(&frame.data).map(|d| d.status).unwrap_or(RunStatus::Unknown);
                return Some((RunUpdate::Done { status }, Flow::Stop));
            }
            _ => return None,
        };
        Some((update, Flow::Continue))
    }
}

impl Consumer for RunConsumer {
    fn path(&self) -> String {
        format!("/api/runs/{}/events?since={}", encode(&self.run_id), self.last_seq)
    }

    fn opened(&mut self, reconnect: bool) {
        if reconnect {
            (self.on_update)(RunUpdate::Reconnected);
        }
    }

    fn frame(&mut self, frame: Frame) -> Flow {
        match self.handle(frame) {
            Some((update, flow)) => {
                (self.on_update)(update);
                flow
            }
            None => Flow::Continue,
        }
    }

    fn ended(&mut self, error: Error) {
        (self.on_update)(RunUpdate::Ended(error));
    }
}

pub(crate) fn run(client: &Client, run_id: &str, since: u64, on_update: Box<dyn FnMut(RunUpdate) + Send>) -> Result<StreamHandle> {
    let consumer = RunConsumer { run_id: run_id.to_owned(), last_seq: since, on_update };
    spawn(client, consumer, "bento-run-stream")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn frame(event: &str, data: &str, id: Option<&str>) -> Frame {
        Frame { event: event.into(), data: data.into(), id: id.map(Into::into) }
    }

    #[test]
    fn targets_parse() {
        let t = target("http://127.0.0.1:4400").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.prefix.as_str()), ("127.0.0.1", 4400, ""));
        let t = target("http://localhost/bento/").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.prefix.as_str()), ("localhost", 80, "/bento"));
        let t = target("http://[::1]:4400").unwrap();
        assert_eq!((t.host.as_str(), t.port), ("[::1]", 4400));
        assert!(matches!(target("https://bento.example"), Err(Error::Url(_))));
        assert!(matches!(target("http://host:notaport"), Err(Error::Url(_))));
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!([0, 1, 2, 3, 9].map(backoff_ms), [1_000, 2_000, 4_000, 8_000, 8_000]);
    }

    #[test]
    fn run_frames_are_typed_and_replays_dropped() {
        let (tx, rx) = mpsc::channel();
        let mut c = RunConsumer {
            run_id: "r".into(),
            last_seq: 1,
            on_update: Box::new(move |u| tx.send(u).unwrap()),
        };
        // Frames as the server wrote them for a real run (see the sample in types tests).
        let event = r#"{"role":"system","text":"No ANTHROPIC_API_KEY is configured.","type":"message","recordedAt":"2026-11-27T06:24:08.265Z"}"#;
        assert!(matches!(c.frame(frame("run_event", event, Some("1"))), Flow::Continue));
        c.frame(frame("run_event", event, Some("3")));
        c.frame(frame("run_delta", r#"{"channel":"text","text":"Hel","offset":0}"#, None));
        c.frame(frame("run_turn", r#"{"state":"waiting"}"#, None));
        c.frame(frame("keepalive", "", None));
        c.frame(frame("run_event", r#"{"type":"brand_new","x":1}"#, Some("4")));
        assert!(matches!(c.frame(frame("done", r#"{"status":"failed"}"#, None)), Flow::Stop));
        assert_eq!(c.path(), "/api/runs/r/events?since=4");
        drop(c);
        let got: Vec<RunUpdate> = rx.iter().collect();
        assert_eq!(got.len(), 5, "{got:?}");
        match &got[0] {
            RunUpdate::Event { seq: 3, event: AgentEvent::Message { text, .. }, recorded_at: Some(at) } => {
                assert!(text.starts_with("No ANTHROPIC_API_KEY"));
                assert_eq!(at, "2026-11-27T06:24:08.265Z");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&got[1], RunUpdate::Delta(d) if d.text == "Hel"));
        assert!(matches!(&got[2], RunUpdate::Turn(TurnState::Waiting)));
        assert!(matches!(&got[3], RunUpdate::Event { seq: 4, event: AgentEvent::Unknown(_), .. }));
        assert!(matches!(&got[4], RunUpdate::Done { status: RunStatus::Failed }));
    }

    #[test]
    fn board_frames_ignore_other_events_and_bad_json() {
        let (tx, rx) = mpsc::channel();
        let mut c = BoardConsumer { path: String::new(), on_update: Box::new(move |u| tx.send(u).unwrap()) };
        c.frame(frame("keepalive", "", None));
        c.frame(frame("board_event", "{not json", None));
        c.frame(frame("board_event", r#"{"type":"stage_updated","projectId":"p","stageId":"s"}"#, None));
        drop(c);
        let got: Vec<BoardUpdate> = rx.iter().collect();
        assert_eq!(got.len(), 1);
        assert!(matches!(&got[0], BoardUpdate::Event(BoardEvent::StageUpdated { stage_id, .. }) if stage_id == "s"));
    }

    /// Byte level framing over a loopback socket: chunked bodies split at
    /// awkward places, and a chunk extension.
    #[test]
    fn chunked_body_decodes() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.write_all(b"5;ext=1\r\nhello\r\n7\r\n, world\r\n0\r\nx-trailer: 1\r\n\r\n").unwrap();
        });
        let client = TcpStream::connect(addr).unwrap();
        let mut body = Body { reader: BufReader::with_capacity(3, client), framing: Framing::Chunked { left: 0, done: false } };
        let mut out = String::new();
        body.read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello, world");
        server.join().unwrap();
    }
}
