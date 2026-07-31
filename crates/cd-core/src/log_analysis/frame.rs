//! Bounded logical-record framing over physical newlines (#788).
//!
//! Physical newlines are not always record boundaries: PostgreSQL DETAIL/HINT
//! lines, CSV quoted fields, stack traces, CRI partial tags, and pretty-printed
//! JSON must stay one logical event. A timestamped line always starts a new
//! record (false-continuation protection). Absolute line-byte limits remain
//! enforced by the caller (`MAX_RAW_LOG_LINE_BYTES`).

/// Streaming framer: push physical lines, pull completed logical records.
#[derive(Debug, Default)]
pub struct LogicalRecordFramer {
    pending: String,
    /// Unclosed double-quote in a CSV-shaped record.
    csv_open_quote: bool,
    /// CRI stream tagged the previous physical line as partial (`P`).
    cri_partial_open: bool,
    /// Pretty-printed / multi-line JSON brace depth (0 = not in JSON accumulate).
    json_depth: i32,
    json_in_string: bool,
    json_escape: bool,
}

impl LogicalRecordFramer {
    /// Create an empty framer with no pending physical lines.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one physical line (without trailing `\n`; `\r` is stripped).
    /// Returns a completed logical record when the line terminates one.
    pub fn push_line(&mut self, physical: &str) -> Option<String> {
        let line = physical.strip_suffix('\r').unwrap_or(physical);

        if self.csv_open_quote {
            self.append_line(line);
            self.csv_open_quote = csv_quote_open(&self.pending);
            if !self.csv_open_quote {
                return self.take_pending();
            }
            return None;
        }

        if self.cri_partial_open {
            // CRI partials join until a terminating `F` tag on the same stream.
            self.append_line(line);
            if cri_is_full(line) {
                self.cri_partial_open = false;
                return self.take_pending();
            }
            // Another `P` keeps the partial open; unrelated lines still attach
            // until `F` (kubelet emits contiguous P…P F runs).
            return None;
        }

        if self.json_depth > 0 {
            self.append_line(line);
            self.feed_json_line(line);
            if self.json_depth == 0 {
                return self.take_pending();
            }
            return None;
        }

        if self.pending.is_empty() {
            self.start_new(line);
            return self.maybe_complete_singleton();
        }

        if is_continuation_of(&self.pending, line) {
            self.append_line(line);
            // CRI partial may open mid-stream only as a new record start.
            return None;
        }

        // New record starts: emit previous, begin this line.
        let finished = self.take_pending();
        self.start_new(line);
        // If the new line is itself a complete singleton, leave it pending for
        // the next push or finish() so callers see stable one-at-a-time emits
        // except when the previous record closed.
        finished
    }

    /// Flush any remaining buffered logical record at EOF.
    pub fn finish(&mut self) -> Option<String> {
        self.csv_open_quote = false;
        self.cri_partial_open = false;
        self.json_depth = 0;
        self.json_in_string = false;
        self.json_escape = false;
        self.take_pending()
    }

    fn start_new(&mut self, line: &str) {
        self.pending.clear();
        self.pending.push_str(line);
        self.csv_open_quote = looks_like_csv_record(line) && csv_quote_open(line);
        self.cri_partial_open = cri_is_partial(line);
        self.json_depth = 0;
        self.json_in_string = false;
        self.json_escape = false;
        if looks_like_multiline_json_start(line) {
            self.feed_json_line(line);
        }
    }

    fn maybe_complete_singleton(&mut self) -> Option<String> {
        if self.csv_open_quote || self.cri_partial_open || self.json_depth > 0 {
            return None;
        }
        // Keep singleton pending until the next record arrives or finish(),
        // so multi-line continuations can still attach.
        None
    }

    fn append_line(&mut self, line: &str) {
        if !self.pending.is_empty() {
            self.pending.push('\n');
        }
        self.pending.push_str(line);
    }

    fn take_pending(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }

    fn feed_json_line(&mut self, line: &str) {
        for ch in line.chars() {
            if self.json_escape {
                self.json_escape = false;
                continue;
            }
            if self.json_in_string {
                if ch == '\\' {
                    self.json_escape = true;
                } else if ch == '"' {
                    self.json_in_string = false;
                }
                continue;
            }
            match ch {
                '"' => self.json_in_string = true,
                '{' => self.json_depth += 1,
                '}' => {
                    if self.json_depth > 0 {
                        self.json_depth -= 1;
                    }
                }
                _ => {}
            }
        }
    }
}

