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
        return decode_unix_epoch_to_secs_i64(n);
    }
    // JSON numbers above i64::MAX arrive as u64; reject rather than f64-round.
    if let Some(n) = v.as_u64() {
        if n > i64::MAX as u64 {
            return None;
        }
        return decode_unix_epoch_to_secs_i64(n as i64);
    }
    if let Some(f) = v.as_f64() {
        return decode_unix_epoch_to_secs_f64(f);
    }
    if let Some(s) = v.as_str() {
        return parse_explicit_timestamp(s);
    }
    None
}

/// Parse an unambiguous timestamp to Unix **whole seconds**.
///
/// Accepts:
/// - bounded integer epoch seconds, milliseconds, microseconds, or nanoseconds;
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
    if let Some(secs) = parse_numeric_epoch_str(s) {
        return Some(secs);
    }
    // `parse_from_rfc3339` requires an explicit offset (`Z` or ±HH:MM). Offsetless
    // local faces such as `2025-01-01T13:20:00` fail here on purpose.
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

// ---------------------------------------------------------------------------
// Bounded Unix epoch-unit decoding (#708 / child of #670)
// ---------------------------------------------------------------------------
//
// Storage remains Unix **whole seconds** only. Subsecond source digits may
// decide the unit (ms/us/ns) but are truncated away when converting to seconds;
// they are not persisted.
//
// Unit bands (non-negative raw integer magnitude, exclusive upper edges):
//   seconds:      [0, 1e11)
//   milliseconds: [1e11, 1e14)
//   microseconds: [1e14, 1e17)
//   nanoseconds:  [1e17, 1e19)  (also capped by i64::MAX ≈ 9.22e18)
//
// After conversion, the whole-second result must lie in:
//   [EPOCH_SEC_MIN, EPOCH_SEC_MAX] = [0, 4_102_444_800]
//   (1970-01-01T00:00:00Z ..= 2100-01-01T00:00:00Z inclusive)
//
// Rationale: these magnitude bands are non-overlapping for ordinary modern
// telemetry, and the post-check keeps decoded instants inside a documented
// wall-clock window so overflow/implausible values fail closed to order-only
// instead of wrapping or inventing a unit. Negatives are unsupported (no
// pre-1970 policy in this child). This is not a universal timestamp-quality
// claim — only a deterministic decode policy for explicit numeric epochs.

/// Inclusive minimum accepted whole-second epoch (1970-01-01T00:00:00Z).
const EPOCH_SEC_MIN: i64 = 0;
/// Inclusive maximum accepted whole-second epoch (2100-01-01T00:00:00Z).
const EPOCH_SEC_MAX: i64 = 4_102_444_800;

/// Exclusive upper bound for the seconds magnitude band (`[0, 1e11)`).
const EPOCH_BAND_MS_MIN: i64 = 100_000_000_000;
/// Exclusive upper bound for the milliseconds band (`[1e11, 1e14)`).
const EPOCH_BAND_US_MIN: i64 = 100_000_000_000_000;
/// Lower bound for the nanoseconds band (`[1e17, i64::MAX]` subject to
/// post-conversion `EPOCH_SEC_MAX`). `1e19` does not fit in `i64`.
const EPOCH_BAND_NS_MIN: i64 = 100_000_000_000_000_000;

const MS_PER_SEC: i64 = 1_000;
const US_PER_SEC: i64 = 1_000_000;
const NS_PER_SEC: i64 = 1_000_000_000;

fn epoch_secs_in_policy(secs: i64) -> bool {
    (EPOCH_SEC_MIN..=EPOCH_SEC_MAX).contains(&secs)
}

