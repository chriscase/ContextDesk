//! Format detection + line parse (#355). LOG_ANALYSIS.md §3.

use super::format_profile::{fingerprint_format, BuiltInGrammar, FormatFingerprint};
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

/// Durable provenance for the numeric value stored in an event's `ts` column.
///
/// The numeric value alone is never evidence that an event has a wall clock.
/// In particular, order-only ingest positions can grow into ordinary Unix
/// timestamp ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampProvenance {
    /// The parser observed an explicit offset/`Z` timestamp or a bounded epoch.
    ExplicitWallClock,
    /// The parser validated a complete local calendar timestamp but no timezone.
    UnresolvedLocal,
    /// No usable calendar timestamp was present; `ts` is the ingest position.
    OrderOnly,
    /// A legacy stored event predates durable provenance.
    ///
    /// This fails closed as order-only. Existing rows must never be upgraded by
    /// inspecting the magnitude of their numeric `ts`.
    #[default]
    LegacyUnknown,
}

impl TimestampProvenance {
    /// Stable DuckDB representation.
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::ExplicitWallClock => "explicit_wall",
            Self::UnresolvedLocal => "unresolved_local",
            Self::OrderOnly => "order_only",
            Self::LegacyUnknown => "legacy_unknown",
        }
    }

    /// Parse a stored representation. `NULL` is the safe legacy state.
    pub fn from_storage_str(value: Option<&str>) -> Option<Self> {
        match value {
            Some("explicit_wall") => Some(Self::ExplicitWallClock),
            Some("unresolved_local") => Some(Self::UnresolvedLocal),
            Some("order_only") => Some(Self::OrderOnly),
            Some("legacy_unknown") | None => Some(Self::LegacyUnknown),
            Some(_) => None,
        }
    }

    /// Whether this origin proves that `ts` is an instant.
    pub const fn is_wall_clock(self) -> bool {
        matches!(self, Self::ExplicitWallClock)
    }
}

/// Active interpretation of an event's current `ts` value.
///
/// This is deliberately separate from immutable [`TimestampProvenance`].
/// A timezone-resolution apply changes `ts` plus this basis from `OrderOnly`
/// to `ResolvedLocal`; clearing that resolution restores `ts = seq` and
/// `OrderOnly` while retaining the parser's local timestamp evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveTimestampBasis {
    /// Current `ts` came from an explicit parser-proven wall clock.
    ExplicitWall,
    /// Current `ts` was resolved from retained local evidence by an explicit policy.
    ResolvedLocal,
    /// Current `ts` is the ingest position.
    OrderOnly,
    /// A legacy row predates active-basis storage.
    #[default]
    LegacyUnknown,
}

impl ActiveTimestampBasis {
    /// Stable DuckDB representation.
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::ExplicitWall => "explicit_wall",
            Self::ResolvedLocal => "resolved_local",
            Self::OrderOnly => "order_only",
            Self::LegacyUnknown => "legacy_unknown",
        }
    }

    /// Parse a stored representation. `NULL` is the safe legacy state.
    pub fn from_storage_str(value: Option<&str>) -> Option<Self> {
        match value {
            Some("explicit_wall") => Some(Self::ExplicitWall),
            Some("resolved_local") => Some(Self::ResolvedLocal),
            Some("order_only") => Some(Self::OrderOnly),
            Some("legacy_unknown") | None => Some(Self::LegacyUnknown),
            Some(_) => None,
        }
    }

    /// Whether the active `ts` is a wall-clock instant.
    pub const fn is_wall_clock(self) -> bool {
        matches!(self, Self::ExplicitWall | Self::ResolvedLocal)
    }
}

/// One parsed log record (never drops data — unknown → whole line as message).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedLine {
    /// Unix seconds when known; else ingest-order synthetic.
    pub ts: Option<i64>,
    /// Explicit origin of the value in `ts`.
    #[serde(default)]
    pub timestamp_provenance: TimestampProvenance,
    /// Active interpretation of `ts`; initially derived from parser provenance.
    #[serde(default)]
    pub active_timestamp_basis: ActiveTimestampBasis,
    /// Validated source-local calendar text that lacks a timezone.
    ///
    /// This is parser evidence, not an instant. Consumers must not convert it
    /// without an explicit source timezone/DST policy. Event storage persists
    /// this exact parser evidence while keeping the event order-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unresolved_local_timestamp: Option<String>,
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

/// A parsed line paired with its explainable transient grammar fingerprint.
#[derive(Debug, Clone, PartialEq)]
pub struct FingerprintedParsedLine {
    /// Parsed record; existing field behavior remains unchanged.
    pub parsed: ParsedLine,
    /// Content-evidence result used for parser dispatch.
    pub fingerprint: FormatFingerprint,
}

/// Detect the existing coarse format from one bounded sample record.
///
/// Exact grammar identity and ambiguity are available from
/// [`fingerprint_format`]. Filename hints cannot decide this result.
pub fn detect_format(sample: &str, path: Option<&Path>) -> LogFormat {
    fingerprint_format(sample, path).log_format()
}

pub(super) fn looks_like_json_object(t: &str) -> bool {
    t.starts_with('{')
        && t.ends_with('}')
        && matches!(
            serde_json::from_str::<serde_json::Value>(t),
            Ok(serde_json::Value::Object(_))
        )
}

pub(super) fn looks_like_logfmt(t: &str) -> bool {
    // At least two valid pairs in a record dominated by key/value tokens.
    // Recognized semantic fields establish a strong clue; a record made
    // entirely of pairs also preserves generic logfmt without turning
    // incidental `foo=bar` payload fragments into structure.
    if t.starts_with('{') {
        return false;
    }
    let mut tokens = 0usize;
    let mut pairs = 0usize;
    let mut known_fields = 0usize;

    let mut start = None;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in t.char_indices() {
        if start.is_none() {
            if ch.is_whitespace() {
                continue;
            }
            start = Some(index);
        }

        if escaped {
            escaped = false;
        } else if quoted && ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
        } else if ch.is_whitespace() && !quoted {
            if let Some(token) = start
                .take()
                .and_then(|start_index| t.get(start_index..index))
            {
                inspect_logfmt_token(token, &mut tokens, &mut pairs, &mut known_fields);
            }
        }
    }
    if let Some(token) = start.and_then(|start_index| t.get(start_index..)) {
        inspect_logfmt_token(token, &mut tokens, &mut pairs, &mut known_fields);
    }

    pairs >= 2 && pairs.saturating_mul(2) >= tokens && (known_fields >= 1 || pairs == tokens)
}

fn inspect_logfmt_token(
    token: &str,
    tokens: &mut usize,
    pairs: &mut usize,
    known_fields: &mut usize,
) {
    *tokens += 1;
    let Some((key, value)) = token.split_once('=') else {
        return;
    };
    if key.is_empty()
        || value.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    {
        return;
    }
    *pairs += 1;
    if is_known_logfmt_field(key) {
        *known_fields += 1;
    }
}

fn is_known_logfmt_field(key: &str) -> bool {
    [
        "ts",
        "time",
        "timestamp",
        "level",
        "lvl",
        "severity",
        "msg",
        "message",
        "service",
        "app",
        "component",
        "host",
        "hostname",
        "node",
        "trace_id",
        "traceid",
        "request_id",
        "req_id",
        "span_id",
    ]
    .iter()
    .any(|known| key.eq_ignore_ascii_case(known))
}

fn strip_valid_pri(t: &str) -> Option<&str> {
    let rest = t.strip_prefix('<')?;
    let end = rest.find('>')?;
    let pri = rest.get(..end)?;
    if pri.is_empty()
        || pri.len() > 3
        || !pri.bytes().all(|byte| byte.is_ascii_digit())
        || pri.parse::<u16>().ok()? > 191
    {
        return None;
    }
    rest.get(end + 1..)
}

pub(super) fn looks_like_rfc5424(t: &str) -> bool {
    let Some(rest) = strip_valid_pri(t) else {
        return false;
    };
    let Some((version, rest)) = take_token(rest) else {
        return false;
    };
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Some((_timestamp, rest)) = take_token(rest) else {
        return false;
    };
    let Some((_host, rest)) = take_token(rest) else {
        return false;
    };
    let Some((_app, rest)) = take_token(rest) else {
        return false;
    };
    let Some((_procid, rest)) = take_token(rest) else {
        return false;
    };
    let Some((_msgid, structured_and_message)) = take_token(rest) else {
        return false;
    };
    structured_and_message.starts_with('-') || structured_and_message.starts_with('[')
}

pub(super) fn looks_like_classic_syslog(t: &str) -> bool {
    let rest = strip_valid_pri(t).unwrap_or(t);
    let Some((month, rest)) = take_token(rest) else {
        return false;
    };
    if !matches!(
        month,
        "Jan"
            | "Feb"
            | "Mar"
            | "Apr"
            | "May"
            | "Jun"
            | "Jul"
            | "Aug"
            | "Sep"
            | "Oct"
            | "Nov"
            | "Dec"
    ) {
        return false;
    }
    let Some((day, rest)) = take_token(rest) else {
        return false;
    };
    if day
        .parse::<u8>()
        .ok()
        .is_none_or(|value| !(1..=31).contains(&value))
    {
        return false;
    }
    let Some((time, rest)) = take_token(rest) else {
        return false;
    };
    if chrono::NaiveTime::parse_from_str(time, "%H:%M:%S").is_err() {
        return false;
    }
    let Some((host, message)) = take_token(rest) else {
        return false;
    };
    !host.is_empty() && !message.is_empty()
}

pub(super) fn looks_like_wildfly(t: &str) -> bool {
    parse_wildfly_parts(t).is_some()
}

pub(super) fn looks_like_datetime_message(t: &str) -> bool {
    parse_datetime_message_parts(t).is_some()
}

pub(super) fn looks_like_zone_abbreviated_datetime(t: &str) -> bool {
    parse_zone_abbreviated_datetime_parts(t).is_some()
}

pub(super) fn looks_like_elasticsearch(t: &str) -> bool {
    parse_elasticsearch_parts(t).is_some()
}

pub(super) fn looks_like_zone_abbreviated_incomplete_time(t: &str) -> bool {
    parse_zone_abbreviated_incomplete_parts(t).is_some()
}

/// Parse one line with a known (or auto-detected) format.
///
/// `ingest_seq` is used as synthetic timestamp when none is found.
pub fn parse_line(raw: &str, format: Option<LogFormat>, ingest_seq: u64) -> ParsedLine {
    if let Some(format) = format {
        // Preserve the compatibility API's historical contract: strict
        // application-server shapes override a coarse file hint, while every
        // other explicit hint remains authoritative for this call.
        if let Some(parsed) = parse_zone_abbreviated_incomplete_time(raw, ingest_seq) {
            return parsed;
        }
        if let Some(parsed) = parse_elasticsearch(raw, ingest_seq) {
            return parsed;
        }
        if let Some(parsed) = parse_wildfly(raw, ingest_seq) {
            return parsed;
        }
        return match format {
            LogFormat::Json => parse_json(raw, ingest_seq),
            LogFormat::Logfmt => parse_logfmt(raw, ingest_seq),
            LogFormat::Syslog => parse_syslog(raw, ingest_seq),
            LogFormat::Plain => parse_plain(raw, ingest_seq),
        };
    }

    parse_line_with_fingerprint(raw, None, ingest_seq).parsed
}

/// Parse one bounded physical record using the exact built-in fingerprint.
///
/// Unknown and ambiguous records use the complete whole-line fallback. No
/// registry order, path extension, timezone, or producer assertion can decide
/// the parse.
pub fn parse_line_with_fingerprint(
    raw: &str,
    path: Option<&Path>,
    ingest_seq: u64,
) -> FingerprintedParsedLine {
    let fingerprint = fingerprint_format(raw, path);
    let parsed = match fingerprint.grammar {
        Some(BuiltInGrammar::JsonObjectLine) => parse_json(raw, ingest_seq),
        Some(BuiltInGrammar::LogfmtRecord) => parse_logfmt(raw, ingest_seq),
        Some(BuiltInGrammar::Rfc5424 | BuiltInGrammar::ClassicSyslog) => {
            parse_syslog(raw, ingest_seq)
        }
        Some(BuiltInGrammar::DateLevelLoggerThread) => {
            parse_wildfly(raw, ingest_seq).unwrap_or_else(|| parse_plain(raw, ingest_seq))
        }
        Some(BuiltInGrammar::DateTimeMessage) => {
            parse_datetime_message(raw, ingest_seq).unwrap_or_else(|| parse_plain(raw, ingest_seq))
        }
        Some(BuiltInGrammar::DateTimeZoneAbbreviationLevel) => {
            parse_zone_abbreviated_datetime(raw, ingest_seq)
                .unwrap_or_else(|| parse_plain(raw, ingest_seq))
        }
        Some(BuiltInGrammar::BracketedTimestampLevelComponentNode) => {
            parse_elasticsearch(raw, ingest_seq).unwrap_or_else(|| parse_plain(raw, ingest_seq))
        }
        Some(BuiltInGrammar::LocalMinuteZoneLevel) => {
            parse_zone_abbreviated_incomplete_time(raw, ingest_seq)
                .unwrap_or_else(|| parse_plain(raw, ingest_seq))
        }
        Some(BuiltInGrammar::PlainLine) | None => parse_plain(raw, ingest_seq),
    };
    FingerprintedParsedLine {
        parsed,
        fingerprint,
    }
}