fn looks_like_multiline_json_start(line: &str) -> bool {
    // Only intentional pretty-print openers — not truncated single-line JSON
    // like `{"ts":"...","message":"truncated"`.
    let t = line.trim();
    t == "{" || (t.starts_with('{') && t.chars().skip(1).all(char::is_whitespace))
}

/// Whether `line` continues the logical record begun by `pending`.
fn is_continuation_of(pending: &str, line: &str) -> bool {
    let trimmed = line.trim_start();

    // PostgreSQL re-stamps DETAIL/HINT/STATEMENT with the same timestamp prefix;
    // those must merge even though they look like new record headers (#788).
    if is_pg_continuation_tag(trimmed) && pending_looks_like_pg_stderr(pending) {
        return true;
    }

    // Timestamped lines otherwise always start a new record (false-continuation).
    if line_has_leading_timestamp(line) {
        return false;
    }

    if trimmed.is_empty() {
        // Blank lines inside Python chained tracebacks stay in-record.
        return pending_looks_like_stack(pending) || pending_looks_like_pg_stderr(pending);
    }

    // Stack / exception frames only attach when the open record already looks
    // like a stack/exception. A lone `panic:` line must not glue to a prior
    // unrelated "worker starting" header (go-panic fixture).
    if pending_looks_like_stack(pending) {
        return true;
    }

    false
}

fn line_has_leading_timestamp(line: &str) -> bool {
    let t = line.trim_start();
    // ISO / RFC3339 / common app-server stamps at the start of a line.
    if t.len() >= 19
        && t.as_bytes().get(4) == Some(&b'-')
        && t.as_bytes().get(7) == Some(&b'-')
        && t.as_bytes()
            .get(..4)
            .is_some_and(|b| b.iter().all(u8::is_ascii_digit))
    {
        return true;
    }
    // Go log: 2025/06/15 ...
    if t.len() >= 10
        && t.as_bytes().get(4) == Some(&b'/')
        && t.as_bytes().get(7) == Some(&b'/')
        && t.as_bytes()
            .get(..4)
            .is_some_and(|b| b.iter().all(u8::is_ascii_digit))
    {
        return true;
    }
    // CRI: 2025-06-15T16:10:00.000000000Z stdout F ...
    if cri_line(t).is_some() {
        return true;
    }
    false
}

fn is_pg_continuation_tag(trimmed: &str) -> bool {
    // Full form: `2025-... [pid] DETAIL: ...` is a leading timestamp (new record
    // candidate) — PG actually re-stamps DETAIL lines with the same timestamp.
    // Those still share the primary ERROR and must merge (#788).
    if let Some(rest) = strip_pg_prefix(trimmed) {
        return matches_pg_secondary(rest);
    }
    matches_pg_secondary(trimmed)
}

fn strip_pg_prefix(line: &str) -> Option<&str> {
    // `YYYY-MM-DD HH:MM:SS.mmm TZ [pid] REST`
    let bytes = line.as_bytes();
    if bytes.len() < 30 || bytes.get(4) != Some(&b'-') {
        return None;
    }
    let bracket = line.find('[')?;
    let after_pid = line.get(bracket..)?.find(']')?;
    let rest = line.get(bracket + after_pid + 1..)?.trim_start();
    Some(rest)
}

fn matches_pg_secondary(rest: &str) -> bool {
    let u = rest.to_ascii_uppercase();
    u.starts_with("DETAIL:")
        || u.starts_with("HINT:")
        || u.starts_with("STATEMENT:")
        || u.starts_with("CONTEXT:")
        || u.starts_with("QUERY:")
        || u.starts_with("LOCATION:")
}

fn pending_looks_like_pg_stderr(pending: &str) -> bool {
    let last = pending.lines().next_back().unwrap_or(pending);
    strip_pg_prefix(last).is_some_and(|rest| {
        let u = rest.to_ascii_uppercase();
        u.starts_with("ERROR:")
            || u.starts_with("FATAL:")
            || u.starts_with("PANIC:")
            || u.starts_with("WARNING:")
            || u.starts_with("LOG:")
            || u.starts_with("INFO:")
            || u.starts_with("NOTICE:")
            || u.starts_with("DEBUG")
            || matches_pg_secondary(rest)
    })
}

