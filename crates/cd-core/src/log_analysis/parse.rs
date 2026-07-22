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
        // ms vs s heuristic
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    if let Some(f) = v.as_f64() {
        let n = f as i64;
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return Some(if n > 10_000_000_000 { n / 1000 } else { n });
        }
        // RFC3339-ish: use chrono if present
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.timestamp());
        }
    }
    None
}

fn parse_logfmt(raw: &str, ingest_seq: u64) -> ParsedLine {
    let mut map = std::collections::HashMap::new();
    for tok in raw.split_whitespace() {
        if let Some((k, v)) = tok.split_once('=') {
            let v = v.trim_matches('"');
            map.insert(k.to_string(), v.to_string());
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
    let ts = map
        .get("ts")
        .or_else(|| map.get("time"))
        .and_then(|s| s.parse::<i64>().ok())
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

fn parse_syslog(raw: &str, ingest_seq: u64) -> ParsedLine {
    let mut rest = raw.trim();
    if rest.starts_with('<') {
        if let Some(i) = rest.find('>') {
            // pri tags are ASCII digits only
            rest = rest.get(i + 1..).unwrap_or(rest);
        }
    }
    // Skip optional timestamp token(s)
    let parts: Vec<&str> = rest.splitn(4, char::is_whitespace).collect();
    let (host, message) = if parts.len() >= 3 {
        (
            Some(parts[1].to_string()),
            parts[parts.len() - 1].to_string(),
        )
    } else {
        (None, rest.to_string())
    };
    let level = if message.to_lowercase().contains("error") {
        "error".into()
    } else if message.to_lowercase().contains("warn") {
        "warn".into()
    } else {
        "info".into()
    };
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
}