fn parse_json(raw: &str, ingest_seq: u64) -> ParsedLine {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return parse_plain(raw, ingest_seq);
    };
    let obj = v.as_object();
    // First-wins for duplicate JSON keys: serde_json keeps the last write, so
    // scan the raw text for the first occurrence of known timestamp keys (#789).
    let first_ts_hint = first_json_ts_field(raw, TIMESTAMP_FIELD_ALIASES);
    let get_str = |keys: &[&str]| -> Option<String> {
        let o = obj?;
        for k in keys {
            if let Some(s) = o.get(*k).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
        None
    };
    let get_level = || -> Option<String> {
        let o = obj?;
        // PostgreSQL jsonlog documents `error_severity` (#789 / #790).
        if let Some(s) = o
            .get("error_severity")
            .and_then(|x| x.as_str())
            .map(normalize_level)
        {
            return Some(s);
        }
        for k in ["level", "severity", "lvl"] {
            if let Some(s) = o.get(k).and_then(|x| x.as_str()) {
                return Some(normalize_level(s));
            }
            // Pino and friends encode severity as a number (#790).
            if let Some(n) = o.get(k).and_then(|x| x.as_i64()) {
                return Some(normalize_numeric_level(n));
            }
            if let Some(n) = o.get(k).and_then(|x| x.as_u64()) {
                return Some(normalize_numeric_level(n as i64));
            }
        }
        None
    };
    let timestamp = obj
        .and_then(|o| {
            o.get("ts")
                .or_else(|| o.get("timestamp"))
                .or_else(|| o.get("time"))
                .or_else(|| o.get("@timestamp"))
                .or_else(|| o.get("@t"))
                .or_else(|| o.get("eventTime"))
        })
        .map(parse_ts_value)
        .unwrap_or(ParsedTimestamp::Unusable);
    // Prefer the first timestamp key when the raw text contains duplicates.
    let timestamp = match first_ts_hint {
        Some(first) => first,
        None => timestamp,
    };
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        timestamp.into_stored_fields(ingest_seq);
    // #791: a transport envelope carries the application record in a payload
    // field. Read the payload's severity only when the envelope declared none,
    // so nothing the payload says can overwrite envelope metadata. Timestamp,
    // host, service and stream above are already fixed from the outer object
    // and are not revisited.
    let level = get_level()
        .or_else(|| {
            let payload = obj.and_then(|o| o.get("log")).and_then(|v| v.as_str())?;
            inner_payload_severity(payload, raw)
        })
        .unwrap_or_else(|| "unknown".into());
    let message = get_str(&["message", "msg", "log", "text"]).unwrap_or_else(|| raw.to_string());
    // #789: only true trace identifiers — never span_id or request_id.
    let trace_id = get_str(&["trace_id", "traceId", "trace"]);
    ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level,
        service: get_str(&["service", "app", "component"]),
        host: get_str(&["host", "hostname", "node"]),
        trace_id,
        message,
        raw: raw.to_string(),
        format: LogFormat::Json,
    }
}

/// Best-effort first scalar timestamp value for a JSON key (duplicate first-wins).
/// Returns either a numeric epoch or a parseable RFC3339/offset string as epoch.
/// JSON keys this parser treats as authoritative wall-clock time.
///
/// Public within the crate because
/// [`crate::normalized_log_events::RESERVED_EVENT_KEYS`] must refuse exactly
/// these: a normalized event carrying one would make an older reader derive an
/// instant the event never claimed. Copying the list into that module let it
/// silently fall behind when `@t` and `eventTime` were added here.
pub(crate) const TIMESTAMP_FIELD_ALIASES: &[&str] =
    &["ts", "timestamp", "time", "@timestamp", "@t", "eventTime"];

fn first_json_ts_field(raw: &str, keys: &[&str]) -> Option<ParsedTimestamp> {
    for key in keys {
        let pattern = format!("\"{key}\"");
        let mut search = raw;
        while let Some(idx) = search.find(&pattern) {
            let Some(after) = search.get(idx + pattern.len()..) else {
                break;
            };
            let after = after.trim_start();
            let Some(after) = after.strip_prefix(':') else {
                search = search.get(idx + pattern.len()..).unwrap_or("");
                continue;
            };
            let after = after.trim_start();
            if let Some(rest) = after.strip_prefix('"') {
                // String timestamp.
                if let Some(end) = rest.find('"') {
                    if let Some(s) = rest.get(..end) {
                        let ts = parse_timestamp_text(s);
                        if !matches!(ts, ParsedTimestamp::Unusable) {
                            return Some(ts);
                        }
                    }
                }
            } else {
                // Number (not string).
                let end = after
                    .find(|c: char| !c.is_ascii_digit() && c != '-' && c != '+' && c != '.')
                    .unwrap_or(after.len());
                if let Some(num) = after.get(..end).map(str::trim) {
                    if let Ok(n) = num.parse::<i64>() {
                        if let Some(secs) = decode_unix_epoch_to_secs_i64(n) {
                            return Some(ParsedTimestamp::ExplicitWallClock(secs));
                        }
                    }
                }
            }
            search = search.get(idx + pattern.len()..).unwrap_or("");
        }
    }
    None
}

fn normalize_numeric_level(n: i64) -> String {
    // Pino / bunyan-style bands (common open convention).
    match n {
        ..=10 => "trace".into(),
        11..=20 => "debug".into(),
        21..=30 => "info".into(),
        31..=40 => "warn".into(),
        41..=50 => "error".into(),
        51.. => "fatal".into(),
    }
}

// ---------------------------------------------------------------------------
// Bounded envelope payload interpretation (#791)
// ---------------------------------------------------------------------------
//
// A transport envelope often carries a payload in its own grammar: Docker's
// `json-file` wraps an application record in `log`, RFC5424 wraps CEF. The
// envelope owns time, stream, host and transport metadata; the payload owns
// application semantics such as severity.
//
// Only severity is read back out, and only when the envelope did not state one.
// Nothing the payload says may overwrite envelope provenance — that is the
// explicit non-goal in #791 ("Inner parsing must not silently overwrite
// container timestamp, source, host, stream, facility, or transport metadata").

/// Largest payload the parser will look inside.
const MAX_INNER_PAYLOAD_BYTES: usize = 64 * 1024;

/// Read an application severity out of one bounded envelope payload.
///
/// Returns `None` for anything unrecognised, oversized, or self-referential, so
/// a malformed or hostile payload degrades to the envelope's own behavior
/// rather than failing the record. Exactly one layer is decoded; the result is
/// a severity string and never a new record, so there is no recursion to bound
/// beyond this call.
fn inner_payload_severity(payload: &str, envelope: &str) -> Option<String> {
    let payload = payload.trim();
    if payload.is_empty() || payload.len() > MAX_INNER_PAYLOAD_BYTES {
        return None;
    }
    // Self-referential payload: an envelope whose `log` field is the envelope
    // again must not be walked.
    if payload == envelope.trim() {
        return None;
    }

    if let Ok(serde_json::Value::Object(inner)) = serde_json::from_str::<serde_json::Value>(payload)
    {
        for key in ["level", "severity", "lvl", "error_severity"] {
            match inner.get(key) {
                Some(serde_json::Value::String(s)) => return Some(normalize_level(s)),
                Some(serde_json::Value::Number(n)) => {
                    if let Some(i) = n.as_i64() {
                        return Some(normalize_numeric_level(i));
                    }
                }
                _ => {}
            }
        }
        return None;
    }

    if let Some(level) = cef_severity_level(payload) {
        return Some(level);
    }

    // logfmt payload: `level=warn msg="…"`.
    if looks_like_logfmt(payload) {
        for token in split_logfmt_tokens(payload) {
            if let Some((key, value)) = token.split_once('=') {
                if matches!(key, "level" | "severity" | "lvl") {
                    return Some(normalize_level(value.trim_matches('"')));
                }
            }
        }
    }
    None
}

