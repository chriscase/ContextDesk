//! Format detection + line parse (#355). LOG_ANALYSIS.md §3.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Detected log line format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogFormat {
    /// JSON object per line.
    Json,
    /// key=value pairs (logfmt).
    Logfmt,
    /// Classic syslog / RFC5424-ish.
    Syslog,
    /// Plain text (fallback).
    Plain,
}

/// One parsed log record (never drops data — unknown → whole line as message).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedLine {
    /// Unix seconds when known; else ingest-order synthetic.
    pub ts: Option<i64>,
    /// Normalized level: debug/info/warn/error/fatal/unknown.
    pub level: String,
    /// Optional service / app name.
    pub service: Option<String>,
    /// Optional host.
    pub host: Option<String>,
    /// Optional trace / request id.
    pub trace_id: Option<String>,
    /// Human message body (best-effort).
    pub message: String,
    /// Original raw line.
    pub raw: String,
    /// Format that produced this parse.
    pub format: LogFormat,
}

/// Detect format from a sample line (and optionally filename hint).
pub fn detect_format(sample: &str, path: Option<&Path>) -> LogFormat {
    let t = sample.trim();
    if t.starts_with('{')
        && t.ends_with('}')
        && serde_json::from_str::<serde_json::Value>(t).is_ok()
    {
        return LogFormat::Json;
    }
    if looks_like_logfmt(t) {
        return LogFormat::Logfmt;
    }
    if looks_like_syslog(t) {
        return LogFormat::Syslog;
    }
    if let Some(p) = path {
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name.ends_with(".json") || name.ends_with(".jsonl") || name.ends_with(".ndjson") {
            return LogFormat::Json;
        }
    }
    LogFormat::Plain
}

fn looks_like_logfmt(t: &str) -> bool {
    // At least two key=value tokens and no leading brace.
    if t.starts_with('{') {
        return false;
    }
    let pairs = t
        .split_whitespace()
        .filter(|tok| {
            if let Some((k, _)) = tok.split_once('=') {
                !k.is_empty()
                    && k.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            } else {
                false
            }
        })
        .count();
    pairs >= 2
}

fn looks_like_syslog(t: &str) -> bool {
    // "<pri>timestamp host ..." or "Mon DD HH:MM:SS host ..."
    if t.starts_with('<') && t.find('>').is_some_and(|i| i < 6) {
        return true;
    }
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    months.iter().any(|m| t.starts_with(m) && t.len() > 16)
}

/// Parse one line with a known (or auto-detected) format.
///
/// `ingest_seq` is used as synthetic timestamp when none is found.
pub fn parse_line(raw: &str, format: Option<LogFormat>, ingest_seq: u64) -> ParsedLine {
    let format = format.unwrap_or_else(|| detect_format(raw, None));
    match format {
        LogFormat::Json => parse_json(raw, ingest_seq),
        LogFormat::Logfmt => parse_logfmt(raw, ingest_seq),
        LogFormat::Syslog => parse_syslog(raw, ingest_seq),
        LogFormat::Plain => parse_plain(raw, ingest_seq),
    }
}

fn parse_json(raw: &str, ingest_seq: u64) -> ParsedLine {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return parse_plain(raw, ingest_seq);
    };
    let obj = v.as_object();
    let get_str = |keys: &[&str]| -> Option<String> {
        let o = obj?;
        for k in keys {
            if let Some(s) = o.get(*k).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
        None
    };
    let ts = obj
        .and_then(|o| {
            o.get("ts")
                .or_else(|| o.get("timestamp"))
                .or_else(|| o.get("time"))
                .or_else(|| o.get("@timestamp"))
        })
        .and_then(parse_ts_value);
    let level = get_str(&["level", "severity", "lvl"])
        .map(|s| normalize_level(&s))
        .unwrap_or_else(|| "unknown".into());
    let message = get_str(&["message", "msg", "log", "text"]).unwrap_or_else(|| raw.to_string());
    ParsedLine {
        ts: ts.or(Some(ingest_seq as i64)),
        level,
        service: get_str(&["service", "app", "component"]),
        host: get_str(&["host", "hostname", "node"]),
        trace_id: get_str(&["trace_id", "traceId", "request_id", "req_id", "span_id"]),
        message,
        raw: raw.to_string(),
        format: LogFormat::Json,
    }
}

