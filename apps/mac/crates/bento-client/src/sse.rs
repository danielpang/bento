//! Incremental parser for the server-sent events wire format.
//!
//! Follows the WHATWG event stream rules: lines end in CRLF, LF, or a lone
//! CR (including one split across two reads); lines starting with `:` are
//! comments; one leading space after the colon is stripped; several `data:`
//! lines join with `\n`; a frame whose data is empty is not dispatched.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// The `event:` field, or "message" when the frame named none.
    pub event: String,
    pub data: String,
    /// The `id:` field when this frame carried one.
    pub id: Option<String>,
}

#[derive(Debug, Default)]
pub struct SseParser {
    line: Vec<u8>,
    after_cr: bool,
    started: bool,
    event: Option<String>,
    data: String,
    has_data: bool,
    id: Option<String>,
    last_event_id: String,
    retry_ms: Option<u64>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The last `id:` seen on the stream, which persists across frames.
    pub fn last_event_id(&self) -> &str {
        &self.last_event_id
    }

    /// The last valid `retry:` the server sent, in milliseconds.
    pub fn retry_ms(&self) -> Option<u64> {
        self.retry_ms
    }

    /// Feeds raw bytes from the socket; returns the frames they completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        for &b in bytes {
            match b {
                b'\n' if self.after_cr => self.after_cr = false,
                b'\n' => self.end_line(&mut frames),
                b'\r' => {
                    self.end_line(&mut frames);
                    self.after_cr = true;
                }
                _ => {
                    self.after_cr = false;
                    self.line.push(b);
                }
            }
        }
        frames
    }

    fn end_line(&mut self, frames: &mut Vec<Frame>) {
        let raw = std::mem::take(&mut self.line);
        let mut line = String::from_utf8_lossy(&raw).into_owned();
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix('\u{feff}') {
                line = rest.to_owned();
            }
        }
        if line.is_empty() {
            self.dispatch(frames);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line.as_str(), ""),
        };
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "id" if !value.contains('\0') => {
                self.id = Some(value.to_owned());
                self.last_event_id = value.to_owned();
            }
            "retry" if !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()) => {
                self.retry_ms = value.parse().ok();
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, frames: &mut Vec<Frame>) {
        let event = self.event.take();
        let id = self.id.take();
        let data = std::mem::take(&mut self.data);
        let had_data = std::mem::take(&mut self.has_data);
        if !had_data || data.is_empty() {
            return;
        }
        frames.push(Frame {
            event: event.filter(|e| !e.is_empty()).unwrap_or_else(|| "message".to_owned()),
            data,
            id,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(input: &[&[u8]]) -> Vec<Frame> {
        let mut p = SseParser::new();
        input.iter().flat_map(|c| p.push(c)).collect()
    }

    fn frame(event: &str, data: &str, id: Option<&str>) -> Frame {
        Frame { event: event.into(), data: data.into(), id: id.map(Into::into) }
    }

    #[test]
    fn frames_parse_across_arbitrary_chunk_boundaries() {
        let frames = all(&[b"event: run_delta\ndata: {\"a\"", b":1}\n\nevent: done\nid: 4\ndata: ok\n\n"]);
        assert_eq!(frames, vec![frame("run_delta", r#"{"a":1}"#, None), frame("done", "ok", Some("4"))]);
    }

    #[test]
    fn byte_at_a_time_matches_whole() {
        let input = b"event: board_event\r\ndata: {\"x\":1}\r\n\r\n: hb\r\n\r\ndata: two\r\n\r\n";
        let whole = all(&[input]);
        let pieces: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(all(&pieces), whole);
        assert_eq!(whole, vec![frame("board_event", r#"{"x":1}"#, None), frame("message", "two", None)]);
    }

    #[test]
    fn multi_line_data_joins_with_newlines_and_keeps_its_spacing() {
        let frames = all(&[b"data: line one\ndata:  indented\ndata:last\n\n"]);
        assert_eq!(frames, vec![frame("message", "line one\n indented\nlast", None)]);
    }

    #[test]
    fn crlf_and_lone_cr_end_lines() {
        assert_eq!(all(&[b"event: a\r\ndata: 1\r\n\r\n"]), vec![frame("a", "1", None)]);
        assert_eq!(all(&[b"event: b\rdata: 2\r\r"]), vec![frame("b", "2", None)]);
        // CR at the end of one read and LF at the start of the next is one line end.
        assert_eq!(all(&[b"data: 3\r", b"\n\r", b"\n"]), vec![frame("message", "3", None)]);
    }

    #[test]
    fn comments_and_heartbeats_dispatch_nothing() {
        // The server's keepalive is `event: keepalive` with empty data.
        assert_eq!(all(&[b": ping\n\n", b"event: keepalive\ndata: \n\n"]), vec![]);
        assert_eq!(all(&[b": just a comment\ndata: kept\n\n"]), vec![frame("message", "kept", None)]);
        assert_eq!(all(&[b"event: x\n\n"]), vec![]);
    }

    #[test]
    fn event_name_and_id_reset_between_frames_but_last_id_persists() {
        let mut p = SseParser::new();
        let frames = p.push(b"event: run_event\nid: 7\ndata: {}\n\ndata: after\n\n");
        assert_eq!(frames, vec![frame("run_event", "{}", Some("7")), frame("message", "after", None)]);
        assert_eq!(p.last_event_id(), "7");
    }

    #[test]
    fn data_before_id_as_the_server_writes_it() {
        // Hono's writeSSE order: event, data, id.
        let frames = all(&[b"event: run_event\ndata: {\"type\":\"init\"}\nid: 1\n\n"]);
        assert_eq!(frames, vec![frame("run_event", r#"{"type":"init"}"#, Some("1"))]);
    }

    #[test]
    fn field_without_colon_and_unknown_fields() {
        let frames = all(&[b"data\nfoo: bar\ndata: x\n\n"]);
        assert_eq!(frames, vec![frame("message", "\nx", None)]);
    }

    #[test]
    fn retry_and_bom() {
        let mut p = SseParser::new();
        let frames = p.push("\u{feff}retry: 1500\ndata: hi\n\nretry: soon\n".as_bytes());
        assert_eq!(frames, vec![frame("message", "hi", None)]);
        assert_eq!(p.retry_ms(), Some(1500));
    }

    #[test]
    fn partial_frame_stays_buffered() {
        let mut p = SseParser::new();
        assert!(p.push(b"event: run_event\ndata: {}\n").is_empty());
        assert_eq!(p.push(b"\n").len(), 1);
    }

    #[test]
    fn utf8_split_across_reads() {
        let text = "data: caf\u{e9} \u{65e5}\u{672c}\n\n".as_bytes();
        let (a, b) = text.split_at(10);
        assert_eq!(all(&[a, b]), vec![frame("message", "caf\u{e9} \u{65e5}\u{672c}", None)]);
    }
}