#[allow(dead_code)]
fn is_stack_continuation(trimmed: &str) -> bool {
    let t = trimmed;
    t.starts_with("at ")
        || t.starts_with("at\t")
        || t.starts_with("Caused by:")
        || t.starts_with("Suppressed:")
        || t.starts_with("... ")
        || t.starts_with("Traceback ")
        || t.starts_with("File \"")
        || t.starts_with("During handling of the above exception")
        || t.starts_with("The above exception was the direct cause")
        || t.starts_with("stack backtrace:")
        || t.starts_with("stack backtrace")
        || t.starts_with("thread '")
        || t.starts_with("note:")
        || t.starts_with("goroutine ")
        || t.starts_with("[signal ")
        || t.starts_with("panic:")
        || t.starts_with("exit status ")
        || t.starts_with("--->")
        || t.starts_with("--- End of")
        || t.starts_with("--- End of inner exception")
        || t.starts_with("called `")
        || t.contains("Exception:")
        || t.starts_with("java.")
        || t.starts_with("kotlin")
        || t.starts_with("System.")
        || t.starts_with("Microsoft.")
        || t.starts_with("kotlinx.")
}

#[allow(dead_code)]
fn looks_like_exception_type_line(trimmed: &str) -> bool {
    // `ConnectionError: connection refused`, `RuntimeError: rollback failed`
    if let Some((head, _)) = trimmed.split_once(':') {
        let h = head.trim();
        if h.is_empty() || h.contains(' ') {
            return false;
        }
        return h.ends_with("Error")
            || h.ends_with("Exception")
            || h.ends_with("Panic")
            || h.contains('.');
    }
    false
}

fn pending_looks_like_stack(pending: &str) -> bool {
    pending.lines().any(|l| {
        let t = l.trim_start();
        t.contains("Exception")
            || t.contains("Error:")
            || t.starts_with("Traceback")
            || t.starts_with("panic:")
            || t.starts_with("thread '")
            || t.starts_with("stack backtrace")
            || t.contains("panicked at")
            || t.contains(" ERROR ")
            || t.contains(" [ERR] ")
            || t.contains(" ERROR:")
    })
}

fn looks_like_csv_record(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('"') && t.matches(',').count() >= 3
}

/// True when the CSV record still has an open double-quote (RFC-style `""` escapes).
fn csv_quote_open(text: &str) -> bool {
    let mut open = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if open && chars.peek() == Some(&'"') {
                chars.next(); // escaped quote
            } else {
                open = !open;
            }
        }
    }
    open
}

fn cri_line(line: &str) -> Option<(&str, &str, &str)> {
    // timestamp stream F|P payload
    let mut parts = line.splitn(4, char::is_whitespace);
    let ts = parts.next()?;
    let stream = parts.next()?;
    let tag = parts.next()?;
    let _payload = parts.next().unwrap_or("");
    if !ts.contains('T') || (stream != "stdout" && stream != "stderr") {
        return None;
    }
    if tag != "F" && tag != "P" {
        return None;
    }
    Some((ts, stream, tag))
}

fn cri_is_partial(line: &str) -> bool {
    cri_line(line.trim_start()).is_some_and(|(_, _, tag)| tag == "P")
}

fn cri_is_full(line: &str) -> bool {
    cri_line(line.trim_start()).is_some_and(|(_, _, tag)| tag == "F")
}