/// Decode a non-negative integer Unix epoch in s/ms/us/ns to whole seconds.
/// Returns `None` for negatives, out-of-band magnitudes, or decoded seconds
/// outside `[EPOCH_SEC_MIN, EPOCH_SEC_MAX]`. Uses checked division only.
fn decode_unix_epoch_to_secs_i64(raw: i64) -> Option<i64> {
    if raw < 0 {
        return None;
    }
    let secs = if raw < EPOCH_BAND_MS_MIN {
        // seconds
        raw
    } else if raw < EPOCH_BAND_US_MIN {
        // milliseconds → whole seconds (truncate subsecond)
        raw.checked_div(MS_PER_SEC)?
    } else if raw < EPOCH_BAND_NS_MIN {
        // microseconds
        raw.checked_div(US_PER_SEC)?
    } else {
        // nanoseconds — band upper edge is i64::MAX (1e19 does not fit in i64)
        raw.checked_div(NS_PER_SEC)?
    };
    if epoch_secs_in_policy(secs) {
        Some(secs)
    } else {
        None
    }
}

/// Decode a JSON floating numeric epoch. Nonfinite values are rejected.
/// Classification uses the truncated integer magnitude; fractional parts are
/// not stored (whole-second contract).
fn decode_unix_epoch_to_secs_f64(raw: f64) -> Option<i64> {
    if !raw.is_finite() {
        return None;
    }
    if raw < 0.0 {
        return None;
    }
    // Reject magnitudes that cannot be represented exactly enough for unit
    // classification in i64 (above i64::MAX as float).
    if raw > i64::MAX as f64 {
        return None;
    }
    // Truncate toward zero into i64 for unit bands (subseconds discarded).
    let as_i = raw as i64;
    decode_unix_epoch_to_secs_i64(as_i)
}