/// Map a CEF `CEF:0|…|Severity|…` header onto a normalized level.
///
/// The documented scale is 0–10 with the bands Low (0–3), Medium (4–6),
/// High (7–8) and Very-High (9–10); the named forms are accepted too. Anything
/// shorter than the seven mandatory header fields, or with a severity outside
/// the scale, is not CEF we understand and yields `None`.
fn cef_severity_level(payload: &str) -> Option<String> {
    let rest = payload.trim().strip_prefix("CEF:")?;
    // Split on unescaped pipes: `\|` is a literal pipe inside a header field.
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '|' {
            fields.push(std::mem::take(&mut current));
            if fields.len() > 8 {
                break;
            }
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    // version | vendor | product | dev-version | signature | name | severity
    if fields.len() < 7 {
        return None;
    }
    let severity = fields[6].trim();
    if let Ok(value) = severity.parse::<u8>() {
        return match value {
            0..=3 => Some("info".into()),
            4..=6 => Some("warn".into()),
            7..=8 => Some("error".into()),
            9..=10 => Some("fatal".into()),
            _ => None,
        };
    }
    match severity.to_ascii_lowercase().as_str() {
        "low" | "unknown" => Some("info".into()),
        "medium" => Some("warn".into()),
        "high" => Some("error".into()),
        "very-high" | "very high" => Some("fatal".into()),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedTimestamp {
    ExplicitWallClock(i64),
    UnresolvedLocal(String),
    Unusable,
}

impl ParsedTimestamp {
    fn into_stored_fields(
        self,
        ingest_seq: u64,
    ) -> (
        i64,
        TimestampProvenance,
        ActiveTimestampBasis,
        Option<String>,
    ) {
        match self {
            Self::ExplicitWallClock(ts) => (
                ts,
                TimestampProvenance::ExplicitWallClock,
                ActiveTimestampBasis::ExplicitWall,
                None,
            ),
            Self::UnresolvedLocal(text) => (
                ingest_seq as i64,
                TimestampProvenance::UnresolvedLocal,
                ActiveTimestampBasis::OrderOnly,
                Some(text),
            ),
            Self::Unusable => (
                ingest_seq as i64,
                TimestampProvenance::OrderOnly,
                ActiveTimestampBasis::OrderOnly,
                None,
            ),
        }
    }
}

fn parse_ts_value(v: &serde_json::Value) -> ParsedTimestamp {
    if let Some(n) = v.as_i64() {
        return decode_unix_epoch_to_secs_i64(n)
            .map(ParsedTimestamp::ExplicitWallClock)
            .unwrap_or(ParsedTimestamp::Unusable);
    }
    // JSON numbers above i64::MAX arrive as u64; reject rather than f64-round.
    if let Some(n) = v.as_u64() {
        if n > i64::MAX as u64 {
            return ParsedTimestamp::Unusable;
        }
        return decode_unix_epoch_to_secs_i64(n as i64)
            .map(ParsedTimestamp::ExplicitWallClock)
            .unwrap_or(ParsedTimestamp::Unusable);
    }
    if let Some(f) = v.as_f64() {
        return decode_unix_epoch_to_secs_f64(f)
            .map(ParsedTimestamp::ExplicitWallClock)
            .unwrap_or(ParsedTimestamp::Unusable);
    }
    if let Some(s) = v.as_str() {
        return parse_timestamp_text(s);
    }
    ParsedTimestamp::Unusable
}

fn parse_timestamp_text(value: &str) -> ParsedTimestamp {
    let value = value.trim();
    if let Some(ts) = parse_explicit_timestamp(value) {
        return ParsedTimestamp::ExplicitWallClock(ts);
    }
    if is_complete_local_timestamp(value) {
        return ParsedTimestamp::UnresolvedLocal(value.to_string());
    }
    // `YYYY-MM-DD HH:MM:SS[.fff] <ZONE>` — PostgreSQL's `%m`/`%t` prefix and its
    // jsonlog `timestamp` field both use this shape, which is not RFC3339.
    if let Some(parsed) = parse_zone_suffixed_local(value) {
        return parsed;
    }
    // `Sun Jun 15 12:00:00 2025` — the C `ctime`/`date` calendar rendering.
    if let Some(parsed) = parse_ctime_calendar(value) {
        return parsed;
    }
    ParsedTimestamp::Unusable
}

/// Zone abbreviations whose meaning is unambiguous worldwide.
///
/// Deliberately tiny. `CST` is North American *or* Chinese, `IST` is Indian,
/// Irish or Israeli, `BST` is British or Bougainville — none may become an
/// instant without an explicit source-timezone policy, so they resolve to
/// retained local evidence instead.
const UNAMBIGUOUS_UTC_ZONES: &[&str] = &["UTC", "GMT", "UT", "Z", "ZULU"];

/// Zone abbreviations recognised as *zones* but deliberately not interpreted.
///
/// Recognising the token matters: it proves the trailing word is a timezone
/// rather than message text, so the calendar portion in front of it is real
/// evidence. Refusing to interpret it is what keeps `08:05:10 CST` from
/// becoming a guessed instant.
const AMBIGUOUS_LOCAL_ZONES: &[&str] = &[
    "EST", "EDT", "CST", "CDT", "MST", "MDT", "PST", "PDT", "AST", "ADT", "HST", "AKST", "AKDT",
    "CET", "CEST", "EET", "EEST", "WET", "WEST", "BST", "IST", "MSK", "MSD", "JST", "KST", "SGT",
    "HKT", "AEST", "AEDT", "ACST", "ACDT", "AWST", "NZST", "NZDT", "BRT", "ART", "CLT", "PET",
];

/// Split `YYYY-MM-DD HH:MM:SS[.fff] <ZONE>` into calendar text and zone token.
///
/// Returns `None` when the trailing word is not a timezone we recognise, so a
/// fabricated suffix such as `2025-06-15 12:00:00.123 NOTAZONE` is never
/// mistaken for a stamped timestamp.
fn split_zone_suffixed_local(value: &str) -> Option<(&str, &str)> {
    let value = value.trim();
    let (calendar, zone) = value.rsplit_once(' ')?;
    let calendar = calendar.trim_end();
    if !is_complete_local_timestamp(calendar) {
        return None;
    }
    let upper = zone.to_ascii_uppercase();
    if UNAMBIGUOUS_UTC_ZONES.contains(&upper.as_str())
        || AMBIGUOUS_LOCAL_ZONES.contains(&upper.as_str())
    {
        Some((calendar, zone))
    } else {
        None
    }
}

/// Interpret a zone-suffixed local timestamp.
///
/// An unambiguous UTC-equivalent zone yields a real instant. Every other
/// recognised abbreviation yields the calendar text as retained local evidence
/// — never a guessed instant.
fn parse_zone_suffixed_local(value: &str) -> Option<ParsedTimestamp> {
    let (calendar, zone) = split_zone_suffixed_local(value)?;
    if !UNAMBIGUOUS_UTC_ZONES.contains(&zone.to_ascii_uppercase().as_str()) {
        return Some(ParsedTimestamp::UnresolvedLocal(calendar.to_string()));
    }
    let mut canonical = calendar.to_string();
    if canonical.as_bytes().get(19) == Some(&b',') {
        canonical.replace_range(19..20, ".");
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&canonical, format) {
            let secs = naive.and_utc().timestamp();
            if epoch_secs_in_policy(secs) {
                return Some(ParsedTimestamp::ExplicitWallClock(secs));
            }
            return Some(ParsedTimestamp::Unusable);
        }
    }
    None
}

/// `Sun Jun 15 12:00:00 2025` — C `ctime`/`date` output, which carries no zone.
///
/// Complete local calendar evidence, so it is retained verbatim rather than
/// discarded, but never an instant: the producer's zone is unstated.
fn parse_ctime_calendar(value: &str) -> Option<ParsedTimestamp> {
    let value = value.trim();
    if value.len() > 64 {
        return None;
    }
    for format in ["%a %b %e %H:%M:%S %Y", "%a %b %d %H:%M:%S %Y"] {
        if chrono::NaiveDateTime::parse_from_str(value, format).is_ok() {
            return Some(ParsedTimestamp::UnresolvedLocal(value.to_string()));
        }
    }
    None
}

fn is_complete_local_timestamp(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut canonical = value.to_string();
    if canonical.as_bytes().get(19) == Some(&b',') {
        canonical.replace_range(19..20, ".");
    }
    [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ]
    .iter()
    .any(|format| chrono::NaiveDateTime::parse_from_str(&canonical, format).is_ok())
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
    // Date-shaped integers such as `20250615` fall inside the seconds band but
    // are YYYYMMDD calendar tokens, not Unix epochs. Accepting them fabricates
    // 1970 wall-clock evidence (unfiled conformance cases).
    if looks_like_yyyymmdd_integer(raw) {
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

/// True when `raw` is an 8-digit calendar date YYYYMMDD (year 1900–2100).
fn looks_like_yyyymmdd_integer(raw: i64) -> bool {
    if !(19_000_101..=21_001_231).contains(&raw) {
        return false;
    }
    // Must be exactly 8 decimal digits (no leading zeros beyond year).
    if !(10_000_000..100_000_000).contains(&raw) {
        return false;
    }
    let year = raw / 10_000;
    let month = (raw / 100) % 100;
    let day = raw % 100;
    (1900..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
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
    // First-wins map: a trailing duplicate key must not silently move time (#789).
    let mut map = std::collections::HashMap::new();
    for tok in split_logfmt_tokens(raw) {
        if let Some((k, v)) = tok.split_once('=') {
            let v = v
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(v)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
            map.entry(k.to_string()).or_insert(v);
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
    // `timestamp=` is a documented logfmt alias alongside `ts`/`time` (#789).
    let timestamp = map
        .get("ts")
        .or_else(|| map.get("time"))
        .or_else(|| map.get("timestamp"))
        .map(|value| parse_timestamp_text(value))
        .unwrap_or(ParsedTimestamp::Unusable);
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        timestamp.into_stored_fields(ingest_seq);
    ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level,
        service: map.get("service").or_else(|| map.get("app")).cloned(),
        host: map.get("host").cloned(),
        // #789: never promote request_id / span_id to trace.
        trace_id: map
            .get("trace_id")
            .or_else(|| map.get("traceId"))
            .or_else(|| map.get("trace"))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WildflyTimestamp {
    /// A timestamp with an explicit `Z` or numeric UTC offset.
    Wall(i64),
    /// A valid source-local calendar timestamp without a timezone.
    Local,
}

#[derive(Debug, Clone, Copy)]
struct ZoneAbbreviatedIncompleteParts<'a> {
    source_timestamp: &'a str,
    level: &'a str,
    payload: &'a str,
}

/// Recognize an application record shaped like:
///
/// `YYYY-MM-DDTHH:mm,SSS ZONE. LEVEL: message`
///
/// This is deliberately structure-only parsing. The producer grammar has not
/// established whether the comma field denotes seconds, milliseconds, or
/// something else, and timezone abbreviations are not unique offsets. The
/// complete timestamp token is therefore retained as unresolved provenance and
/// never converted to a wall-clock instant.
fn parse_zone_abbreviated_incomplete_parts(
    raw: &str,
) -> Option<ZoneAbbreviatedIncompleteParts<'_>> {
    const LOCAL_PREFIX_BYTES: usize = 20;
    let local = raw.get(..LOCAL_PREFIX_BYTES)?;
    let bytes = local.as_bytes();
    if bytes.len() != LOCAL_PREFIX_BYTES
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b','
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
    {
        return None;
    }

    chrono::NaiveDate::parse_from_str(local.get(..10)?, "%Y-%m-%d").ok()?;
    let hour = local.get(11..13)?.parse::<u8>().ok()?;
    let minute = local.get(14..16)?.parse::<u8>().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }

    let rest = raw.get(LOCAL_PREFIX_BYTES..)?.strip_prefix(' ')?;
    let zone_end = rest.find(". ")?;
    let zone = rest.get(..zone_end)?;
    if !(2..=8).contains(&zone.len()) || !zone.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return None;
    }
    let source_timestamp_end = LOCAL_PREFIX_BYTES + 1 + zone.len();
    let source_timestamp = raw.get(..source_timestamp_end)?;
    let body = rest.get(zone_end + 2..)?;
    let (level, payload) = body.split_once(": ")?;
    if !is_wildfly_level(level) || payload.is_empty() {
        return None;
    }

    Some(ZoneAbbreviatedIncompleteParts {
        source_timestamp,
        level,
        payload,
    })
}

fn parse_zone_abbreviated_incomplete_time(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let parts = parse_zone_abbreviated_incomplete_parts(raw.trim())?;
    Some(ParsedLine {
        ts: Some(ingest_seq as i64),
        timestamp_provenance: TimestampProvenance::UnresolvedLocal,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: Some(parts.source_timestamp.to_string()),
        level: normalize_level(parts.level),
        service: None,
        host: None,
        trace_id: None,
        message: parts.payload.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElasticsearchTimestamp {
    /// A timestamp with an explicit `Z` or numeric UTC offset.
    Wall(i64),
    /// A valid source-local calendar timestamp without a timezone.
    Local,
}

#[derive(Debug, Clone, Copy)]
struct ElasticsearchParts<'a> {
    timestamp: ElasticsearchTimestamp,
    source_timestamp: &'a str,
    level: &'a str,
    component: &'a str,
    node: Option<&'a str>,
    payload: &'a str,
}

/// Parse the classic Elasticsearch prefix:
///
/// `[YYYY-MM-DD HH:mm:ss,SSS][LEVEL][component] [node] message`
///
/// The node field is optional and historical emitters disagree about whether
/// whitespace precedes it. The shape remains strict: a valid calendar
/// timestamp, known severity, non-empty component, non-empty payload, and a
/// non-empty node whenever that fourth bracket group is present. This lets
/// per-line recognition work despite a file-level `Plain` hint without
/// mistaking arbitrary bracketed payloads for Elasticsearch records.
fn parse_elasticsearch_parts(raw: &str) -> Option<ElasticsearchParts<'_>> {
    let (source_timestamp, rest) = take_bracketed_field(raw)?;
    let source_timestamp = source_timestamp.trim();
    let timestamp = parse_elasticsearch_timestamp(source_timestamp)?;
    let (level, rest) = take_bracketed_field(rest)?;
    let level = level.trim();
    if !is_wildfly_level(level) {
        return None;
    }
    let (component, rest) = take_bracketed_field(rest)?;
    let component = component.trim();
    if component.is_empty() {
        return None;
    }
    let separated_rest = rest.trim_start();
    let (node, payload) = if separated_rest.starts_with('[') {
        let (node, rest) = take_bracketed_field(separated_rest)?;
        let node = node.trim();
        if node.is_empty() {
            return None;
        }
        (Some(node), rest.trim_start())
    } else {
        // Without a node, whitespace must delimit the component from payload.
        // Otherwise `[component]payload` is a malformed near-match.
        if separated_rest.len() == rest.len() {
            return None;
        }
        (None, separated_rest)
    };
    if payload.is_empty() {
        return None;
    }

    Some(ElasticsearchParts {
        timestamp,
        source_timestamp,
        level,
        component,
        node,
        payload,
    })
}

fn take_bracketed_field(value: &str) -> Option<(&str, &str)> {
    let value = value.strip_prefix('[')?;
    let end = value.find(']')?;
    Some((value.get(..end)?, value.get(end + 1..)?))
}

fn parse_elasticsearch_timestamp(value: &str) -> Option<ElasticsearchTimestamp> {
    const LOCAL_TIMESTAMP_BYTES: usize = 23;
    let local = value.get(..LOCAL_TIMESTAMP_BYTES)?;
    let bytes = local.as_bytes();
    if bytes.len() != LOCAL_TIMESTAMP_BYTES
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b' ' | b'T')
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !matches!(bytes[19], b',' | b'.')
        || !bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19) || byte.is_ascii_digit()
        })
    {
        return None;
    }

    let mut canonical_local = local.to_string();
    canonical_local.replace_range(10..11, " ");
    canonical_local.replace_range(19..20, ".");
    chrono::NaiveDateTime::parse_from_str(&canonical_local, "%Y-%m-%d %H:%M:%S%.3f").ok()?;

    let suffix = value.get(LOCAL_TIMESTAMP_BYTES..)?;
    if suffix.is_empty() {
        return Some(ElasticsearchTimestamp::Local);
    }
    let offset = canonical_wildfly_offset(suffix)?;
    canonical_local.replace_range(10..11, "T");
    canonical_local.push_str(&offset);
    parse_explicit_timestamp(&canonical_local).map(ElasticsearchTimestamp::Wall)
}

fn parse_elasticsearch(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let parts = parse_elasticsearch_parts(raw.trim())?;
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        match parts.timestamp {
            ElasticsearchTimestamp::Wall(ts) => (
                ts,
                TimestampProvenance::ExplicitWallClock,
                ActiveTimestampBasis::ExplicitWall,
                None,
            ),
            ElasticsearchTimestamp::Local => (
                ingest_seq as i64,
                TimestampProvenance::UnresolvedLocal,
                ActiveTimestampBasis::OrderOnly,
                Some(parts.source_timestamp.to_string()),
            ),
        };
    Some(ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level: normalize_level(parts.level),
        service: Some(parts.component.to_string()),
        host: parts.node.map(str::to_string),
        trace_id: None,
        message: parts.payload.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
}

#[derive(Debug, Clone, Copy)]
struct WildflyParts<'a> {
    timestamp: WildflyTimestamp,
    source_timestamp: &'a str,
    level: &'a str,
    logger: &'a str,
    thread: &'a str,
    payload: &'a str,
}

/// Parse the common JBoss/WildFly PatternFormatter prefix:
///
/// `YYYY-MM-DD HH:mm:ss,SSS LEVEL [logger] (thread) message`
///
/// A dot millisecond separator is also accepted. An immediately attached or
/// whitespace-separated `Z`, `+HH:MM`, `-HH:MM`, `+HHMM`, or `-HHMM` makes the
/// timestamp an unambiguous instant. Offsetless local calendar time is
/// validated but intentionally remains order-only: current event storage has
/// no field for a local datetime plus unresolved timezone provenance.
fn parse_wildfly_parts(raw: &str) -> Option<WildflyParts<'_>> {
    const LOCAL_TIMESTAMP_BYTES: usize = 23;
    let timestamp_text = raw.get(..LOCAL_TIMESTAMP_BYTES)?;
    let bytes = timestamp_text.as_bytes();
    if bytes.len() != LOCAL_TIMESTAMP_BYTES
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !matches!(bytes[19], b',' | b'.')
        || !bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19) || byte.is_ascii_digit()
        })
    {
        return None;
    }

    let mut canonical_local = timestamp_text.to_string();
    canonical_local.replace_range(19..20, ".");
    chrono::NaiveDateTime::parse_from_str(&canonical_local, "%Y-%m-%d %H:%M:%S%.3f").ok()?;

    let tail = raw.get(LOCAL_TIMESTAMP_BYTES..)?;
    let (timestamp, body) = if let Some((offset, rest)) = take_wildfly_offset_prefix(tail) {
        (
            WildflyTimestamp::Wall(parse_wildfly_wall_timestamp(&canonical_local, offset)?),
            rest.trim_start(),
        )
    } else {
        let body = tail.trim_start();
        if body.len() == tail.len() {
            return None;
        }
        if let Some((token, rest)) = take_token(body) {
            if canonical_wildfly_offset(token).is_some() {
                (
                    WildflyTimestamp::Wall(parse_wildfly_wall_timestamp(&canonical_local, token)?),
                    rest,
                )
            } else {
                (WildflyTimestamp::Local, body)
            }
        } else {
            return None;
        }
    };

    let (level, rest) = take_token(body)?;
    if !is_wildfly_level(level) {
        return None;
    }
    let rest = rest.strip_prefix('[')?;
    let logger_end = rest.find(']')?;
    let logger = rest.get(..logger_end)?;
    if logger.is_empty() {
        return None;
    }
    let rest = rest.get(logger_end + 1..)?.trim_start();
    let rest = rest.strip_prefix('(')?;
    let thread_end = rest.find(')')?;
    let thread = rest.get(..thread_end)?;
    if thread.is_empty() {
        return None;
    }
    let payload = rest.get(thread_end + 1..)?.trim_start();

    Some(WildflyParts {
        timestamp,
        source_timestamp: timestamp_text,
        level,
        logger,
        thread,
        payload,
    })
}