/// Frame an entire text blob into logical records (tests / small fixtures).
pub fn frame_text(text: &str) -> Vec<String> {
    let mut framer = LogicalRecordFramer::new();
    let mut out = Vec::new();
    for line in text.split_inclusive('\n') {
        let physical = line.strip_suffix('\n').unwrap_or(line);
        if let Some(rec) = framer.push_line(physical) {
            out.push(rec);
        }
    }
    if let Some(rec) = framer.finish() {
        out.push(rec);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_stderr_detail_hint_statement_merge() {
        let text = "\
2025-06-15 12:00:00.123 UTC [1042] LOG:  database system is ready to accept connections
2025-06-15 12:00:01.500 UTC [1103] ERROR:  duplicate key value violates unique constraint \"orders_pkey\"
2025-06-15 12:00:01.500 UTC [1103] DETAIL:  Key (id)=(42) already exists.
2025-06-15 12:00:01.500 UTC [1103] HINT:  Retry with a fresh identifier.
2025-06-15 12:00:01.500 UTC [1103] STATEMENT:  INSERT INTO orders (id, label) VALUES (42, 'demo');
2025-06-15 12:00:02.001 UTC [1042] LOG:  checkpoint starting: time
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 3, "{recs:?}");
        assert!(recs[1].contains("DETAIL:"));
        assert!(recs[1].contains("STATEMENT:"));
    }

    #[test]
    fn false_continuation_with_timestamp_not_merged() {
        let text = "\
2025-06-15 13:30:00,000 INFO  [com.example.svc.Audit] (main) audit begin
2025-06-15 13:30:01,000 INFO  [com.example.svc.Audit] (main) user note: Caused by: operator request
        2025-06-15 13:30:02,000 WARN  [com.example.svc.Audit] (main) indented but timestamped record
2025-06-15 13:30:03,000 INFO  [com.example.svc.Audit] (main) audit end
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 4, "{recs:?}");
    }

    #[test]
    fn java_stack_is_one_record() {
        let text = "\
2025-06-15 13:00:00,100 ERROR [com.example.svc.OrderService] (worker-1) Order submission failed
java.sql.SQLException: connection refused
at com.example.svc.OrderService.handle(OrderService.java:42)
Caused by: java.net.ConnectException: Connection refused
... 14 more
2025-06-15 13:00:01,200 INFO  [com.example.svc.OrderService] (worker-1) Retry scheduled
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 2, "{recs:?}");
        assert!(recs[0].contains("Caused by:"));
    }

    #[test]
    fn csv_quoted_newline_stays_one_record() {
        let text = "\
\"2025-06-15 12:10:00.100 UTC\",\"app_user\",\"LOG\",\"ok\"
\"2025-06-15 12:10:05.250 UTC\",\"app_user\",\"ERROR\",\"dup\",\"INSERT INTO orders (id, label)
VALUES (42, 'demo')
RETURNING id\"
\"2025-06-15 12:10:09.900 UTC\",\"app_user\",\"WARNING\",\"no txn\"
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 3, "{recs:?}");
        assert!(recs[1].contains("VALUES (42"));
    }

    #[test]
    fn cri_partial_joins() {
        let text = "\
2025-06-15T16:10:00.000000000Z stdout F {\"level\":\"error\",\"msg\":\"cri full record\"}
2025-06-15T16:10:01.000000000Z stdout P {\"level\":\"warn\",\"msg\":\"cri split 
2025-06-15T16:10:01.000000000Z stdout F record\"}
2025-06-15T16:10:02.000000000Z stderr F plain cri payload
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 3, "{recs:?}");
        assert!(recs[1].contains("cri split"));
        assert!(recs[1].contains("record\"}"));
    }

    #[test]
    fn pretty_json_is_one_record() {
        let text = r#"{"ts":"2025-06-15T14:40:00Z","level":"error","message":"line one\nline two"}
{
  "ts": "2025-06-15T14:40:01Z",
  "level": "info",
  "message": "pretty printed object"
}
{"ts":"2025-06-15T14:40:02Z","level":"info","message":"back to one line"}
"#;
        let recs = frame_text(text);
        assert_eq!(recs.len(), 3, "{recs:?}");
        assert!(recs[1].contains("pretty printed object"));
    }

    #[test]
    fn framing_bleed_mutation_does_not_steal_next_header() {
        // Adversarial: stack-like text that is actually a new timestamped event.
        let text = "\
2025-06-15 13:00:00,100 ERROR boom
at com.example.A.main
2025-06-15 13:00:01,000 INFO next
";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 2);
        assert!(recs[1].starts_with("2025-06-15 13:00:01"));
    }

    #[test]
    fn overflow_physical_lines_still_flush_at_finish() {
        let mut f = LogicalRecordFramer::new();
        assert!(f.push_line("2025-06-15 13:00:00,100 ERROR boom").is_none());
        assert!(f.push_line("at com.example.A.main").is_none());
        let last = f.finish().expect("flush");
        assert!(last.contains("ERROR boom"));
        assert!(last.contains("at com.example.A.main"));
    }

    #[test]
    fn malformed_csv_unbalanced_quote_flushes_at_eof() {
        // Four fields so looks_like_csv_record accepts the opener; quote stays open.
        let text = "\"a\",\"b\",\"c\",\"open\n still open";
        let recs = frame_text(text);
        assert_eq!(recs.len(), 1, "{recs:?}");
        assert!(recs[0].contains("still open"));
    }
}