fn parse_ts_value(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(normalize_epoch_number(n));
    }
    if let Some(f) = v.as_f64() {
        return Some(normalize_epoch_number(f as i64));
    }
    if let Some(s) = v.as_str() {
        return parse_explicit_timestamp(s);
    }
    None
}

/// Convert epoch seconds or milliseconds to Unix whole seconds.
fn normalize_epoch_number(n: i64) -> i64 {
    // Values past ~2286-11 in seconds are treated as milliseconds (existing heuristic).
    if n > 10_000_000_000 {
        n / 1000
    } else {
        n
    }
}

/// Parse an unambiguous timestamp to Unix **whole seconds**.
///
/// Accepts:
/// - integer epoch seconds or milliseconds (string or via callers for JSON numbers);
/// - RFC3339 / RFC5424 timestamps with explicit `Z` or numeric UTC offset
///   (optional fractional seconds).
///
/// Storage is whole-second only: fractional input is truncated via
/// [`chrono::DateTime::timestamp`] (subsecond precision is intentionally not
/// preserved). Offsetless local datetimes, yearless classic syslog, and
/// malformed values return `None` — never guess a timezone or year.
fn parse_explicit_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() || s == "-" {
        return None;
    }
    if let Ok(n) = s.parse::<i64>() {
        return Some(normalize_epoch_number(n));
    }
    // `parse_from_rfc3339` requires an explicit offset (`Z` or ±HH:MM). Offsetless
    // local faces such as `2025-01-01T13:20:00` fail here on purpose.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    None
}

fn parse_logfmt(raw: &str, ingest_seq: u64) -> ParsedLine {
    let mut map = std::collections::HashMap::new();
    for tok in split_logfmt_tokens(raw) {
        if let Some((k, v)) = tok.split_once('=') {
            let v = v
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(v)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
            map.insert(k.to_string(), v);
        }
    }
    let level = map
        .get("level")
        .or_else(|| map.get("lvl"))
        .map(|s| normalize_level(s))
        .unwrap_or_else(|| "unknown".into());
    let message = map
        .get("msg")
        .or_else(|| map.get("message"))
        .cloned()
        .unwrap_or_else(|| raw.to_string());
    // Explicit-offset RFC3339 and epoch integers become wall seconds; offsetless /
    // malformed values fall back to ingest order (never drop the record).
    let ts = map
        .get("ts")
        .or_else(|| map.get("time"))
        .and_then(|s| parse_explicit_timestamp(s))
        .or(Some(ingest_seq as i64));
    ParsedLine {
        ts,
        level,
        service: map.get("service").or_else(|| map.get("app")).cloned(),
        host: map.get("host").cloned(),
        trace_id: map
            .get("trace_id")
            .or_else(|| map.get("request_id"))
            .cloned(),
        message,
        raw: raw.to_string(),
        format: LogFormat::Logfmt,
    }
}