fn take_wildfly_offset_prefix(tail: &str) -> Option<(&str, &str)> {
    for len in [1, 6, 5] {
        let candidate = tail.get(..len)?;
        if canonical_wildfly_offset(candidate).is_none() {
            continue;
        }
        let rest = tail.get(len..)?;
        if rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace) {
            return Some((candidate, rest));
        }
    }
    None
}

fn canonical_wildfly_offset(offset: &str) -> Option<String> {
    if offset == "Z" {
        return Some("Z".into());
    }
    let bytes = offset.as_bytes();
    match bytes {
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2]
            if [h1, h2, m1, m2]
                .into_iter()
                .all(|byte| byte.is_ascii_digit()) =>
        {
            Some(String::from_utf8(vec![*sign, *h1, *h2, b':', *m1, *m2]).ok()?)
        }
        [sign @ (b'+' | b'-'), h1, h2, m1, m2]
            if [h1, h2, m1, m2]
                .into_iter()
                .all(|byte| byte.is_ascii_digit()) =>
        {
            Some(String::from_utf8(vec![*sign, *h1, *h2, b':', *m1, *m2]).ok()?)
        }
        _ => None,
    }
}

fn parse_wildfly_wall_timestamp(local: &str, offset: &str) -> Option<i64> {
    let offset = canonical_wildfly_offset(offset)?;
    let mut value = local.to_string();
    value.replace_range(10..11, "T");
    value.push_str(&offset);
    parse_explicit_timestamp(&value)
}

fn is_wildfly_level(level: &str) -> bool {
    matches!(
        level.to_ascii_uppercase().as_str(),
        "TRACE"
            | "DEBUG"
            | "FINEST"
            | "FINER"
            | "FINE"
            | "CONFIG"
            | "INFO"
            | "WARN"
            | "WARNING"
            | "ERROR"
            | "SEVERE"
            | "FATAL"
    )
}

#[derive(Debug, Clone, Copy)]
struct DateTimeMessageParts<'a> {
    timestamp: WildflyTimestamp,
    source_timestamp: &'a str,
    level: Option<&'a str>,
    payload: &'a str,
}

/// Parse a producer-neutral local timestamp prefix followed by either a known
/// severity or a message separated by at least two spaces. Specialized
/// grammars retain precedence, and the timestamp remains unresolved until the
/// user supplies a timezone.
fn parse_datetime_message_parts(raw: &str) -> Option<DateTimeMessageParts<'_>> {
    if parse_wildfly_parts(raw).is_some() {
        return None;
    }

    const SECOND_TIMESTAMP_BYTES: usize = 19;
    let second_timestamp = raw.get(..SECOND_TIMESTAMP_BYTES)?;
    let bytes = second_timestamp.as_bytes();
    if bytes.len() != SECOND_TIMESTAMP_BYTES
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b' ' | b'T')
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
    {
        return None;
    }

    let mut timestamp_bytes = SECOND_TIMESTAMP_BYTES;
    if raw
        .as_bytes()
        .get(timestamp_bytes)
        .is_some_and(|byte| matches!(byte, b',' | b'.'))
    {
        timestamp_bytes += 1;
        let fraction_start = timestamp_bytes;
        while raw
            .as_bytes()
            .get(timestamp_bytes)
            .is_some_and(u8::is_ascii_digit)
            && timestamp_bytes - fraction_start < 9
        {
            timestamp_bytes += 1;
        }
        if timestamp_bytes == fraction_start
            || raw
                .as_bytes()
                .get(timestamp_bytes)
                .is_some_and(u8::is_ascii_digit)
        {
            return None;
        }
    }

    let source_timestamp = raw.get(..timestamp_bytes)?;
    if !is_complete_local_timestamp(source_timestamp) {
        return None;
    }
    let tail = raw.get(timestamp_bytes..)?;

    // A near-WildFly record must fail closed as a whole record. In particular,
    // accepting its calendar as a generic prefix would hide malformed
    // logger/thread structure and make the remainder look like a clean
    // message. The strict grammar above is the only path allowed to split it.
    if looks_like_malformed_wildfly_tail(tail) {
        return None;
    }

    if let Some((offset, rest)) = take_wildfly_offset_prefix(tail) {
        return datetime_message_after_zone(source_timestamp, offset, rest);
    }

    let separator_bytes = tail.len().saturating_sub(tail.trim_start().len());
    if separator_bytes == 0 {
        return None;
    }
    let body = tail.trim_start();
    let (token, token_tail) = take_token(body)?;
    if let Some(offset) = canonical_datetime_zone(token) {
        return datetime_message_after_zone(source_timestamp, &offset, token_tail);
    }
    if let Some(level) = common_level_token(token) {
        let payload = strip_standalone_dash_delimiter(token_tail.trim_start());
        return Some(DateTimeMessageParts {
            timestamp: WildflyTimestamp::Local,
            source_timestamp,
            level: Some(level),
            payload,
        });
    }
    if looks_like_unresolved_zone_column(token, token_tail) {
        return None;
    }

    // One separating space is safe only when the timestamp itself carries a
    // strong machine-record clue: ISO `T`, or a fractional second. A plain
    // `YYYY-MM-DD HH:mm:ss payload` remains deliberately conservative because
    // that shape appears frequently in prose and copied snippets.
    let strong_single_space = source_timestamp.as_bytes().get(10) == Some(&b'T')
        || source_timestamp.len() > SECOND_TIMESTAMP_BYTES;
    if (separator_bytes < 2 && !strong_single_space) || body.is_empty() {
        return None;
    }
    Some(DateTimeMessageParts {
        timestamp: WildflyTimestamp::Local,
        source_timestamp,
        level: None,
        payload: body,
    })
}

fn looks_like_malformed_wildfly_tail(tail: &str) -> bool {
    let tail = tail.trim_start();
    let Some((level, after_level)) = take_token(tail) else {
        return false;
    };
    let uppercase_level_like = (2..=32).contains(&level.len())
        && level
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || matches!(byte, b'_' | b'-'));
    if common_level_token(level).is_none() && !uppercase_level_like {
        return false;
    }

    let bounded = after_level
        .get(..after_level.len().min(512))
        .unwrap_or(after_level);
    if let Some(after_open) = bounded.strip_prefix('[') {
        if let Some(close) = after_open.find(']') {
            return after_open
                .get(close + 1..)
                .is_some_and(|rest| rest.trim_start().starts_with('('));
        }
        // Missing logger close: require the would-be logger to be one compact
        // token immediately followed by a thread opener.
        return after_open.find('(').is_some_and(|open| {
            after_open
                .get(..open)
                .is_some_and(|logger| !logger.trim().is_empty() && !logger.trim().contains(' '))
        });
    }

    let Some((logger, rest)) = take_token(bounded) else {
        return false;
    };
    logger.ends_with(']') && rest.starts_with('(')
}

#[derive(Debug, Clone, Copy)]
struct ZoneAbbreviatedDateTimeParts<'a> {
    source_timestamp: &'a str,
    level: &'a str,
    payload: &'a str,
}

/// Parse a complete source-local calendar followed by a recognized, but
/// ambiguous, timezone abbreviation and a severity. The abbreviation is
/// evidence, not an offset: it is retained with the local calendar so a later
/// user declaration can validate it against IANA rules before resolving.
fn parse_zone_abbreviated_datetime_parts(raw: &str) -> Option<ZoneAbbreviatedDateTimeParts<'_>> {
    const SECOND_TIMESTAMP_BYTES: usize = 19;
    let base = raw.get(..SECOND_TIMESTAMP_BYTES)?;
    if !is_complete_local_timestamp(base) {
        return None;
    }

    let mut timestamp_bytes = SECOND_TIMESTAMP_BYTES;
    if raw
        .as_bytes()
        .get(timestamp_bytes)
        .is_some_and(|byte| matches!(byte, b',' | b'.'))
    {
        timestamp_bytes += 1;
        let fraction_start = timestamp_bytes;
        while raw
            .as_bytes()
            .get(timestamp_bytes)
            .is_some_and(u8::is_ascii_digit)
            && timestamp_bytes - fraction_start < 9
        {
            timestamp_bytes += 1;
        }
        if timestamp_bytes == fraction_start
            || raw
                .as_bytes()
                .get(timestamp_bytes)
                .is_some_and(u8::is_ascii_digit)
        {
            return None;
        }
    }

    let calendar = raw.get(..timestamp_bytes)?;
    if !is_complete_local_timestamp(calendar) {
        return None;
    }
    let tail = raw.get(timestamp_bytes..)?;
    let separator_bytes = tail.len().saturating_sub(tail.trim_start().len());
    if separator_bytes == 0 {
        return None;
    }
    let (zone, rest) = take_token(tail)?;
    if !AMBIGUOUS_LOCAL_ZONES.contains(&zone) {
        return None;
    }
    let (level_token, payload) = take_token(rest)?;
    let level = common_level_token(level_token)?;
    let source_timestamp_end = timestamp_bytes + separator_bytes + zone.len();
    Some(ZoneAbbreviatedDateTimeParts {
        source_timestamp: raw.get(..source_timestamp_end)?,
        level,
        payload: strip_standalone_dash_delimiter(payload.trim_start()),
    })
}

fn parse_zone_abbreviated_datetime(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let parts = parse_zone_abbreviated_datetime_parts(raw.trim())?;
    Some(ParsedLine {
        ts: Some(ingest_seq as i64),
        timestamp_provenance: TimestampProvenance::UnresolvedLocal,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: Some(parts.source_timestamp.to_string()),
        level: normalize_level(parts.level),
        service: None,
        host: None,
        trace_id: None,
        message: parts.payload.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
}

fn datetime_message_after_zone<'a>(
    source_timestamp: &'a str,
    offset: &str,
    rest: &'a str,
) -> Option<DateTimeMessageParts<'a>> {
    let body = rest.trim_start();
    let (level_token, payload) = take_token(body)?;
    let level = common_level_token(level_token)?;
    let payload = strip_standalone_dash_delimiter(payload.trim_start());
    Some(DateTimeMessageParts {
        timestamp: WildflyTimestamp::Wall(parse_datetime_wall_timestamp(source_timestamp, offset)?),
        source_timestamp,
        level: Some(level),
        payload,
    })
}

fn canonical_datetime_zone(token: &str) -> Option<String> {
    if matches!(token.to_ascii_uppercase().as_str(), "UTC" | "GMT") {
        return Some("Z".into());
    }
    canonical_wildfly_offset(token)
}

fn parse_datetime_wall_timestamp(local: &str, offset: &str) -> Option<i64> {
    let mut value = local.replace(',', ".");
    value.replace_range(10..11, "T");
    value.push_str(&canonical_datetime_zone(offset)?);
    parse_explicit_timestamp(&value)
}

fn common_level_token(token: &str) -> Option<&str> {
    let token = token
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(token);
    let token = token.strip_suffix(':').unwrap_or(token);
    matches!(
        token.to_ascii_uppercase().as_str(),
        "TRACE"
            | "DEBUG"
            | "FINEST"
            | "FINER"
            | "FINE"
            | "CONFIG"
            | "INFO"
            | "NOTICE"
            | "LOG"
            | "WARN"
            | "WARNING"
            | "ERROR"
            | "SEVERE"
            | "CRITICAL"
            | "CRIT"
            | "FATAL"
            | "PANIC"
            | "ALERT"
            | "EMERG"
            | "EMERGENCY"
    )
    .then_some(token)
}