/// Parse a decimal integer string (optional leading `+`, optional leading zeros)
/// as a bounded epoch. Rejects empty, non-digit (after sign), and overflow.
fn parse_numeric_epoch_str(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let body = s.strip_prefix('+').unwrap_or(s);
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Reject pure sign or strings that overflow i64.
    let n = body.parse::<i64>().ok()?;
    decode_unix_epoch_to_secs_i64(n)
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
    fn epoch_unit_same_instant_across_json_and_logfmt_s_ms_us_ns() {
        let s = SHARED_INSTANT_SECS;
        let ms = s.checked_mul(1_000).expect("ms");
        let us = s.checked_mul(1_000_000).expect("us");
        let ns = s.checked_mul(1_000_000_000).expect("ns");

        let cases = [
            (
                format!(r#"{{"ts":{s},"level":"info","message":"json-s"}}"#),
                "json-s",
            ),
            (
                format!(r#"{{"ts":{ms},"level":"info","message":"json-ms"}}"#),
                "json-ms",
            ),
            (
                format!(r#"{{"ts":{us},"level":"info","message":"json-us"}}"#),
                "json-us",
            ),
            (
                format!(r#"{{"ts":{ns},"level":"info","message":"json-ns"}}"#),
                "json-ns",
            ),
            (
                format!(r#"{{"ts":"{s}","level":"info","message":"json-s-str"}}"#),
                "json-s-str",
            ),
            (
                format!(r#"{{"ts":"{ms}","level":"info","message":"json-ms-str"}}"#),
                "json-ms-str",
            ),
            (format!("ts={s} level=info msg=logfmt-s"), "logfmt-s"),
            (format!("ts={ms} level=info msg=logfmt-ms"), "logfmt-ms"),
            (format!("ts={us} level=info msg=logfmt-us"), "logfmt-us"),
            (format!("ts={ns} level=info msg=logfmt-ns"), "logfmt-ns"),
            (format!("ts=+{s} level=info msg=logfmt-plus"), "logfmt-plus"),
            (
                format!("ts={s:020} level=info msg=logfmt-leading-zeros"),
                "logfmt-zeros",
            ),
        ];
        for (line, label) in cases {
            let p = parse_line(&line, None, 99);
            assert_eq!(
                p.ts,
                Some(SHARED_INSTANT_SECS),
                "{label}: line={line} stored={:?}",
                p.ts
            );
            assert!(!p.message.is_empty(), "{label} must not drop the record");
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

    #[test]
    fn epoch_unit_json_float_truncates_to_whole_seconds() {
        // Fractional float informs nothing beyond whole-second storage.
        let line = r#"{"ts":1735737600.999,"level":"info","message":"frac"}"#;
        let p = parse_line(line, Some(LogFormat::Json), 0);
        assert_eq!(p.ts, Some(SHARED_INSTANT_SECS));
        // ms-scale float with fraction
        let line_ms = r#"{"ts":1735737600123.9,"level":"info","message":"frac-ms"}"#;
        let p_ms = parse_line(line_ms, Some(LogFormat::Json), 0);
        assert_eq!(p_ms.ts, Some(SHARED_INSTANT_SECS));
    }

    #[test]
    fn epoch_unit_boundaries_just_inside_and_outside() {
        // Seconds band upper edge: just inside EPOCH_SEC_MAX, just outside.
        assert_eq!(
            decode_unix_epoch_to_secs_i64(EPOCH_SEC_MAX),
            Some(EPOCH_SEC_MAX)
        );
        assert_eq!(decode_unix_epoch_to_secs_i64(EPOCH_SEC_MAX + 1), None);

        // Just below ms band → still seconds (if in policy).
        assert_eq!(
            decode_unix_epoch_to_secs_i64(EPOCH_BAND_MS_MIN - 1),
            // 1e11 - 1 is year ~5138, outside EPOCH_SEC_MAX → reject
            None
        );
        // Just inside ms band that decodes into policy window.
        let ms_ok = SHARED_INSTANT_SECS * 1_000;
        assert_eq!(
            decode_unix_epoch_to_secs_i64(ms_ok),
            Some(SHARED_INSTANT_SECS)
        );
        // Just below us band (still ms).
        let just_below_us = EPOCH_BAND_US_MIN - 1;
        let secs = just_below_us / 1_000;
        if epoch_secs_in_policy(secs) {
            assert_eq!(decode_unix_epoch_to_secs_i64(just_below_us), Some(secs));
        } else {
            assert_eq!(decode_unix_epoch_to_secs_i64(just_below_us), None);
        }
        // Just inside us band.
        let us_ok = SHARED_INSTANT_SECS * 1_000_000;
        assert_eq!(
            decode_unix_epoch_to_secs_i64(us_ok),
            Some(SHARED_INSTANT_SECS)
        );
        // Just inside ns band.
        let ns_ok = SHARED_INSTANT_SECS * 1_000_000_000;
        assert_eq!(
            decode_unix_epoch_to_secs_i64(ns_ok),
            Some(SHARED_INSTANT_SECS)
        );
        // EPOCH_SEC_MIN
        assert_eq!(decode_unix_epoch_to_secs_i64(0), Some(0));
        // Max ns that still decodes to EPOCH_SEC_MAX
        let max_ns = EPOCH_SEC_MAX.checked_mul(1_000_000_000).expect("max ns");
        assert_eq!(decode_unix_epoch_to_secs_i64(max_ns), Some(EPOCH_SEC_MAX));
        // One second past max in ns form
        if let Some(over_ns) = max_ns.checked_add(1_000_000_000) {
            assert_eq!(decode_unix_epoch_to_secs_i64(over_ns), None);
        }
    }

    #[test]
    fn epoch_unit_rejects_negatives_nonfinite_and_overflow() {
        assert_eq!(decode_unix_epoch_to_secs_i64(-1), None);
        assert_eq!(decode_unix_epoch_to_secs_i64(-SHARED_INSTANT_SECS), None);
        assert_eq!(decode_unix_epoch_to_secs_f64(f64::NAN), None);
        assert_eq!(decode_unix_epoch_to_secs_f64(f64::INFINITY), None);
        assert_eq!(decode_unix_epoch_to_secs_f64(f64::NEG_INFINITY), None);
        assert_eq!(decode_unix_epoch_to_secs_f64(-1.0), None);
        // Magnitude above i64::MAX as float
        assert_eq!(decode_unix_epoch_to_secs_f64((i64::MAX as f64) * 2.0), None);

        // Full-line: rejected numeric → order-only ingest_seq; line not dropped.
        let ingest = 7777_i64;
        let json_neg = r#"{"ts":-1,"level":"warn","message":"neg"}"#;
        let p = parse_line(json_neg, Some(LogFormat::Json), ingest as u64);
        assert_eq!(p.ts, Some(ingest));
        assert!(p.message.contains("neg"));
        assert_eq!(p.raw, json_neg);

        let json_nan = r#"{"ts":null,"level":"warn","message":"null-ts"}"#;
        let p_null = parse_line(json_nan, Some(LogFormat::Json), ingest as u64);
        assert_eq!(p_null.ts, Some(ingest));

        let logfmt_bad = "ts=not-a-number level=error msg=bad";
        let p_lf = parse_line(logfmt_bad, Some(LogFormat::Logfmt), ingest as u64);
        assert_eq!(p_lf.ts, Some(ingest));
        assert_eq!(p_lf.message, "bad");

        let logfmt_neg = "ts=-99 level=error msg=neg-lf";
        let p_neg = parse_line(logfmt_neg, Some(LogFormat::Logfmt), ingest as u64);
        assert_eq!(p_neg.ts, Some(ingest));
        assert_eq!(p_neg.message, "neg-lf");
    }

    #[test]
    fn epoch_unit_digit_strings_and_leading_sign() {
        assert_eq!(
            parse_numeric_epoch_str(&format!("{SHARED_INSTANT_SECS}")),
            Some(SHARED_INSTANT_SECS)
        );
        assert_eq!(
            parse_numeric_epoch_str(&format!("+{SHARED_INSTANT_SECS}")),
            Some(SHARED_INSTANT_SECS)
        );
        assert_eq!(
            parse_numeric_epoch_str(&format!("000{SHARED_INSTANT_SECS}")),
            Some(SHARED_INSTANT_SECS)
        );
        assert_eq!(parse_numeric_epoch_str(""), None);
        assert_eq!(parse_numeric_epoch_str("+"), None);
        assert_eq!(parse_numeric_epoch_str("12ab"), None);
        assert_eq!(parse_numeric_epoch_str("1_735_737_600"), None); // underscores not accepted
                                                                    // Overflow i64
        assert_eq!(
            parse_numeric_epoch_str("999999999999999999999999999999"),
            None
        );
    }

    #[test]
    fn epoch_unit_subsecond_source_does_not_claim_persisted_precision() {
        // ms with non-zero remainder still stores whole seconds only.
        let ms = SHARED_INSTANT_SECS * 1_000 + 999;
        assert_eq!(decode_unix_epoch_to_secs_i64(ms), Some(SHARED_INSTANT_SECS));
        let ns = SHARED_INSTANT_SECS * 1_000_000_000 + 999_999_999;
        assert_eq!(decode_unix_epoch_to_secs_i64(ns), Some(SHARED_INSTANT_SECS));
        let line = format!(r#"{{"ts":{ms},"level":"info","message":"ms-rem"}}"#);
        let p = parse_line(&line, Some(LogFormat::Json), 0);
        assert_eq!(p.ts, Some(SHARED_INSTANT_SECS));
    }

    #[test]
    fn epoch_unit_band_edges_and_json_u64_overflow() {
        // Magnitude at ms band edge: 1e11 ms → 1e8 seconds (1973-03-03) — in policy.
        assert_eq!(
            decode_unix_epoch_to_secs_i64(EPOCH_BAND_MS_MIN),
            Some(EPOCH_BAND_MS_MIN / 1_000)
        );
        // Just below ns band is microseconds; 1e17-1 us is far past 2100 → reject.
        assert_eq!(decode_unix_epoch_to_secs_i64(EPOCH_BAND_NS_MIN - 1), None);
        // i64::MAX as ns → seconds beyond EPOCH_SEC_MAX → reject
        assert_eq!(decode_unix_epoch_to_secs_i64(i64::MAX), None);

        // JSON number that only fits u64 (> i64::MAX) must not wrap.
        let huge = r#"{"ts":18446744073709551615,"level":"info","message":"u64-max"}"#;
        let p = parse_line(huge, Some(LogFormat::Json), 55);
        assert_eq!(p.ts, Some(55), "u64 overflow must fall back to order-only");
        assert!(p.message.contains("u64-max"));
    }
}