fn split_logfmt_tokens(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            token.push(ch);
            escaped = false;
        } else if quoted && ch == '\\' {
            token.push(ch);
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
            token.push(ch);
        } else if ch.is_whitespace() && !quoted {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
        } else {
            token.push(ch);
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

fn parse_syslog(raw: &str, ingest_seq: u64) -> ParsedLine {
    let mut rest = raw.trim();
    if rest.starts_with('<') {
        if let Some(i) = rest.find('>') {
            // pri tags are ASCII digits only
            rest = rest.get(i + 1..).unwrap_or(rest);
        }
    }
    rest = rest.trim_start();

    // RFC5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
    // Classic yearless syslog starts with a month name, not a numeric VERSION.
    if let Some(parsed) = parse_rfc5424_body(rest, ingest_seq, raw) {
        return parsed;
    }

    // Classic / yearless path: do not invent year or timezone; order-only via ingest_seq.
    let parts: Vec<&str> = rest.splitn(4, char::is_whitespace).collect();
    let (host, message) = if parts.len() >= 3 {
        (
            Some(parts[1].to_string()),
            parts[parts.len() - 1].to_string(),
        )
    } else {
        (None, rest.to_string())
    };
    let level = level_from_message_text(&message);
    ParsedLine {
        ts: Some(ingest_seq as i64),
        level,
        service: None,
        host,
        trace_id: None,
        message,
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    }
}

fn take_token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    match s.find(char::is_whitespace) {
        // `find` returns a char boundary when the predicate is on `char`.
        Some(i) => {
            let tok = s.get(..i)?;
            let rest = s.get(i..)?.trim_start();
            Some((tok, rest))
        }
        None => Some((s, "")),
    }
}

/// Parse RFC5424 body (after optional PRI). Returns `None` when the line is not
/// RFC5424-shaped so classic syslog can handle it.
fn parse_rfc5424_body(rest: &str, ingest_seq: u64, raw: &str) -> Option<ParsedLine> {
    let (version, rest) = take_token(rest)?;
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (ts_tok, rest) = take_token(rest)?;
    // Explicit Z / numeric offset → wall seconds; NILVALUE, offsetless, or garbage → order-only.
    let wall_ts = parse_explicit_timestamp(ts_tok);
    let (host_tok, rest) = take_token(rest)?;
    let (app_tok, rest) = take_token(rest)?;
    let (_procid, rest) = take_token(rest)?;
    let (_msgid, rest) = take_token(rest)?;
    let message = rfc5424_message(rest);
    let level = level_from_message_text(&message);
    let host = if host_tok == "-" {
        None
    } else {
        Some(host_tok.to_string())
    };
    let service = if app_tok == "-" {
        None
    } else {
        Some(app_tok.to_string())
    };
    Some(ParsedLine {
        ts: wall_ts.or(Some(ingest_seq as i64)),
        level,
        service,
        host,
        trace_id: None,
        message: if message.is_empty() {
            raw.to_string()
        } else {
            message
        },
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
}

fn rfc5424_message(rest: &str) -> String {
    let rest = rest.trim_start();
    if rest.is_empty() {
        return String::new();
    }
    if rest == "-" {
        return String::new();
    }
    // NILVALUE structured-data then optional MSG.
    if let Some(after) = rest.strip_prefix('-') {
        return after.trim_start().to_string();
    }
    // Structured data: one or more [SD-ELEMENT] then optional MSG.
    // Walk by chars so indices stay on UTF-8 boundaries (SD is ASCII in practice).
    if rest.starts_with('[') {
        let mut idx = 0;
        let bytes = rest.as_bytes();
        while idx < bytes.len() && bytes[idx] == b'[' {
            // Find matching ']' while allowing escaped chars inside SD.
            idx += 1;
            while idx < bytes.len() {
                if bytes[idx] == b'\\' && idx + 1 < bytes.len() {
                    idx += 2;
                    continue;
                }
                if bytes[idx] == b']' {
                    idx += 1;
                    break;
                }
                idx += 1;
            }
            while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
                idx += 1;
            }
        }
        return rest.get(idx..).unwrap_or("").to_string();
    }
    rest.to_string()
}

fn level_from_message_text(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("error") {
        "error".into()
    } else if lower.contains("warn") {
        "warn".into()
    } else {
        "info".into()
    }
}

fn parse_plain(raw: &str, ingest_seq: u64) -> ParsedLine {
    let level = if let Some(l) = extract_level_token(raw) {
        normalize_level(l)
    } else {
        "unknown".into()
    };
    ParsedLine {
        ts: Some(ingest_seq as i64),
        level,
        service: None,
        host: None,
        trace_id: None,
        message: raw.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Plain,
    }
}

fn extract_level_token(s: &str) -> Option<&str> {
    for tok in s.split(|c: char| !c.is_alphanumeric()) {
        let u = tok.to_ascii_uppercase();
        if matches!(
            u.as_str(),
            "DEBUG" | "INFO" | "WARN" | "WARNING" | "ERROR" | "FATAL" | "TRACE"
        ) {
            return Some(tok);
        }
    }
    None
}

/// Normalize free-form level strings.
pub fn normalize_level(s: &str) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "debug" | "dbg" | "trace" => "debug".into(),
        "info" | "information" | "informational" => "info".into(),
        "warn" | "warning" => "warn".into(),
        "error" | "err" | "severe" => "error".into(),
        "fatal" | "crit" | "critical" | "panic" => "fatal".into(),
        "" => "unknown".into(),
        other => other.to_string(),
    }
}