fn looks_like_unresolved_zone_column(token: &str, rest: &str) -> bool {
    let upper = token.to_ascii_uppercase();
    let next_is_level_like = take_token(rest).is_some_and(|(candidate, _)| {
        let candidate = candidate.trim_end_matches(':');
        common_level_token(candidate).is_some()
            || ((2..=32).contains(&candidate.len())
                && candidate
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || matches!(byte, b'_' | b'-')))
    });
    (2..=8).contains(&token.len())
        && (token.bytes().all(|byte| byte.is_ascii_uppercase())
            || AMBIGUOUS_LOCAL_ZONES.contains(&upper.as_str()))
        && next_is_level_like
}

fn strip_standalone_dash_delimiter(payload: &str) -> &str {
    let Some(after_dash) = payload.strip_prefix('-') else {
        return payload;
    };
    if after_dash.is_empty() {
        ""
    } else if after_dash.chars().next().is_some_and(char::is_whitespace) {
        after_dash.trim_start()
    } else {
        payload
    }
}

fn parse_datetime_message(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let parts = parse_datetime_message_parts(raw.trim())?;
    let level = parts
        .level
        .or_else(|| extract_level_token(parts.payload))
        .map(normalize_level)
        .unwrap_or_else(|| "unknown".into());
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        match parts.timestamp {
            WildflyTimestamp::Wall(ts) => (
                ts,
                TimestampProvenance::ExplicitWallClock,
                ActiveTimestampBasis::ExplicitWall,
                None,
            ),
            WildflyTimestamp::Local => (
                ingest_seq as i64,
                TimestampProvenance::UnresolvedLocal,
                ActiveTimestampBasis::OrderOnly,
                Some(parts.source_timestamp.to_string()),
            ),
        };
    Some(ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level,
        service: None,
        host: None,
        trace_id: None,
        message: parts.payload.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
}

fn parse_wildfly(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let parts = parse_wildfly_parts(raw.trim())?;
    let mut message = format!("[{}] ({})", parts.logger, parts.thread);
    if !parts.payload.is_empty() {
        message.push(' ');
        message.push_str(parts.payload);
    }
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        match parts.timestamp {
            WildflyTimestamp::Wall(ts) => (
                ts,
                TimestampProvenance::ExplicitWallClock,
                ActiveTimestampBasis::ExplicitWall,
                None,
            ),
            WildflyTimestamp::Local => (
                ingest_seq as i64,
                TimestampProvenance::UnresolvedLocal,
                ActiveTimestampBasis::OrderOnly,
                Some(parts.source_timestamp.to_string()),
            ),
        };
    Some(ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level: normalize_level(parts.level),
        service: None,
        host: None,
        trace_id: None,
        message,
        raw: raw.to_string(),
        format: LogFormat::Syslog,
    })
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

    // A file-level Syslog hint also applies to continuation lines. Preserve
    // stack frames and exception causes whole instead of splitting them as a
    // malformed classic-syslog record.
    if !looks_like_classic_syslog(rest) {
        return parse_plain(raw, ingest_seq);
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
        timestamp_provenance: TimestampProvenance::OrderOnly,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: None,
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
    // Explicit Z / numeric offset → wall seconds; a complete offsetless local
    // value is retained for a later explicit source-timezone decision.
    let timestamp = parse_timestamp_text(ts_tok);
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        timestamp.into_stored_fields(ingest_seq);
    let (host_tok, rest) = take_token(rest)?;
    let (app_tok, rest) = take_token(rest)?;
    let (_procid, rest) = take_token(rest)?;
    let (_msgid, rest) = take_token(rest)?;
    let message = rfc5424_message(rest);
    // #791: RFC5424 commonly transports a CEF payload whose header states a
    // documented 0–10 severity. Reading it is strictly better than the
    // substring scan below, which would call this record `info` because it
    // contains neither "error" nor "warn". Malformed CEF falls back.
    let level =
        inner_payload_severity(&message, raw).unwrap_or_else(|| level_from_message_text(&message));
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
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
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
    // Prefer PostgreSQL stderr grammar when the line (or multi-line record)
    // matches the documented prefix form (#788 / #790).
    if let Some(parsed) = parse_postgres_stderr(raw, ingest_seq) {
        return parsed;
    }
    // csvlog rows are quoted CSV; attempt a bounded field extract.
    if let Some(parsed) = parse_postgres_csvlog(raw, ingest_seq) {
        return parsed;
    }
    let level = if let Some(l) = extract_level_token(raw) {
        normalize_level(l)
    } else {
        "unknown".into()
    };
    ParsedLine {
        ts: Some(ingest_seq as i64),
        timestamp_provenance: TimestampProvenance::OrderOnly,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: None,
        level,
        service: None,
        host: None,
        trace_id: None,
        message: raw.to_string(),
        raw: raw.to_string(),
        format: LogFormat::Plain,
    }
}

/// PostgreSQL stderr: `YYYY-MM-DD HH:MM:SS.mmm TZ [pid] SEVERITY: message`.
fn parse_postgres_stderr(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let primary = raw.lines().next()?.trim();
    let bracket = primary.find('[')?;
    let after_bracket = primary.get(bracket..)?;
    let close = after_bracket.find(']')?;
    let rest = after_bracket.get(close + 1..)?.trim_start();
    let (sev_tok, message) = rest.split_once(':')?;
    let sev = sev_tok.trim();
    if !is_pg_severity_token(sev) {
        return None;
    }
    // Prefix before `[pid]` should look like a PG timestamp.
    let prefix = primary.get(..bracket)?.trim();
    if prefix.len() < 19 || prefix.as_bytes().get(4).is_none_or(|b| *b != b'-') {
        return None;
    }
    // Preserve multi-line DETAIL/HINT/STATEMENT in the message body.
    let full_message = if raw.contains('\n') {
        raw.to_string()
    } else {
        message.trim_start().to_string()
    };
    // `log_line_prefix` stamps `%m`/`%t` as `YYYY-MM-DD HH:MM:SS[.mmm] ZONE`.
    // `UTC` names one instant; `CST` and friends name several, so those keep
    // the calendar text as local evidence and stay order-only.
    let (ts, timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp) =
        parse_zone_suffixed_local(prefix)
            .unwrap_or(ParsedTimestamp::Unusable)
            .into_stored_fields(ingest_seq);
    Some(ParsedLine {
        ts: Some(ts),
        timestamp_provenance,
        active_timestamp_basis,
        unresolved_local_timestamp,
        level: normalize_level(sev),
        service: None,
        host: None,
        trace_id: None,
        message: full_message,
        raw: raw.to_string(),
        format: LogFormat::Plain,
    })
}

fn is_pg_severity_token(sev: &str) -> bool {
    matches!(
        sev.to_ascii_uppercase().as_str(),
        "DEBUG"
            | "DEBUG1"
            | "DEBUG2"
            | "DEBUG3"
            | "DEBUG4"
            | "DEBUG5"
            | "INFO"
            | "NOTICE"
            | "WARNING"
            | "ERROR"
            | "LOG"
            | "FATAL"
            | "PANIC"
            | "DETAIL"
            | "HINT"
            | "STATEMENT"
            | "CONTEXT"
            | "QUERY"
    )
}

/// PostgreSQL csvlog: documented CSV with severity in a fixed column band.
fn parse_postgres_csvlog(raw: &str, ingest_seq: u64) -> Option<ParsedLine> {
    let first = raw.lines().next()?.trim_start();
    if !first.starts_with('"') {
        return None;
    }
    let fields = parse_csv_fields(raw.lines().next()?)?;
    // Documented csvlog has many columns; error_severity is typically near the
    // middle. Accept a field that is an exact PG severity token.
    let level = fields
        .iter()
        .find(|f| is_pg_severity_token(f) && f.len() <= 12)
        .map(|s| normalize_level(s))
        .unwrap_or_else(|| "unknown".into());
    // Message is usually the first long free-text field after severity.
    let message = if raw.contains('\n') {
        raw.to_string()
    } else {
        fields
            .iter()
            .find(|f| f.len() > 12 && !is_pg_severity_token(f))
            .cloned()
            .unwrap_or_else(|| raw.to_string())
    };
    Some(ParsedLine {
        ts: Some(ingest_seq as i64),
        timestamp_provenance: TimestampProvenance::OrderOnly,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: None,
        level,
        service: None,
        host: None,
        trace_id: None,
        message,
        raw: raw.to_string(),
        format: LogFormat::Plain,
    })
}

fn parse_csv_fields(line: &str) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quote {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cur.push('"');
                } else {
                    in_quote = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_quote = true;
        } else if ch == ',' {
            fields.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    fields.push(cur);
    if fields.len() < 4 {
        return None;
    }
    Some(fields)
}

fn extract_level_token(s: &str) -> Option<&str> {
    for tok in s.split(|c: char| !c.is_alphanumeric()) {
        let u = tok.to_ascii_uppercase();
        if matches!(
            u.as_str(),
            "DEBUG"
                | "INFO"
                | "WARN"
                | "WARNING"
                | "ERROR"
                | "FATAL"
                | "TRACE"
                | "LOG"
                | "NOTICE"
                | "CRITICAL"
                | "ALERT"
                | "EMERG"
                | "EMERGENCY"
                | "PANIC"
        ) {
            return Some(tok);
        }
    }
    None
}

/// Normalize free-form level strings.
///
/// Distinct vocabulary is preserved when the oracle and product need it:
/// `trace` ≠ `debug`, `critical` ≠ `fatal`, PostgreSQL `log` stays `log` (#790).
pub fn normalize_level(s: &str) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "trace" | "trc" => "trace".into(),
        "debug" | "dbg" | "debug1" | "debug2" | "debug3" | "debug4" | "debug5" | "fine"
        | "finer" | "finest" => "debug".into(),
        "info" | "information" | "informational" | "config" => "info".into(),
        "notice" => "notice".into(),
        "log" => "log".into(),
        "warn" | "warning" => "warn".into(),
        "error" | "err" | "severe" => "error".into(),
        "critical" | "crit" => "critical".into(),
        "alert" => "alert".into(),
        "fatal" | "panic" => "fatal".into(),
        "emergency" | "emerg" => "emergency".into(),
        "" => "unknown".into(),
        other => other.to_string(),
    }
}

/// Severity rank for clustering (higher = worse).
pub fn level_severity(level: &str) -> u8 {
    match normalize_level(level).as_str() {
        "emergency" | "alert" | "fatal" | "critical" | "panic" => 5,
        "error" => 4,
        "warn" => 3,
        "info" | "notice" | "log" => 2,
        "debug" | "trace" => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::FormatFingerprintOutcome;

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
        assert_eq!(
            p.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
    }

    #[test]
    fn timestamp_provenance_explicit_pre_2000_remains_wall_clock() {
        let line =
            r#"{"timestamp":"1999-12-31T23:59:59Z","level":"error","message":"old failure"}"#;
        let parsed = parse_line(line, Some(LogFormat::Json), 1_000_000_000);
        assert_eq!(parsed.ts, Some(946_684_799));
        assert_eq!(
            parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(parsed.unresolved_local_timestamp, None);
        assert_eq!(parsed.raw, line);
    }

    #[test]
    fn timestamp_provenance_billion_scale_ingest_position_remains_order_only() {
        let parsed = parse_line(
            "ERROR no timestamp despite a large ingest position",
            Some(LogFormat::Plain),
            1_000_000_000,
        );
        assert_eq!(parsed.ts, Some(1_000_000_000));
        assert_eq!(parsed.timestamp_provenance, TimestampProvenance::OrderOnly);
        assert_eq!(parsed.unresolved_local_timestamp, None);
    }

    #[test]
    fn timestamp_provenance_retains_local_but_not_missing_or_malformed_values() {
        let local = parse_line(
            r#"{"timestamp":"2021-03-05 02:53:53,654","message":"local"}"#,
            Some(LogFormat::Json),
            77,
        );
        assert_eq!(local.ts, Some(77));
        assert_eq!(
            local.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            local.unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );

        for line in [
            r#"{"message":"missing"}"#,
            r#"{"timestamp":"not-a-time","message":"malformed"}"#,
        ] {
            let parsed = parse_line(line, Some(LogFormat::Json), 88);
            assert_eq!(parsed.ts, Some(88));
            assert_eq!(parsed.timestamp_provenance, TimestampProvenance::OrderOnly);
            assert_eq!(parsed.unresolved_local_timestamp, None);
            assert_eq!(parsed.raw, line);
        }
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
    fn banner_then_json_and_logfmt_are_fingerprinted_per_record() {
        let records = [
            "Synthetic service startup banner",
            r#"{"ts":1700000000,"level":"error","message":"json failure"}"#,
            "ts=1700000001 level=warn msg=\"logfmt retry\"",
        ];

        let parsed = records
            .iter()
            .enumerate()
            .map(|(index, record)| {
                parse_line_with_fingerprint(record, Some(Path::new("mixed.jsonl")), index as u64)
            })
            .collect::<Vec<_>>();

        assert_eq!(
            parsed[0].fingerprint.outcome,
            FormatFingerprintOutcome::Unknown
        );
        assert_eq!(parsed[0].fingerprint.format_id, Some("plain-line"));
        assert_eq!(parsed[1].fingerprint.format_id, Some("json-object-line"));
        assert_eq!(parsed[1].parsed.message, "json failure");
        assert_eq!(parsed[2].fingerprint.format_id, Some("logfmt-record"));
        assert_eq!(parsed[2].parsed.message, "logfmt retry");
    }

    #[test]
    fn explicit_compatibility_hint_remains_authoritative_except_strict_special_shapes() {
        let logfmt = "level=warn msg=retry";
        let hinted_json = parse_line(logfmt, Some(LogFormat::Json), 7);
        assert_eq!(hinted_json.format, LogFormat::Plain);
        assert_eq!(hinted_json.message, logfmt);

        let wildfly = "2026-07-29 09:14:05,123 INFO [com.example.Logger] (worker) shaped";
        let hinted_plain = parse_line(wildfly, Some(LogFormat::Plain), 8);
        assert_eq!(hinted_plain.format, LogFormat::Syslog);
        assert_eq!(hinted_plain.message, "[com.example.Logger] (worker) shaped");
    }

    #[test]
    fn mixed_builtin_grammars_preserve_raw_and_exact_transient_identity() {
        let records = [
            (r#"{"level":"info","message":"json"}"#, "json-object-line"),
            ("level=warn msg=logfmt", "logfmt-record"),
            (
                "<34>1 2025-01-01T13:20:00Z host app 1 ID47 - rfc5424",
                "rfc5424-record",
            ),
            (
                "Oct 11 22:14:15 host classic syslog",
                "classic-syslog-record",
            ),
            (
                "2026-07-29 09:14:05,123 INFO [com.example.Logger] (worker) shaped",
                "date-level-logger-thread-record",
            ),
            (
                "[2026-07-29 14:05:06,324][INFO][transport][node.example] bracketed",
                "bracketed-timestamp-level-component-node-record",
            ),
            (
                "2026-07-29T14:05,321 CET. INFO: unresolved",
                "local-minute-zone-level-record",
            ),
            ("ordinary payload", "plain-line"),
        ];

        for (index, (record, expected_id)) in records.into_iter().enumerate() {
            let result = parse_line_with_fingerprint(record, None, index as u64);
            assert_eq!(
                result.fingerprint.format_id,
                Some(expected_id),
                "record={record}"
            );
            assert_eq!(result.parsed.raw, record);
            assert!(!result.parsed.message.is_empty());
        }
    }

    #[test]
    fn syslog_detect() {
        let line = "<34>Oct 11 22:14:15 mymachine su: 'su root' failed";
        assert_eq!(detect_format(line, None), LogFormat::Syslog);
        let p = parse_line(line, Some(LogFormat::Syslog), 1);
        assert!(!p.message.is_empty());
    }

    #[test]
    fn zone_abbreviated_incomplete_time_auto_detects_but_stays_order_only() {
        let line = "2026-07-29T14:05,321 CET. INFO: synthetic scheduler initialized";
        assert_eq!(detect_format(line, None), LogFormat::Syslog);

        let parsed = parse_line(line, Some(LogFormat::Plain), 61);
        assert_eq!(parsed.format, LogFormat::Syslog);
        assert_eq!(parsed.ts, Some(61));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2026-07-29T14:05,321 CET")
        );
        assert_eq!(parsed.level, "info");
        assert_eq!(parsed.message, "synthetic scheduler initialized");
        assert_eq!(parsed.raw, line);
        assert_eq!(parsed.service, None);
        assert_eq!(parsed.host, None);
    }

    #[test]
    fn zone_abbreviated_incomplete_time_does_not_interpret_comma_or_zone() {
        let line = "2026-07-29T23:59,059 CEST. ERROR: synthetic request rejected";
        let parsed = parse_line(line, None, 62);

        assert_eq!(parsed.ts, Some(62));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2026-07-29T23:59,059 CEST")
        );
        assert_eq!(parsed.level, "error");
        assert_eq!(parsed.message, "synthetic request rejected");
        assert_eq!(parsed.raw, line);
    }

    #[test]
    fn zone_abbreviated_incomplete_time_near_matches_remain_whole() {
        let lines = [
            "2026-13-29T14:05,321 CET. INFO: impossible date",
            "2026-07-29T24:05,321 CET. INFO: impossible hour",
            "2026-07-29T14:60,321 CET. INFO: impossible minute",
            "2026-07-29T14:05:06,321 CET. INFO: seconds unexpectedly present",
            "2026-07-29T14:05,321 cet. INFO: lowercase zone is ambiguous",
            "2026-07-29T14:05,321 CET INFO: missing record delimiter",
            "2026-07-29T14:05,321 CET. NOTICE: unsupported severity",
            "INFO: payload mentions 2026-07-29T14:05,321 CET.",
            "\tat org.example.Worker.run(Worker.java:42)",
        ];

        for (index, line) in lines.into_iter().enumerate() {
            let ingest_seq = 970 + index as u64;
            let parsed = parse_line(line, Some(LogFormat::Plain), ingest_seq);
            assert_eq!(parsed.format, LogFormat::Plain, "line={line}");
            assert_eq!(parsed.ts, Some(ingest_seq as i64), "line={line}");
            assert_eq!(parsed.unresolved_local_timestamp, None, "line={line}");
            assert_eq!(parsed.message, line, "line={line}");
            assert_eq!(parsed.raw, line, "line={line}");
        }
    }

    #[test]
    fn elasticsearch_classic_record_auto_detects_and_preserves_normalized_fields() {
        let line =
            "[2026-07-29 14:05:06,324][INFO ][XYZ.logger   ] [XYZ-node] synthetic node initialized";
        assert_eq!(detect_format(line, None), LogFormat::Syslog);

        let parsed = parse_line(line, Some(LogFormat::Plain), 37);
        assert_eq!(parsed.format, LogFormat::Syslog);
        assert_eq!(parsed.ts, Some(37));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2026-07-29 14:05:06,324")
        );
        assert_eq!(parsed.level, "info");
        assert_eq!(parsed.service.as_deref(), Some("XYZ.logger"));
        assert_eq!(parsed.host.as_deref(), Some("XYZ-node"));
        assert_eq!(parsed.message, "synthetic node initialized");
        assert_eq!(parsed.raw, line);
    }

    #[test]
    fn bracketed_logger_optional_node_fingerprints_current_and_rotated_sources() {
        let with_node =
            "[2026-07-29 14:05:06,324][WARN ][XYZ.logger   ] [XYZ-node] synthetic pressure";
        for path in [Path::new("XYZ-service.log"), Path::new("XYZ-service.log.1")] {
            let result = parse_line_with_fingerprint(with_node, Some(path), 41);
            assert_eq!(
                result.fingerprint.format_id,
                Some("bracketed-timestamp-level-component-node-record")
            );
            assert_eq!(result.fingerprint.format_version, Some(2));
            assert_eq!(
                result.fingerprint.producer_hint,
                Some("elasticsearch-classic-family")
            );
            assert_eq!(
                result.fingerprint.decisive_clue_codes.as_ref(),
                ["content.bracketed_timestamp_level_component_node"]
            );
            assert_eq!(
                result.parsed.timestamp_provenance,
                TimestampProvenance::UnresolvedLocal
            );
            assert_eq!(
                result.parsed.unresolved_local_timestamp.as_deref(),
                Some("2026-07-29 14:05:06,324")
            );
            assert_eq!(result.parsed.level, "warn");
            assert_eq!(result.parsed.service.as_deref(), Some("XYZ.logger"));
            assert_eq!(result.parsed.host.as_deref(), Some("XYZ-node"));
            assert_eq!(result.parsed.message, "synthetic pressure");
        }

        let without_node =
            "[2026-07-29 14:05:07,004][ERROR][XYZ.logger] synthetic node unavailable";
        let parsed = parse_line(without_node, None, 42);
        assert_eq!(
            parsed.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(parsed.level, "error");
        assert_eq!(parsed.service.as_deref(), Some("XYZ.logger"));
        assert_eq!(parsed.host, None);
        assert_eq!(parsed.message, "synthetic node unavailable");
    }

    #[test]
    fn elasticsearch_dot_fraction_and_padded_fields_are_trimmed() {
        let line =
            "[2026-07-29 14:05:07.004][WARN ][cluster.service ][node-b.example  ] synthetic queue pressure";
        let parsed = parse_line(line, None, 38);

        assert_eq!(parsed.ts, Some(38));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2026-07-29 14:05:07.004")
        );
        assert_eq!(parsed.level, "warn");
        assert_eq!(parsed.service.as_deref(), Some("cluster.service"));
        assert_eq!(parsed.host.as_deref(), Some("node-b.example"));
        assert_eq!(parsed.message, "synthetic queue pressure");
        assert_eq!(parsed.raw, line);
    }

    #[test]
    fn elasticsearch_explicit_offsets_normalize_to_the_same_unix_second() {
        let lines = [
            "[2025-01-01 13:20:00,999Z][INFO][node][fixture-a.example] shared-z",
            "[2025-01-01T14:20:00.250+01:00][WARN][node][fixture-b.example] shared-plus",
            "[2025-01-01 08:20:00,001-0500][ERROR][node][fixture-c.example] shared-minus",
        ];

        for line in lines {
            let parsed = parse_line(line, Some(LogFormat::Plain), 9999);
            assert_eq!(parsed.format, LogFormat::Syslog, "line={line}");
            assert_eq!(parsed.ts, Some(SHARED_INSTANT_SECS), "line={line}");
            assert_eq!(parsed.unresolved_local_timestamp, None, "line={line}");
            assert_eq!(parsed.service.as_deref(), Some("node"));
            assert!(parsed
                .host
                .as_deref()
                .is_some_and(|host| host.ends_with(".example")));
            assert!(parsed.message.starts_with("shared-"));
            assert_eq!(parsed.raw, line);
        }
    }

    #[test]
    fn elasticsearch_malformed_brackets_and_continuations_remain_whole() {
        let lines = [
            "[2026-13-29 14:05:06,324][INFO][node][fixture.example] impossible month",
            "[2026-07-29 14:05:06,32][INFO][node][fixture.example] short fraction",
            "[2026-07-29 14:05:06,324][NOTICE][node][fixture.example] unsupported level",
            "[2026-07-29 14:05:06,324][INFO][][fixture.example] empty component",
            "[2026-07-29 14:05:06,324][INFO][node]missing payload separator",
            "[2026-07-29 14:05:06,324][INFO][node][] empty explicit node",
            "[2026-07-29 14:05:06,324][INFO][node][fixture.example]",
            "[node][INFO] ordinary bracketed payload",
            "\tat org.example.Worker.run(Worker.java:42)",
        ];

        for (index, line) in lines.into_iter().enumerate() {
            let ingest_seq = 900 + index as u64;
            let parsed = parse_line(line, Some(LogFormat::Plain), ingest_seq);
            assert_eq!(parsed.format, LogFormat::Plain, "line={line}");
            assert_eq!(parsed.ts, Some(ingest_seq as i64), "line={line}");
            assert_eq!(parsed.unresolved_local_timestamp, None, "line={line}");
            assert_eq!(parsed.message, line, "line={line}");
            assert_eq!(parsed.raw, line, "line={line}");
        }
    }

    #[test]
    fn wildfly_offsetless_prefixes_preserve_structure_and_stay_order_only() {
        let cases = [
            (
                "2026-07-29 09:14:05,123 INFO  [org.example.Startup] (ServerService Thread Pool -- 7) deployment ready",
                41,
                "info",
                "[org.example.Startup] (ServerService Thread Pool -- 7) deployment ready",
            ),
            (
                "2026-07-29 09:14:06.004 WARN [org.example.Queue] (default task-2) queue nearing capacity",
                42,
                "warn",
                "[org.example.Queue] (default task-2) queue nearing capacity",
            ),
            (
                "2026-07-29 09:14:07,999 ERROR [org.example.Worker] (default task-3) request failed",
                43,
                "error",
                "[org.example.Worker] (default task-3) request failed",
            ),
            (
                "2026-07-29 09:14:08,654 ERROR [org.jboss.remoting.remote.connection] (webworker I/O-175) JBREM000200: Remote connection failed: java.io.IOException: synthetic peer reset",
                44,
                "error",
                "[org.jboss.remoting.remote.connection] (webworker I/O-175) JBREM000200: Remote connection failed: java.io.IOException: synthetic peer reset",
            ),
        ];

        for (line, ingest_seq, level, message) in cases {
            assert_eq!(detect_format(line, None), LogFormat::Syslog);
            let parsed = parse_line(line, None, ingest_seq);
            assert_eq!(parsed.format, LogFormat::Syslog);
            assert_eq!(parsed.ts, Some(ingest_seq as i64), "line={line}");
            assert_eq!(
                parsed.unresolved_local_timestamp.as_deref(),
                line.get(..23),
                "validated local calendar evidence should be exposed without becoming an instant"
            );
            assert_eq!(parsed.level, level);
            assert_eq!(parsed.message, message);
            assert_eq!(parsed.raw, line);
        }
    }

    #[test]
    fn wildfly_recognition_is_not_blocked_by_a_file_level_plain_hint() {
        let line = "2026-07-29 09:14:05,123 INFO [org.example.Startup] (main) deployment ready";
        let parsed = parse_line(line, Some(LogFormat::Plain), 75);
        assert_eq!(parsed.format, LogFormat::Syslog);
        assert_eq!(parsed.ts, Some(75));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2026-07-29 09:14:05,123")
        );
        assert_eq!(
            parsed.message,
            "[org.example.Startup] (main) deployment ready"
        );
    }

    #[test]
    fn datetime_message_variants_preserve_time_evidence_and_clean_payloads() {
        let cases = [
            (
                "2026-07-29 09:14:05,123 INFO  - service registered",
                "info",
                "service registered",
                "2026-07-29 09:14:05,123",
            ),
            (
                "2026-07-29T09:14:06.004321 [DEBUG] command completed",
                "debug",
                "command completed",
                "2026-07-29T09:14:06.004321",
            ),
            (
                "2026-07-29 09:14:07 INFO  service started",
                "info",
                "service started",
                "2026-07-29 09:14:07",
            ),
            (
                "2026-07-29 09:14:08  CORE_INFO-0003: configuration loaded",
                "info",
                "CORE_INFO-0003: configuration loaded",
                "2026-07-29 09:14:08",
            ),
            (
                "2026-07-29 09:14:09.12 NOTICE: maintenance scheduled",
                "notice",
                "maintenance scheduled",
                "2026-07-29 09:14:09.12",
            ),
            (
                "2026-07-29 09:14:10 CRITICAL -1 retries remaining",
                "critical",
                "-1 retries remaining",
                "2026-07-29 09:14:10",
            ),
            (
                "2026-07-29 09:14:11 INFO --flag rejected",
                "info",
                "--flag rejected",
                "2026-07-29 09:14:11",
            ),
            (
                "2026-07-29 09:14:11,883 WARN  INDEXER generation: ambiguous name \"Column Count\" of \"001x_field\" in partition \"Primary\". Column will be named \"Column Count(001x_field)\".",
                "warn",
                "INDEXER generation: ambiguous name \"Column Count\" of \"001x_field\" in partition \"Primary\". Column will be named \"Column Count(001x_field)\".",
                "2026-07-29 09:14:11,883",
            ),
            (
                "2026-07-29T09:14:12.125 INFO processing item [5] (retry)",
                "info",
                "processing item [5] (retry)",
                "2026-07-29T09:14:12.125",
            ),
        ];

        for (index, (line, level, message, local_timestamp)) in cases.into_iter().enumerate() {
            let parsed = parse_line_with_fingerprint(line, None, 100 + index as u64);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("datetime-message-record"),
                "line={line}"
            );
            assert_eq!(parsed.parsed.format, LogFormat::Syslog, "line={line}");
            assert_eq!(parsed.parsed.level, level, "line={line}");
            assert_eq!(parsed.parsed.message, message, "line={line}");
            assert_eq!(parsed.parsed.raw, line, "line={line}");
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::UnresolvedLocal,
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp.as_deref(),
                Some(local_timestamp),
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.active_timestamp_basis,
                ActiveTimestampBasis::OrderOnly,
                "line={line}"
            );
        }
    }

    #[test]
    fn datetime_message_requires_valid_time_and_unambiguous_separator() {
        let lines = [
            "2026-13-29 09:14:05,123 INFO - impossible month",
            "2026-07-29 25:14:05 INFO - impossible hour",
            "2026-07-29 09:14:05,1234567890 INFO - overlong fraction",
            "2026-07-29 09:14:05 single-space-message",
            "call 2026-07-29T09:14:05.123 at extension 555-0100",
            "2026-07-29T09:14:61.123 impossible second",
            "2026-07-29 09:14:05 extension 555-0100",
        ];

        for (index, line) in lines.into_iter().enumerate() {
            let parsed = parse_line_with_fingerprint(line, None, 200 + index as u64);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("plain-line"),
                "line={line}"
            );
            assert_eq!(parsed.parsed.format, LogFormat::Plain, "line={line}");
            assert_eq!(parsed.parsed.message, line, "line={line}");
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp, None,
                "line={line}"
            );
        }
    }

    #[test]
    fn strong_iso_or_fractional_local_prefix_accepts_one_space_without_a_level() {
        let cases = [
            (
                "2026-07-29T09:14:05.123 connection established",
                "2026-07-29T09:14:05.123",
                "connection established",
            ),
            (
                "2026-07-29T09:14:06,12 worker heartbeat",
                "2026-07-29T09:14:06,12",
                "worker heartbeat",
            ),
            (
                "2026-07-29 09:14:07.004 query completed",
                "2026-07-29 09:14:07.004",
                "query completed",
            ),
            (
                "2026-07-29T09:14:08 service started",
                "2026-07-29T09:14:08",
                "service started",
            ),
        ];

        for (index, (line, source_timestamp, message)) in cases.into_iter().enumerate() {
            let parsed = parse_line_with_fingerprint(line, None, 600 + index as u64);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("datetime-message-record"),
                "line={line}"
            );
            assert_eq!(parsed.parsed.message, message, "line={line}");
            assert_eq!(parsed.parsed.raw, line, "line={line}");
            assert_eq!(parsed.parsed.level, "unknown", "line={line}");
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp.as_deref(),
                Some(source_timestamp),
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::UnresolvedLocal,
                "line={line}"
            );
        }
    }

    #[test]
    fn datetime_message_explicit_zones_are_wall_clock_and_never_redeclared() {
        let cases = [
            (
                "2025-01-01 13:20:00 GMT LOG: database ready",
                "log",
                "database ready",
            ),
            ("2025-01-01 13:20:00  UTC INFO ready", "info", "ready"),
            (
                "2025-01-01T14:20:00.25 +01:00 WARN offset ready",
                "warn",
                "offset ready",
            ),
        ];

        for (line, level, message) in cases {
            let parsed = parse_line_with_fingerprint(line, None, 999);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("datetime-message-record")
            );
            assert_eq!(parsed.parsed.ts, Some(SHARED_INSTANT_SECS), "line={line}");
            assert_eq!(parsed.parsed.level, level, "line={line}");
            assert_eq!(parsed.parsed.message, message, "line={line}");
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::ExplicitWallClock,
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp, None,
                "line={line}"
            );
        }
    }

    #[test]
    fn complete_datetime_with_ambiguous_zone_extracts_fields_without_guessing_an_instant() {
        let cases = [
            (
                "2021-03-03T00:00:04,334 CET INFO: cached condition evaluated",
                "2021-03-03T00:00:04,334 CET",
                "info",
                "cached condition evaluated",
            ),
            (
                "2025-06-15 12:13:14.25  EST [WARNING] - queue delayed",
                "2025-06-15 12:13:14.25  EST",
                "warn",
                "queue delayed",
            ),
            (
                "2025-12-15T23:59:59 CEST ERROR: request rejected",
                "2025-12-15T23:59:59 CEST",
                "error",
                "request rejected",
            ),
            (
                "2025-12-15T23:59:58,125 CET FINEST: cache probe completed",
                "2025-12-15T23:59:58,125 CET",
                "debug",
                "cache probe completed",
            ),
            (
                "2025-12-15 23:59:57.5 CET CONFIG: listener configured",
                "2025-12-15 23:59:57.5 CET",
                "info",
                "listener configured",
            ),
        ];

        for (index, (line, source_timestamp, level, message)) in cases.into_iter().enumerate() {
            let parsed = parse_line_with_fingerprint(line, None, 400 + index as u64);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("datetime-zone-abbreviation-level-record"),
                "line={line}"
            );
            assert_eq!(parsed.parsed.level, level, "line={line}");
            assert_eq!(parsed.parsed.message, message, "line={line}");
            assert_eq!(parsed.parsed.raw, line, "line={line}");
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::UnresolvedLocal,
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.active_timestamp_basis,
                ActiveTimestampBasis::OrderOnly,
                "line={line}"
            );
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp.as_deref(),
                Some(source_timestamp),
                "line={line}"
            );
        }
    }

    #[test]
    fn complete_datetime_zone_near_matches_remain_whole_line_fallbacks() {
        let lines = [
            "2021-13-03T00:00:04,334 CET INFO: impossible date",
            "2021-03-03T24:00:04,334 CET INFO: impossible hour",
            "2021-03-03T00:00:61,334 CET INFO: impossible second",
            "2021-03-03T00:00:04,334 XYZ INFO: unknown zone",
            "2021-03-03T00:00:04,334 cet INFO: lowercase zone",
            "2021-03-03T00:00:04,334 CET UNKNOWN: unknown level",
            "prefix 2021-03-03T00:00:04,334 CET INFO: embedded timestamp",
        ];

        for (index, line) in lines.into_iter().enumerate() {
            let parsed = parse_line_with_fingerprint(line, None, 500 + index as u64);
            assert_eq!(
                parsed.fingerprint.format_id,
                Some("plain-line"),
                "line={line}"
            );
            assert_eq!(parsed.parsed.format, LogFormat::Plain, "line={line}");
            assert_eq!(parsed.parsed.message, line, "line={line}");
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp, None,
                "line={line}"
            );
        }
    }

    #[test]
    fn generic_datetime_does_not_override_an_explicit_coarse_format_hint() {
        let line = "2026-07-29 09:14:05 INFO service ready";
        let parsed = parse_line(line, Some(LogFormat::Plain), 301);
        assert_eq!(parsed.format, LogFormat::Plain);
        assert_eq!(parsed.message, line);
        assert_eq!(parsed.unresolved_local_timestamp, None);
    }

    #[test]
    fn specialized_wildfly_grammar_keeps_precedence_over_generic_local_datetime() {
        let line = "2026-07-29 09:14:05,123 INFO [org.example.Startup] (main) ready";
        let parsed = parse_line_with_fingerprint(line, None, 300);
        assert_eq!(
            parsed.fingerprint.format_id,
            Some("date-level-logger-thread-record")
        );
        assert_eq!(parsed.parsed.message, "[org.example.Startup] (main) ready");
    }

    #[test]
    fn wildfly_explicit_offsets_normalize_to_the_same_unix_second() {
        let lines = [
            "2025-01-01 13:20:00,999Z INFO [org.example.Clock] (main) shared-z",
            "2025-01-01 14:20:00.250+01:00 WARN [org.example.Clock] (main) shared-plus-colon",
            "2025-01-01 08:20:00,001-0500 ERROR [org.example.Clock] (main) shared-minus-compact",
            "2025-01-01 14:20:00.777 +0100 INFO [org.example.Clock] (main) shared-spaced-offset",
        ];

        for line in lines {
            let parsed = parse_line(line, None, 9999);
            assert_eq!(parsed.format, LogFormat::Syslog, "line={line}");
            assert_eq!(parsed.ts, Some(SHARED_INSTANT_SECS), "line={line}");
            assert_eq!(parsed.unresolved_local_timestamp, None, "line={line}");
            assert_eq!(parsed.raw, line);
            assert!(parsed.message.contains("[org.example.Clock]"));
            assert!(parsed.message.contains("(main)"));
            assert!(parsed.message.contains("shared-"));
        }
    }

    #[test]
    fn wildfly_malformed_and_timestamp_like_payloads_do_not_false_parse_or_drop() {
        let lines = [
            "2026-13-29 09:14:05,123 INFO [org.example.BadDate] (main) impossible month",
            "2026-07-29 09:14:05,12 INFO [org.example.ShortFraction] (main) malformed fraction",
            "2026-07-29 09:14:05.1234 INFO [org.example.LongFraction] (main) malformed fraction",
            "2026-07-29 09:14:05,123 CUSTOMLEVEL [org.example.Level] (main) unsupported level",
            "2026-07-29 09:14:05,123 INFO org.example.Logger] (main) missing bracket",
            "2026-07-29 09:14:05,123 INFO [org.example.Logger (main) missing bracket",
            "INFO [org.example.Payload] (main) observed 2026-07-29 09:14:05,123 in a message",
        ];

        for (index, line) in lines.into_iter().enumerate() {
            let ingest_seq = 800 + index as u64;
            let parsed = parse_line(line, None, ingest_seq);
            assert_eq!(parsed.ts, Some(ingest_seq as i64), "line={line}");
            assert_eq!(parsed.raw, line);
            assert_eq!(parsed.message, line, "malformed line must remain whole");
            assert_eq!(parsed.format, LogFormat::Plain);
            assert_eq!(parsed.unresolved_local_timestamp, None);
        }
    }

    #[test]
    fn wildfly_stack_trace_continuations_remain_complete_and_in_order() {
        let records = [
            "2026-07-29 09:14:07,999 ERROR [org.example.Worker] (default task-3) request failed",
            "java.lang.IllegalStateException: synthetic failure",
            "\tat org.example.Worker.run(Worker.java:42)",
            "Caused by: java.io.IOException: synthetic downstream failure",
        ];

        let parsed = records
            .iter()
            .enumerate()
            .map(|(index, line)| parse_line(line, Some(LogFormat::Syslog), 500 + index as u64))
            .collect::<Vec<_>>();

        assert_eq!(parsed[0].level, "error");
        assert_eq!(
            parsed[0].message,
            "[org.example.Worker] (default task-3) request failed"
        );
        for (index, continuation) in parsed.iter().enumerate().skip(1) {
            assert_eq!(continuation.format, LogFormat::Plain);
            assert_eq!(continuation.ts, Some(500 + index as i64));
            assert_eq!(continuation.message, records[index]);
            assert_eq!(continuation.raw, records[index]);
            assert_eq!(continuation.unresolved_local_timestamp, None);
        }
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
    #[test]
    fn yyyymmdd_integer_is_not_a_unix_epoch() {
        assert_eq!(decode_unix_epoch_to_secs_i64(20_250_615), None);
        let line = r#"{"ts":20250615,"level":"info","message":"ambiguous yyyymmdd"}"#;
        let p = parse_line(line, Some(LogFormat::Json), 9);
        assert_eq!(p.timestamp_provenance, TimestampProvenance::OrderOnly);
        assert_eq!(p.ts, Some(9));
    }

    #[test]
    fn span_id_and_request_id_are_not_trace_ids() {
        let span_only = r#"{"ts":"2025-06-15T12:30:00Z","level":"info","span_id":"00f067aa0ba902b7","message":"span without trace"}"#;
        let p = parse_line(span_only, Some(LogFormat::Json), 0);
        assert_eq!(p.trace_id, None);
        let req = r#"{"ts":"2025-06-15T12:30:02Z","level":"info","request_id":"req-7f3a","message":"request id only"}"#;
        let p = parse_line(req, Some(LogFormat::Json), 0);
        assert_eq!(p.trace_id, None);
        let both = r#"{"ts":"2025-06-15T12:30:01Z","level":"info","trace_id":"abc","span_id":"def","message":"both"}"#;
        let p = parse_line(both, Some(LogFormat::Json), 0);
        assert_eq!(p.trace_id.as_deref(), Some("abc"));
    }

    #[test]
    fn postgres_jsonlog_error_severity_and_conflicting_level_field() {
        let line = r#"{"timestamp":"2025-06-15 12:20:05.250 UTC","error_severity":"ERROR","level":"info","message":"duplicate key value violates"}"#;
        let p = parse_line(line, Some(LogFormat::Json), 0);
        assert_eq!(
            p.level, "error",
            "error_severity must win over generic level"
        );
    }

    #[test]
    fn postgres_stderr_log_severity_token() {
        let line = "2025-06-15 12:00:02.001 UTC [1042] LOG:  checkpoint starting: time";
        let p = parse_line(line, None, 0);
        assert_eq!(p.level, "log");
    }

    #[test]
    fn duplicate_json_ts_key_first_wins() {
        let line = r#"{"ts":"2025-06-15T14:10:02Z","ts":"2025-06-15T23:59:59Z","level":"info","message":"duplicate keys"}"#;
        let p = parse_line(line, Some(LogFormat::Json), 0);
        assert_eq!(p.ts, Some(1_749_996_602));
    }

    #[test]
    fn trace_and_critical_levels_are_preserved() {
        assert_eq!(normalize_level("TRACE"), "trace");
        assert_eq!(normalize_level("CRITICAL"), "critical");
        assert_ne!(normalize_level("TRACE"), normalize_level("DEBUG"));
        assert_ne!(normalize_level("CRITICAL"), normalize_level("FATAL"));
    }

    #[test]
    fn json_calendar_and_epoch_are_never_confused() {
        // Three shapes that all "look like a time" and must land in three
        // different places. Confusing any pair fabricates calendar time.
        let epoch = parse_line(r#"{"ts":1749988800,"message":"epoch"}"#, None, 0);
        assert_eq!(
            epoch.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(epoch.ts, Some(1_749_988_800));

        let calendar = parse_line(
            r#"{"ts":"Sun Jun 15 12:00:00 2025","message":"ctime"}"#,
            None,
            5,
        );
        assert_eq!(
            calendar.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(calendar.ts, Some(5), "ctime text is not an instant");
        assert_eq!(
            calendar.unresolved_local_timestamp.as_deref(),
            Some("Sun Jun 15 12:00:00 2025")
        );

        // A date-shaped integer is neither: not an epoch, not calendar evidence.
        let datelike = parse_line(r#"{"ts":20250615,"message":"yyyymmdd"}"#, None, 9);
        assert_eq!(
            datelike.timestamp_provenance,
            TimestampProvenance::OrderOnly
        );
        assert_eq!(datelike.ts, Some(9));
        assert_eq!(datelike.unresolved_local_timestamp, None);
    }

    #[test]
    fn envelope_severity_never_overwrites_an_envelope_that_stated_one() {
        // #791's hard rule: the payload may fill a gap, never overrule the
        // transport. Outer says info, inner says fatal — outer wins.
        let line = r#"{"log":"{\"level\":60,\"msg\":\"inner\"}","stream":"stdout","time":"2025-06-15T16:00:00Z","level":"info"}"#;
        let parsed = parse_line(line, None, 0);
        assert_eq!(parsed.level, "info", "inner payload overruled the envelope");
    }

    #[test]
    fn envelope_timestamp_survives_inner_payload_interpretation() {
        // The inner record carries its own, different time. Container time is
        // authoritative and must not move.
        let line = r#"{"log":"{\"level\":50,\"time\":1000000000,\"msg\":\"inner\"}","stream":"stdout","time":"2025-06-15T16:00:00Z"}"#;
        let parsed = parse_line(line, None, 0);
        assert_eq!(parsed.level, "error", "inner severity should fill the gap");
        assert_eq!(
            parsed.ts,
            Some(1_750_003_200),
            "container time must remain authoritative"
        );
        assert_eq!(
            parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
    }

    #[test]
    fn self_referential_payload_is_not_walked() {
        // A payload identical to its own envelope must terminate immediately.
        // The payload must carry a severity, or this proves nothing: without a
        // severity the walk returns None anyway and the guard is untested.
        let envelope = r#"{"level":"fatal","log":"self","stream":"stdout"}"#;
        assert_eq!(
            inner_payload_severity(envelope, envelope),
            None,
            "a payload identical to its own envelope must not be walked"
        );
        // Same text, different envelope: now a legitimate payload whose severity
        // is read, so the guard turns on identity and nothing else.
        assert_eq!(
            inner_payload_severity(envelope, "a different envelope"),
            Some("fatal".to_string())
        );
        // Repeated identical payloads are still each read once, cheaply.
        let payload = r#"{"level":40,"msg":"repeat"}"#;
        for _ in 0..1000 {
            assert_eq!(
                inner_payload_severity(payload, "outer"),
                Some("warn".to_string())
            );
        }
    }

    #[test]
    fn oversized_payload_is_not_decoded() {
        let big = format!(
            "{{\"level\":\"error\",\"pad\":\"{}\"}}",
            "x".repeat(MAX_INNER_PAYLOAD_BYTES)
        );
        assert_eq!(
            inner_payload_severity(&big, "outer"),
            None,
            "an oversized payload must be skipped, not decoded"
        );
    }

    #[test]
    fn cef_severity_bands_and_malformed_headers() {
        let cef = |sev: &str| format!("CEF:0|Example|Gateway|1.0|100|blocked|{sev}|src=192.0.2.9");
        assert_eq!(cef_severity_level(&cef("0")).as_deref(), Some("info"));
        assert_eq!(cef_severity_level(&cef("3")).as_deref(), Some("info"));
        assert_eq!(cef_severity_level(&cef("4")).as_deref(), Some("warn"));
        assert_eq!(cef_severity_level(&cef("5")).as_deref(), Some("warn"));
        assert_eq!(cef_severity_level(&cef("7")).as_deref(), Some("error"));
        assert_eq!(cef_severity_level(&cef("10")).as_deref(), Some("fatal"));
        assert_eq!(cef_severity_level(&cef("Medium")).as_deref(), Some("warn"));

        // Malformed: out of scale, non-numeric, too few header fields, no prefix.
        for bad in [
            cef("11"),
            cef("-1"),
            cef("banana"),
            "CEF:0|Example|Gateway|1.0|100|blocked".to_string(),
            "CEF:0".to_string(),
            "not cef at all".to_string(),
        ] {
            assert_eq!(
                cef_severity_level(&bad),
                None,
                "accepted malformed CEF: {bad}"
            );
        }

        // An escaped pipe inside a header field must not shift the severity
        // column — that would read the wrong field as severity.
        let escaped = r"CEF:0|Ex\|ample|Gateway|1.0|100|blocked|9|src=192.0.2.9";
        assert_eq!(cef_severity_level(escaped).as_deref(), Some("fatal"));
    }

    #[test]
    fn malformed_inner_payload_falls_back_safely() {
        // Truncated JSON, a bare array, and plain text all yield no severity
        // rather than a wrong one or a panic.
        for payload in [
            "{\"level\":\"error\"",
            "[]",
            "just some text",
            "",
            "   ",
            "{}",
        ] {
            assert_eq!(
                inner_payload_severity(payload, "outer"),
                None,
                "payload {payload:?} produced a severity it should not have"
            );
        }
        // The envelope still parses and keeps its own behavior.
        let line = r#"{"log":"not json at all","stream":"stdout","time":"2025-06-15T16:00:00Z"}"#;
        let parsed = parse_line(line, None, 0);
        assert_eq!(parsed.level, "unknown");
        assert_eq!(parsed.ts, Some(1_750_003_200));
    }

    #[test]
    fn unambiguous_utc_suffix_is_an_instant() {
        // `%m` / jsonlog `timestamp`: `YYYY-MM-DD HH:MM:SS.mmm UTC`.
        assert_eq!(
            parse_timestamp_text("2025-06-15 12:00:00.123 UTC"),
            ParsedTimestamp::ExplicitWallClock(1_749_988_800),
            "UTC names exactly one instant"
        );
        // Fractional seconds are truncated to whole seconds, like every other path.
        assert_eq!(
            parse_timestamp_text("2025-06-15 12:00:00 GMT"),
            ParsedTimestamp::ExplicitWallClock(1_749_988_800)
        );
    }

    #[test]
    fn ambiguous_zone_suffix_is_evidence_not_an_instant() {
        // CST is North American or Chinese. Retained, never resolved — and the
        // retained text is the calendar portion only, without the zone token.
        assert_eq!(
            parse_timestamp_text("2025-06-15 08:05:10.004 CST"),
            ParsedTimestamp::UnresolvedLocal("2025-06-15 08:05:10.004".to_string())
        );
        for zone in ["IST", "BST", "EDT", "JST", "AEST"] {
            let probe = format!("2025-06-15 08:05:10 {zone}");
            assert!(
                matches!(
                    parse_timestamp_text(&probe),
                    ParsedTimestamp::UnresolvedLocal(_)
                ),
                "{zone} must not resolve to an instant"
            );
        }
    }

    #[test]
    fn fabricated_timezone_suffixes_are_rejected() {
        // Adversarial: a trailing word that merely looks like a zone must not
        // license an instant, and must not license evidence either — otherwise
        // any message beginning with a date becomes a timestamp.
        for probe in [
            "2025-06-15 12:00:00.123 NOTAZONE",
            "2025-06-15 12:00:00.123 UTCX",
            "2025-06-15 12:00:00.123 XUTC",
            "2025-06-15 12:00:00.123 UTC extra",
            "2025-06-15 12:00:00.123 utc_",
            "2025-06-15 12:00:00.123 00",
        ] {
            assert_eq!(
                parse_timestamp_text(probe),
                ParsedTimestamp::Unusable,
                "fabricated suffix accepted: {probe:?}"
            );
        }
    }

    #[test]
    fn explicit_offsets_still_win_over_the_suffix_path() {
        // The new zone-suffix branch runs only after RFC3339 fails, so an
        // explicit offset remains authoritative.
        assert_eq!(
            parse_timestamp_text("2025-06-15T12:00:00Z"),
            ParsedTimestamp::ExplicitWallClock(1_749_988_800)
        );
        assert_eq!(
            parse_timestamp_text("2025-06-15T17:30:00+05:30"),
            ParsedTimestamp::ExplicitWallClock(1_749_988_800)
        );
    }

    #[test]
    fn ctime_calendar_is_evidence_never_an_instant() {
        assert_eq!(
            parse_timestamp_text("Sun Jun 15 12:00:00 2025"),
            ParsedTimestamp::UnresolvedLocal("Sun Jun 15 12:00:00 2025".to_string())
        );
        // A malformed calendar string stays unusable rather than half-parsed.
        assert_eq!(
            parse_timestamp_text("Sun Jun 32 12:00:00 2025"),
            ParsedTimestamp::Unusable
        );
        assert_eq!(
            parse_timestamp_text("Sun Jun 15 2025"),
            ParsedTimestamp::Unusable
        );
    }

    #[test]
    fn postgres_stderr_utc_and_ambiguous_prefixes() {
        let utc = parse_line(
            "2025-06-15 12:00:00.123 UTC [1042] LOG:  database system is ready to accept connections",
            None,
            0,
        );
        assert_eq!(
            utc.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(utc.ts, Some(1_749_988_800));
        assert_eq!(utc.level, "log");

        let ambiguous = parse_line(
            "2025-06-15 08:05:10.004 CST [3001] WARNING:  there is already a transaction in progress",
            None,
            7,
        );
        assert_eq!(
            ambiguous.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            ambiguous.active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly,
            "an ambiguous zone must never present as calendar time"
        );
        assert_eq!(
            ambiguous.unresolved_local_timestamp.as_deref(),
            Some("2025-06-15 08:05:10.004")
        );
        assert_eq!(ambiguous.ts, Some(7), "ts stays the ingest position");
    }
}