/// Severity rank for clustering (higher = worse).
pub fn level_severity(level: &str) -> u8 {
    match normalize_level(level).as_str() {
        "fatal" => 5,
        "error" => 4,
        "warn" => 3,
        "info" => 2,
        "debug" => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_and_parse_json() {
        let line = r#"{"ts":1700000000,"level":"error","service":"api","message":"connection refused","trace_id":"abc"}"#;
        assert_eq!(detect_format(line, None), LogFormat::Json);
        let p = parse_line(line, None, 0);
        assert_eq!(p.level, "error");
        assert_eq!(p.service.as_deref(), Some("api"));
        assert_eq!(p.trace_id.as_deref(), Some("abc"));
        assert!(p.message.contains("connection refused"));
        assert_eq!(p.ts, Some(1_700_000_000));
    }

    #[test]
    fn detect_and_parse_logfmt() {
        let line = r#"ts=100 level=warn service=worker msg=retry host=n1"#;
        assert_eq!(detect_format(line, None), LogFormat::Logfmt);
        let p = parse_line(line, None, 0);
        assert_eq!(p.level, "warn");
        assert_eq!(p.service.as_deref(), Some("worker"));
        assert!(p.message.contains("retry"));
    }

    #[test]
    fn parse_logfmt_preserves_quoted_message_and_escapes() {
        let line = r#"ts=100 level=error service=worker trace_id=trace-42 msg="retry loop says \"wait\" at C:\\queue""#;
        assert_eq!(detect_format(line, None), LogFormat::Logfmt);
        let p = parse_line(line, None, 0);
        assert_eq!(p.level, "error");
        assert_eq!(p.service.as_deref(), Some("worker"));
        assert_eq!(p.trace_id.as_deref(), Some("trace-42"));
        assert_eq!(p.message, r#"retry loop says "wait" at C:\queue"#);
    }

    #[test]
    fn plain_never_drops() {
        let line = "something weird without structure";
        let p = parse_line(line, None, 42);
        assert_eq!(p.format, LogFormat::Plain);
        assert_eq!(p.message, line);
        assert_eq!(p.ts, Some(42));
    }

    #[test]
    fn syslog_detect() {
        let line = "<34>Oct 11 22:14:15 mymachine su: 'su root' failed";
        assert_eq!(detect_format(line, None), LogFormat::Syslog);
        let p = parse_line(line, Some(LogFormat::Syslog), 1);
        assert!(!p.message.is_empty());
    }

    /// Shared wall-clock instant used by same-instant / offset tests:
    /// 2025-01-01T13:20:00Z.
    const SHARED_INSTANT_SECS: i64 = 1_735_737_600;

    #[test]
    fn logfmt_explicit_offset_timestamps_normalize_to_unix_seconds() {
        let cases = [
            (
                r#"ts=2025-01-01T13:20:00Z level=info service=billing host=api-01.example msg=shared-z"#,
                SHARED_INSTANT_SECS,
            ),
            (
                r#"ts=2025-01-01T14:20:00+01:00 level=info service=billing host=api-01.example msg=shared-plus"#,
                SHARED_INSTANT_SECS,
            ),
            (
                r#"ts=2025-01-01T08:20:00-05:00 level=info service=billing host=api-01.example msg=shared-minus"#,
                SHARED_INSTANT_SECS,
            ),
            // Fractional explicit-offset: storage is whole-second only (truncated).
            (
                r#"ts=2025-01-01T13:20:00.999Z level=info service=billing host=api-01.example msg=shared-frac"#,
                SHARED_INSTANT_SECS,
            ),
            (
                r#"ts=2025-01-01T14:20:00.500+01:00 level=warn service=billing host=api-01.example msg=shared-frac-offset"#,
                SHARED_INSTANT_SECS,
            ),
        ];
        for (line, expected) in cases {
            let p = parse_line(line, Some(LogFormat::Logfmt), 99);
            assert_eq!(p.format, LogFormat::Logfmt, "line={line}");
            assert_eq!(p.ts, Some(expected), "line={line}");
            assert_eq!(
                p.level,
                if line.contains("level=warn") {
                    "warn"
                } else {
                    "info"
                }
            );
            assert_eq!(p.service.as_deref(), Some("billing"));
            assert_eq!(p.host.as_deref(), Some("api-01.example"));
            assert!(p.message.starts_with("shared-"), "message={}", p.message);
        }
    }

    #[test]
    fn rfc5424_explicit_offset_timestamps_normalize_to_unix_seconds() {
        let cases = [
            (
                "<34>1 2025-01-01T13:20:00Z syslog-01.example billing-api - - - shared-z",
                SHARED_INSTANT_SECS,
            ),
            (
                "<34>1 2025-01-01T14:20:00+01:00 syslog-01.example billing-api - - - shared-plus",
                SHARED_INSTANT_SECS,
            ),
            (
                "<34>1 2025-01-01T08:20:00-05:00 syslog-01.example billing-api - - - shared-minus",
                SHARED_INSTANT_SECS,
            ),
            (
                "<34>1 2025-01-01T13:20:00.999Z syslog-01.example billing-api - - - shared-frac",
                SHARED_INSTANT_SECS,
            ),
            (
                "<34>1 2025-01-01T14:20:00.250+01:00 syslog-01.example billing-api - - - shared-frac-offset",
                SHARED_INSTANT_SECS,
            ),
        ];
        for (line, expected) in cases {
            let p = parse_line(line, Some(LogFormat::Syslog), 77);
            assert_eq!(p.format, LogFormat::Syslog, "line={line}");
            assert_eq!(p.ts, Some(expected), "line={line}");
            assert_eq!(p.host.as_deref(), Some("syslog-01.example"));
            assert_eq!(p.service.as_deref(), Some("billing-api"));
            assert!(
                p.message.contains("shared-"),
                "message should preserve RFC5424 body, got {:?}",
                p.message
            );
        }
    }

    #[test]
    fn same_instant_across_json_logfmt_and_rfc5424_explicit_encodings() {
        // Equivalent encodings of SHARED_INSTANT_SECS must store the same whole second.
        let lines = [
            // JSON RFC3339 Z
            r#"{"ts":"2025-01-01T13:20:00Z","level":"info","service":"billing","host":"api-01.example","message":"json-z"}"#,
            // JSON RFC3339 +offset
            r#"{"ts":"2025-01-01T14:20:00+01:00","level":"info","service":"billing","host":"api-01.example","message":"json-plus"}"#,
            // JSON RFC3339 -offset
            r#"{"ts":"2025-01-01T08:20:00-05:00","level":"info","service":"billing","host":"api-01.example","message":"json-minus"}"#,
            // JSON epoch seconds
            r#"{"ts":1735737600,"level":"info","service":"billing","host":"api-01.example","message":"json-epoch-s"}"#,
            // JSON epoch milliseconds
            r#"{"ts":1735737600000,"level":"info","service":"billing","host":"api-01.example","message":"json-epoch-ms"}"#,
            // JSON fractional RFC3339 (whole-second storage)
            r#"{"ts":"2025-01-01T13:20:00.123Z","level":"info","service":"billing","host":"api-01.example","message":"json-frac"}"#,
            // logfmt explicit offset
            r#"ts=2025-01-01T14:20:00+01:00 level=info service=billing host=api-01.example msg=logfmt-plus"#,
            // logfmt Z
            r#"ts=2025-01-01T13:20:00Z level=info service=billing host=api-01.example msg=logfmt-z"#,
            // RFC5424 Z
            "<34>1 2025-01-01T13:20:00.000Z syslog-01.example billing - - - rfc5424-z",
            // RFC5424 +offset
            "<34>1 2025-01-01T14:20:00+01:00 syslog-01.example billing - - - rfc5424-plus",
        ];
        let mut seen = Vec::new();
        for line in lines {
            let p = parse_line(line, None, 0);
            assert_eq!(
                p.ts,
                Some(SHARED_INSTANT_SECS),
                "encoding did not normalize: {line}"
            );
            // Record is never dropped; message/fields remain usable.
            assert!(!p.message.is_empty(), "empty message for {line}");
            seen.push(p.ts.unwrap());
        }
        assert!(seen.iter().all(|t| *t == SHARED_INSTANT_SECS));
    }

    #[test]
    fn ambiguous_and_malformed_timestamps_stay_order_only() {
        // ingest_seq is the honest order-only fallback when the instant is not unambiguous.
        let ingest = 4242_u64;
        let controls = [
            // Offsetless local face (do not assume workstation TZ).
            r#"ts=2025-01-01T13:20:00 level=info service=billing host=api-01.example msg=offsetless-local"#,
            // DST-ambiguous style local without offset.
            r#"ts=2025-11-02T01:30:00 level=warn service=scheduler host=sched-01.example msg=dst-ambiguous"#,
            // Malformed.
            r#"ts=not-a-timestamp level=error service=billing host=api-01.example msg=malformed"#,
            // Missing timestamp field entirely.
            r#"level=info service=billing host=api-01.example msg=missing-ts"#,
            // Yearless classic syslog — never invent year/timezone.
            "<34>Jan  1 13:20:00 syslog-01.example billing-api: yearless classic",
            // RFC5424 with offsetless timestamp token — structure ok, wall time unresolved.
            "<34>1 2025-01-01T13:20:00 syslog-01.example billing-api - - - rfc5424-offsetless",
            // RFC5424 NILVALUE timestamp.
            "<34>1 - syslog-01.example billing-api - - - rfc5424-nil-ts",
        ];
        for line in controls {
            let p = parse_line(line, None, ingest);
            assert_eq!(
                p.ts,
                Some(ingest as i64),
                "control should stay order-only (ingest_seq), line={line}"
            );
            // Parse failure must never drop the record.
            assert_eq!(p.raw, line);
            assert!(!p.message.is_empty(), "message empty for {line}");
        }
    }

    #[test]
    fn logfmt_epoch_integer_still_parses() {
        let p = parse_line(
            r#"ts=1735737600 level=info service=worker msg=epoch-s host=n1"#,
            Some(LogFormat::Logfmt),
            0,
        );
        assert_eq!(p.ts, Some(SHARED_INSTANT_SECS));
        assert_eq!(p.message, "epoch-s");
    }

    #[test]
    fn fractional_explicit_offset_documents_whole_second_storage() {
        // Whole-second storage: subseconds are truncated, not rounded up to the next second.
        let line = r#"ts=2025-01-01T13:20:00.999Z level=info service=billing msg=frac host=api-01.example"#;
        let p = parse_line(line, Some(LogFormat::Logfmt), 0);
        assert_eq!(
            p.ts,
            Some(SHARED_INSTANT_SECS),
            "fractional Z must store whole seconds of the same UTC second, not invent subsecond fields"
        );
        // Next whole second only after the second boundary.
        let next = r#"ts=2025-01-01T13:20:01.001Z level=info service=billing msg=next host=api-01.example"#;
        let p_next = parse_line(next, Some(LogFormat::Logfmt), 0);
        assert_eq!(p_next.ts, Some(SHARED_INSTANT_SECS + 1));
    }
}
