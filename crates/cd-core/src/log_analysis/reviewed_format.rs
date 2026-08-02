//! `contextdesk.reviewed_format.v1` — a bounded, user-reviewable grammar for
//! raw log lines that the built-in registry does not recognize.
//!
//! # Where this sits
//!
//! Three layers already exist and this fills the gap between two of them:
//!
//! * [`super::format_profile`] — fixed built-in grammars, content-matched. A
//!   user cannot add one.
//! * **This module** — a declarative grammar a user can define, preview, and
//!   confirm for their own log shape.
//! * [`super::import_profile`] — the plan that will bind sources to grammars.
//!   Its `SourceGroupRule::format_profile` is the intended [`ProfileRef`] seam,
//!   but that linkage is not wired yet: today it resolves only built-in content
//!   fingerprints and a reviewed-format reference reports drift. This module
//!   defines the grammar beside that seam; it does not create a parallel import
//!   system or claim the existing one already consumes it.
//!
//! # Why not regexes
//!
//! #751 lists catastrophic regex as an adversarial case to defend against, and
//! a user-supplied pattern cannot be accepted safely without a complexity
//! analysis this project does not have. A reviewed format is therefore built
//! from a **fixed token vocabulary** ([`TimeToken`], [`FieldSlot`]) whose
//! matcher is a single left-to-right scan with no backtracking. The cost of a
//! match is bounded by the line length before the grammar is ever seen.
//!
//! Path matching reuses [`super::import_profile::SafePattern`], the bounded
//! glob already shipped and already proven linear — rolled files
//! (`app.log`, `app.log.2024-05-03`) share one profile through one pattern
//! rather than through a second matching engine.
//!
//! # What a reviewed format may never do
//!
//! * **Invent a timezone.** A grammar without an offset token yields
//!   [`TimestampProvenance::UnresolvedLocal`] and the calendar text is kept as
//!   *evidence*, never converted. Resolution happens later, once, through the
//!   shipped reviewed-declaration path
//!   ([`super::timezone_application::apply_source_timezones`]). A profile may
//!   carry a *suggestion*; [`ReviewedFormat::suggested_timezone`] is inert
//!   until a human accepts it.
//! * **Take effect unreviewed.** [`preview_reviewed_format`] renders what the
//!   grammar would do to real lines; nothing applies until a caller confirms.
//! * **Match by name alone.** A path pattern narrows *candidates*; the grammar
//!   must still match the line's content, so a profile cannot claim an
//!   unrelated file that merely shares a naming convention.

use serde::{Deserialize, Serialize};

use super::import_profile::SafePattern;
use super::parse::TimestampProvenance;

/// Schema identifier every reviewed format declares.
pub const REVIEWED_FORMAT_SCHEMA_ID: &str = "contextdesk.reviewed_format.v1";

/// Highest schema version this build can read.
pub const REVIEWED_FORMAT_READER_VERSION: u32 = 1;

/// Maximum tokens in a timestamp grammar.
pub const MAX_TIMESTAMP_TOKENS: usize = 24;

/// Maximum slots in a line layout.
pub const MAX_LAYOUT_SLOTS: usize = 16;

/// Maximum path patterns on one reviewed format.
pub const MAX_FORMAT_PATH_PATTERNS: usize = 32;

/// Maximum characters in an identifier field.
pub const MAX_FORMAT_ID_CHARS: usize = 128;

/// Maximum bytes of a line this grammar will attempt to match.
///
/// A line longer than this is not a parse failure — it is refused *before*
/// matching, so a pathological line cannot make matching expensive.
pub const MAX_MATCHABLE_LINE_BYTES: usize = 64 * 1024;

/// Maximum physical lines one logical (multiline) record may absorb.
pub const MAX_MULTILINE_LINES: usize = 512;

/// One element of a timestamp grammar.
///
/// A closed vocabulary: there is no "arbitrary pattern" variant, which is what
/// makes matching cost predictable. Each numeric token consumes an exact digit
/// count, so the scanner never has to guess how far a field extends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeToken {
    /// Four-digit year.
    Year4,
    /// Two-digit month.
    Month2,
    /// Two-digit day.
    Day2,
    /// Two-digit hour, 24-hour clock.
    Hour24,
    /// Two-digit minute.
    Minute2,
    /// Two-digit second.
    Second2,
    /// Three-digit milliseconds.
    Millis3,
    /// Six-digit microseconds.
    Micros6,
    /// An explicit numeric UTC offset (`+HH:MM`, `-HH:MM`, or `Z`).
    ///
    /// Presence of this token — and only this token — makes a grammar yield an
    /// explicit instant. Everything else is local calendar text.
    Offset,
    /// A literal separator character.
    Literal(char),
}

impl TimeToken {
    /// Digits this token consumes, or `None` for non-numeric tokens.
    fn digits(self) -> Option<usize> {
        Some(match self {
            TimeToken::Year4 => 4,
            TimeToken::Month2 | TimeToken::Day2 => 2,
            TimeToken::Hour24 | TimeToken::Minute2 | TimeToken::Second2 => 2,
            TimeToken::Millis3 => 3,
            TimeToken::Micros6 => 6,
            TimeToken::Offset | TimeToken::Literal(_) => return None,
        })
    }
}

/// An ordered timestamp grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampGrammar {
    /// Tokens in order.
    pub tokens: Vec<TimeToken>,
}

impl TimestampGrammar {
    /// Whether this grammar carries an explicit offset.
    pub fn has_offset(&self) -> bool {
        self.tokens.contains(&TimeToken::Offset)
    }

    /// The provenance a match through this grammar produces.
    ///
    /// This is the whole timezone-safety story in one function: without an
    /// offset token there is no instant, only calendar text.
    pub fn provenance(&self) -> TimestampProvenance {
        if self.has_offset() {
            TimestampProvenance::ExplicitWallClock
        } else {
            TimestampProvenance::UnresolvedLocal
        }
    }

    /// Match at the start of `line`, returning the consumed byte length.
    ///
    /// Single left-to-right pass, no backtracking: each token either consumes
    /// its exact width or the match fails immediately.
    pub fn match_prefix(&self, line: &str) -> Option<usize> {
        let bytes = line.as_bytes();
        let mut at = 0usize;
        let mut year = None;
        let mut month = None;
        let mut day = None;
        for token in &self.tokens {
            match token {
                TimeToken::Literal(expected) => {
                    let mut buffer = [0u8; 4];
                    let encoded = expected.encode_utf8(&mut buffer).as_bytes();
                    if bytes.len() < at + encoded.len() || &bytes[at..at + encoded.len()] != encoded
                    {
                        return None;
                    }
                    at += encoded.len();
                }
                TimeToken::Offset => {
                    if bytes.get(at) == Some(&b'Z') || bytes.get(at) == Some(&b'z') {
                        at += 1;
                        continue;
                    }
                    // +HH:MM / -HH:MM
                    if bytes.len() < at + 6 {
                        return None;
                    }
                    if bytes[at] != b'+' && bytes[at] != b'-' {
                        return None;
                    }
                    if !bytes[at + 1..at + 3].iter().all(u8::is_ascii_digit)
                        || bytes[at + 3] != b':'
                        || !bytes[at + 4..at + 6].iter().all(u8::is_ascii_digit)
                    {
                        return None;
                    }
                    // Digit shape is not an offset. Without these bounds
                    // `+99:99` matched and the grammar reported
                    // ExplicitWallClock — an impossible offset presented as a
                    // resolved instant.
                    let hours = (bytes[at + 1] - b'0') * 10 + (bytes[at + 2] - b'0');
                    let minutes = (bytes[at + 4] - b'0') * 10 + (bytes[at + 5] - b'0');
                    if hours > 23 || minutes > 59 {
                        return None;
                    }
                    at += 6;
                }
                numeric => {
                    let width = numeric.digits().unwrap_or(0);
                    if bytes.len() < at + width
                        || !bytes[at..at + width].iter().all(u8::is_ascii_digit)
                    {
                        return None;
                    }
                    let value = bytes[at..at + width]
                        .iter()
                        .fold(0u32, |value, digit| value * 10 + u32::from(*digit - b'0'));
                    match numeric {
                        TimeToken::Year4 => year = Some(value as i32),
                        TimeToken::Month2 if (1..=12).contains(&value) => month = Some(value),
                        TimeToken::Day2 if (1..=31).contains(&value) => day = Some(value),
                        TimeToken::Hour24 if value <= 23 => {}
                        TimeToken::Minute2 if value <= 59 => {}
                        // Permit the leap-second spelling accepted by the
                        // shipped timestamp parser; ordinary seconds stop at 59.
                        TimeToken::Second2 if value <= 60 => {}
                        TimeToken::Millis3 | TimeToken::Micros6 => {}
                        _ => return None,
                    }
                    at += width;
                }
            }
        }
        if let (Some(year), Some(month), Some(day)) = (year, month, day) {
            chrono::NaiveDate::from_ymd_opt(year, month, day)?;
        }
        Some(at)
    }
}

/// One slot in a line layout, applied left to right after the timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSlot {
    /// One or more spaces/tabs.
    Whitespace,
    /// A literal string.
    Literal(String),
    /// The severity token, up to the next whitespace.
    Level,
    /// A logger/component name delimited by the given open/close characters,
    /// or up to whitespace when no delimiters are given.
    Logger {
        /// Optional opening delimiter.
        open: Option<char>,
        /// Optional closing delimiter.
        close: Option<char>,
    },
    /// A thread name, same delimiting rules as [`FieldSlot::Logger`].
    Thread {
        /// Optional opening delimiter.
        open: Option<char>,
        /// Optional closing delimiter.
        close: Option<char>,
    },
    /// Everything remaining on the line. Must be last.
    Message,
}

/// How continuation lines are attributed to a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MultilineRule {
    /// Every physical line is its own record.
    None,
    /// A line that does not begin a new timestamp belongs to the record above.
    ///
    /// This is the rule that keeps a Java or Python traceback attached to the
    /// line that raised it. Ownership is decided by "does a NEW record start
    /// here", never by indentation — indentation is a convention, and a
    /// continuation that happens to be flush-left would otherwise split the
    /// record.
    ContinuationUntilNextTimestamp,
}

/// A reviewed, user-confirmable line grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormat {
    /// Must equal [`REVIEWED_FORMAT_SCHEMA_ID`].
    pub schema_id: String,
    /// Lowest reader version able to interpret this document.
    pub min_reader_version: u32,
    /// Stable grammar identity, referenced by
    /// [`super::import_profile::ProfileRef`].
    pub format_id: String,
    /// Monotonic version; editing produces a new version.
    pub version: u16,
    /// Human-readable name.
    pub name: String,
    /// Path patterns that make this format a *candidate*.
    ///
    /// Narrows candidates only — the grammar must still match the content.
    /// One pattern covers a rolled family (`app.log`, `app.log.2024-05-03`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path_patterns: Vec<SafePattern>,
    /// The timestamp grammar.
    pub timestamp: TimestampGrammar,
    /// Field layout after the timestamp.
    pub layout: Vec<FieldSlot>,
    /// Continuation handling.
    pub multiline: MultilineRule,
    /// Deterministic tie-break when several formats match one source.
    ///
    /// Higher wins. Equal priority is a *conflict*, reported for explicit
    /// choice rather than resolved by declaration order — #751 forbids
    /// guessing between competing profiles.
    pub priority: u16,
    /// A timezone the author believes applies. **Inert.**
    ///
    /// Recorded so a reviewer sees the author's belief; never applied. Only
    /// the reviewed-declaration path may resolve a timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_timezone: Option<String>,
}

/// Fields a successful match extracted from one line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFields {
    /// Timestamp text exactly as it appeared.
    pub timestamp_text: String,
    /// Provenance implied by the grammar.
    pub provenance: TimestampProvenance,
    /// Severity token, when the layout has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// Logger/component, when the layout has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    /// Thread, when the layout has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /// The message, with the timestamp and every other matched slot removed.
    pub message: String,
}

/// Stable validation codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewedFormatDiagnosticCode {
    /// `schemaId` is not [`REVIEWED_FORMAT_SCHEMA_ID`].
    SchemaIdInvalid,
    /// Document needs a newer reader.
    ReaderTooOld,
    /// An identifier is empty or over its bound.
    IdentifierInvalid,
    /// `version` is zero.
    VersionInvalid,
    /// The timestamp grammar is empty or over [`MAX_TIMESTAMP_TOKENS`].
    TimestampGrammarInvalid,
    /// The grammar has no date or no time-of-day component.
    TimestampGrammarIncomplete,
    /// The layout is empty or over [`MAX_LAYOUT_SLOTS`].
    LayoutInvalid,
    /// The layout has no message slot, or it is not last.
    MessageSlotMisplaced,
    /// The layout declares the same field twice.
    DuplicateFieldSlot,
    /// Too many path patterns, or one is malformed.
    PathPatternInvalid,
    /// `suggestedTimezone` is not a real IANA zone.
    SuggestedTimezoneInvalid,
}

/// One validation finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatDiagnostic {
    /// Stable code.
    pub code: ReviewedFormatDiagnosticCode,
    /// Dotted location within the document.
    pub location: String,
}

/// Result of validating a reviewed format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatValidation {
    /// True only when there are no diagnostics.
    pub valid: bool,
    /// All findings, sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ReviewedFormatDiagnostic>,
}

/// Validate a reviewed format document.
///
/// Fail-closed: any diagnostic makes it invalid, and an invalid format must
/// never be previewed or applied.
pub fn validate_reviewed_format(format: &ReviewedFormat) -> ReviewedFormatValidation {
    let mut diagnostics = Vec::new();
    let mut push = |code: ReviewedFormatDiagnosticCode, location: &str| {
        diagnostics.push(ReviewedFormatDiagnostic {
            code,
            location: location.to_string(),
        });
    };

    if format.schema_id != REVIEWED_FORMAT_SCHEMA_ID {
        push(ReviewedFormatDiagnosticCode::SchemaIdInvalid, "schemaId");
    }
    if format.min_reader_version == 0 || format.min_reader_version > REVIEWED_FORMAT_READER_VERSION
    {
        push(
            ReviewedFormatDiagnosticCode::ReaderTooOld,
            "minReaderVersion",
        );
    }
    for (value, location) in [(&format.format_id, "formatId"), (&format.name, "name")] {
        if value.trim().is_empty() || value.chars().count() > MAX_FORMAT_ID_CHARS {
            push(ReviewedFormatDiagnosticCode::IdentifierInvalid, location);
        }
    }
    if format.version == 0 {
        push(ReviewedFormatDiagnosticCode::VersionInvalid, "version");
    }

    if format.timestamp.tokens.is_empty() || format.timestamp.tokens.len() > MAX_TIMESTAMP_TOKENS {
        push(
            ReviewedFormatDiagnosticCode::TimestampGrammarInvalid,
            "timestamp.tokens",
        );
    } else {
        let count = |wanted: TimeToken| {
            format
                .timestamp
                .tokens
                .iter()
                .filter(|token| **token == wanted)
                .count()
        };
        // These five components are the minimum complete local calendar time.
        // An Offset token may prove where that complete value sits, but cannot
        // turn a partial `year + hour` grammar into an instant.
        if [
            TimeToken::Year4,
            TimeToken::Month2,
            TimeToken::Day2,
            TimeToken::Hour24,
            TimeToken::Minute2,
        ]
        .iter()
        .any(|token| count(*token) != 1)
        {
            push(
                ReviewedFormatDiagnosticCode::TimestampGrammarIncomplete,
                "timestamp.tokens",
            );
        }
        let seconds = count(TimeToken::Second2);
        let millis = count(TimeToken::Millis3);
        let micros = count(TimeToken::Micros6);
        let offsets = count(TimeToken::Offset);
        if seconds > 1
            || millis > 1
            || micros > 1
            || offsets > 1
            || (millis > 0 && micros > 0)
            || ((millis > 0 || micros > 0) && seconds != 1)
        {
            push(
                ReviewedFormatDiagnosticCode::TimestampGrammarInvalid,
                "timestamp.tokens",
            );
        }
    }

    if format.layout.is_empty() || format.layout.len() > MAX_LAYOUT_SLOTS {
        push(ReviewedFormatDiagnosticCode::LayoutInvalid, "layout");
    } else {
        let message_positions: Vec<usize> = format
            .layout
            .iter()
            .enumerate()
            .filter(|(_, slot)| matches!(slot, FieldSlot::Message))
            .map(|(index, _)| index)
            .collect();
        if message_positions.len() != 1 || message_positions[0] != format.layout.len() - 1 {
            push(ReviewedFormatDiagnosticCode::MessageSlotMisplaced, "layout");
        }
        for kind in ["level", "logger", "thread"] {
            let count = format
                .layout
                .iter()
                .filter(|slot| {
                    matches!(
                        (kind, slot),
                        ("level", FieldSlot::Level)
                            | ("logger", FieldSlot::Logger { .. })
                            | ("thread", FieldSlot::Thread { .. })
                    )
                })
                .count();
            if count > 1 {
                push(ReviewedFormatDiagnosticCode::DuplicateFieldSlot, "layout");
            }
        }
        for (index, slot) in format.layout.iter().enumerate() {
            let invalid = match slot {
                FieldSlot::Literal(value) => value.is_empty(),
                FieldSlot::Logger { open, close } | FieldSlot::Thread { open, close } => {
                    open.is_some() != close.is_some()
                }
                _ => false,
            };
            if invalid {
                push(
                    ReviewedFormatDiagnosticCode::LayoutInvalid,
                    &format!("layout[{index}]"),
                );
            }
        }
    }

    if format.path_patterns.len() > MAX_FORMAT_PATH_PATTERNS {
        push(
            ReviewedFormatDiagnosticCode::PathPatternInvalid,
            "pathPatterns",
        );
    }
    for (index, pattern) in format.path_patterns.iter().enumerate() {
        if !pattern.problems().is_empty() {
            push(
                ReviewedFormatDiagnosticCode::PathPatternInvalid,
                &format!("pathPatterns[{index}]"),
            );
        }
    }

    if let Some(zone) = &format.suggested_timezone {
        if zone.parse::<chrono_tz::Tz>().is_err() {
            push(
                ReviewedFormatDiagnosticCode::SuggestedTimezoneInvalid,
                "suggestedTimezone",
            );
        }
    }

    diagnostics.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then(left.code.cmp(&right.code))
    });
    diagnostics.dedup();
    ReviewedFormatValidation {
        valid: diagnostics.is_empty(),
        diagnostics,
    }
}

/// Consume a delimited or whitespace-terminated token.
fn take_token(rest: &str, open: Option<char>, close: Option<char>) -> Option<(String, usize)> {
    match (open, close) {
        (Some(open), Some(close)) => {
            let mut chars = rest.char_indices();
            let (_, first) = chars.next()?;
            if first != open {
                return None;
            }
            let start = open.len_utf8();
            let end = rest.get(start..)?.find(close)?;
            let value = rest.get(start..start + end)?.to_string();
            Some((value, start + end + close.len_utf8()))
        }
        _ => {
            let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            Some((rest.get(..end)?.to_string(), end))
        }
    }
}

/// Apply a grammar to one physical line.
///
/// Returns `None` when the line does not start a record under this grammar —
/// which is exactly the signal [`MultilineRule::ContinuationUntilNextTimestamp`]
/// uses to attribute a continuation line.
///
/// Refuses a line over [`MAX_MATCHABLE_LINE_BYTES`] before matching, so a
/// pathological line costs a length check rather than a scan.
pub fn match_line(format: &ReviewedFormat, line: &str) -> Option<ExtractedFields> {
    match match_line_outcome(format, line) {
        LineOutcome::Record(fields) => Some(*fields),
        LineOutcome::NotARecordStart | LineOutcome::TooLong => None,
    }
}

/// Why a line did or did not begin a record.
///
/// [`match_line`] collapses both failure modes to `None`, which suits a caller
/// that only wants fields. [`assemble_records`] must NOT collapse them: an
/// over-long line that would otherwise have started a record is not a
/// continuation of the record above, and treating it as one silently moved a
/// real record's text into an unrelated record's body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOutcome {
    /// The line begins a record.
    Record(Box<ExtractedFields>),
    /// The line does not begin a record under this grammar.
    NotARecordStart,
    /// The line exceeds [`MAX_MATCHABLE_LINE_BYTES`] and was refused before
    /// matching. Its record status is UNKNOWN, not "continuation".
    TooLong,
}

/// Apply a grammar to one physical line, distinguishing the failure modes.
pub fn match_line_outcome(format: &ReviewedFormat, line: &str) -> LineOutcome {
    if line.len() > MAX_MATCHABLE_LINE_BYTES {
        return LineOutcome::TooLong;
    }
    match match_line_inner(format, line) {
        Some(fields) => LineOutcome::Record(Box::new(fields)),
        None => LineOutcome::NotARecordStart,
    }
}

fn match_line_inner(format: &ReviewedFormat, line: &str) -> Option<ExtractedFields> {
    let consumed = format.timestamp.match_prefix(line)?;
    let timestamp_text = line.get(..consumed)?.to_string();
    let mut rest = line.get(consumed..)?;

    let mut fields = ExtractedFields {
        timestamp_text,
        provenance: format.timestamp.provenance(),
        ..ExtractedFields::default()
    };

    for slot in &format.layout {
        match slot {
            FieldSlot::Whitespace => {
                let trimmed = rest.trim_start_matches([' ', '\t']);
                if trimmed.len() == rest.len() {
                    return None;
                }
                rest = trimmed;
            }
            FieldSlot::Literal(text) => {
                rest = rest.strip_prefix(text.as_str())?;
            }
            FieldSlot::Level => {
                let (value, used) = take_token(rest, None, None)?;
                fields.level = Some(value);
                rest = rest.get(used..)?;
            }
            FieldSlot::Logger { open, close } => {
                let (value, used) = take_token(rest, *open, *close)?;
                fields.logger = Some(value);
                rest = rest.get(used..)?;
            }
            FieldSlot::Thread { open, close } => {
                let (value, used) = take_token(rest, *open, *close)?;
                fields.thread = Some(value);
                rest = rest.get(used..)?;
            }
            FieldSlot::Message => {
                // Everything left, minus leading spacing. The timestamp and
                // every consumed slot are gone by construction — the message
                // cannot still contain the timestamp text.
                fields.message = rest.trim_start_matches([' ', '\t']).to_string();
                rest = "";
            }
        }
    }
    let _ = rest;
    Some(fields)
}

/// One logical record assembled from one or more physical lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembledRecord {
    /// Extracted fields from the line that started the record.
    pub fields: ExtractedFields,
    /// Continuation lines attached to this record, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub continuation: Vec<String>,
    /// Physical line number (1-based) where the record starts.
    pub start_line: u64,
    /// True when the record hit [`MAX_MULTILINE_LINES`] and stopped absorbing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Continuation lines dropped after the cap.
    ///
    /// The cap bounds memory, so dropping is correct — reporting nothing was
    /// not. Without this, lines vanished from every count and a preview of a
    /// half-discarded record read as a perfect parse.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub lines_dropped: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// Assemble logical records from raw text under a grammar.
///
/// Lines before the first match are returned as `leading_unmatched` rather
/// than silently dropped or glued onto the first record — a preamble is
/// evidence too, and attaching it to an unrelated record would misattribute
/// it.
pub fn assemble_records(
    format: &ReviewedFormat,
    text: &str,
) -> (Vec<AssembledRecord>, Vec<String>) {
    let mut records: Vec<AssembledRecord> = Vec::new();
    let mut leading_unmatched: Vec<String> = Vec::new();

    for (index, line) in text.lines().enumerate() {
        let line_number = (index + 1) as u64;
        match match_line_outcome(format, line) {
            LineOutcome::Record(fields) => records.push(AssembledRecord {
                fields: *fields,
                continuation: Vec::new(),
                start_line: line_number,
                truncated: false,
                lines_dropped: 0,
            }),
            // An over-long line was refused BEFORE matching, so its record
            // status is unknown. Attributing it to the record above would move
            // a real record's text into an unrelated record's body — it is
            // reported unattributed instead.
            LineOutcome::TooLong => leading_unmatched.push(line.to_string()),
            LineOutcome::NotARecordStart => {
                if matches!(
                    format.multiline,
                    MultilineRule::ContinuationUntilNextTimestamp
                ) {
                    if let Some(current) = records.last_mut() {
                        if current.continuation.len() >= MAX_MULTILINE_LINES {
                            current.truncated = true;
                            current.lines_dropped += 1;
                        } else {
                            current.continuation.push(line.to_string());
                        }
                        continue;
                    }
                }
                // Before the first record, or under MultilineRule::None, an
                // unmatched line is its own unattributed line.
                leading_unmatched.push(line.to_string());
            }
        }
    }
    (records, leading_unmatched)
}

/// Bounded preview of what a grammar would do to a sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFormatPreview {
    /// Identity of the exact format previewed.
    pub format_id: String,
    /// Version previewed.
    pub version: u16,
    /// Physical lines inspected.
    pub lines_inspected: u64,
    /// Logical records the grammar produced.
    pub records_matched: u64,
    /// Lines that matched no record start and were not attributed.
    pub lines_unattributed: u64,
    /// Continuation lines dropped at [`MAX_MULTILINE_LINES`], across ALL
    /// records — including records past the sample window.
    ///
    /// Without this the loss was invisible: `truncated` lives on a sampled
    /// record, so a heavily-truncated record outside the first
    /// [`MAX_PREVIEW_SAMPLES`] left no trace in the preview at all.
    pub lines_dropped: u64,
    /// False when the format failed validation.
    ///
    /// A preview of an invalid format reports zero matches; without this it
    /// looked identical to a valid grammar that simply matched nothing.
    pub format_valid: bool,
    /// Provenance every matched record carries.
    pub provenance: TimestampProvenance,
    /// True when the grammar produces local calendar text needing a reviewed
    /// timezone declaration before it can become an instant.
    pub needs_timezone_review: bool,
    /// Bounded, redacted sample records.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<AssembledRecord>,
}

/// Maximum sample records a preview carries.
pub const MAX_PREVIEW_SAMPLES: usize = 5;

/// Preview a reviewed format against sample text.
///
/// Nothing is applied. An invalid format previews as zero matches rather than
/// being run — an unreviewed grammar must not touch content even to describe
/// itself.
pub fn preview_reviewed_format(format: &ReviewedFormat, sample: &str) -> ReviewedFormatPreview {
    let validation = validate_reviewed_format(format);
    let (records, unattributed) = if validation.valid {
        assemble_records(format, sample)
    } else {
        (Vec::new(), Vec::new())
    };

    let provenance = format.timestamp.provenance();
    let lines_dropped: u64 = records.iter().map(|record| record.lines_dropped).sum();
    let mut samples: Vec<AssembledRecord> =
        records.iter().take(MAX_PREVIEW_SAMPLES).cloned().collect();
    for record in &mut samples {
        // EVERY captured field, not only the message. The grammar decides what
        // lands in level/logger/thread, and a source that puts a token there
        // puts it into a preview that gets screenshotted into tickets.
        let fields = &mut record.fields;
        fields.message = super::redact_log::redact_message(&fields.message);
        fields.timestamp_text = super::redact_log::redact_message(&fields.timestamp_text);
        for value in [&mut fields.level, &mut fields.logger, &mut fields.thread]
            .into_iter()
            .flatten()
        {
            *value = super::redact_log::redact_message(value);
        }
        for line in &mut record.continuation {
            *line = super::redact_log::redact_message(line);
        }
    }

    ReviewedFormatPreview {
        format_id: format.format_id.clone(),
        version: format.version,
        lines_inspected: sample.lines().count() as u64,
        records_matched: records.len() as u64,
        lines_unattributed: unattributed.len() as u64,
        lines_dropped,
        format_valid: validation.valid,
        provenance,
        needs_timezone_review: !format.timestamp.has_offset(),
        samples,
    }
}

/// Whether a reviewed format is a candidate for a source identity.
///
/// A format with no path patterns is a candidate for every source; content
/// still decides. A format WITH patterns is a candidate only for matching
/// identities — which is how a profile avoids claiming unrelated files.
pub fn is_candidate_for(format: &ReviewedFormat, source_identity: &str) -> bool {
    format.path_patterns.is_empty()
        || format
            .path_patterns
            .iter()
            .any(|pattern| pattern.matches(source_identity))
}

/// Outcome of choosing between competing reviewed formats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormatSelection {
    /// Exactly one format won.
    Selected {
        /// Winning format id.
        format_id: String,
        /// Winning version.
        version: u16,
    },
    /// Several formats tied on priority. Requires an explicit human choice;
    /// #751 forbids guessing between competing profiles.
    Conflict {
        /// Tied format ids, sorted.
        format_ids: Vec<String>,
    },
    /// No candidate matched the content.
    NoMatch,
}

/// Select deterministically among reviewed formats for one source.
///
/// Candidacy is by path, selection is by content, and the tie-break is
/// explicit priority. A tie is reported rather than resolved, and the result
/// does not depend on the order formats were supplied.
pub fn select_format(
    formats: &[ReviewedFormat],
    source_identity: &str,
    sample: &str,
) -> FormatSelection {
    let mut matched: Vec<(&ReviewedFormat, u64)> = Vec::new();
    for format in formats {
        if !validate_reviewed_format(format).valid {
            continue;
        }
        if !is_candidate_for(format, source_identity) {
            continue;
        }
        let (records, unattributed) = assemble_records(format, sample);
        // Fail-closed staleness: a single incidental matching line is not
        // evidence that this grammar still describes the source. A source that
        // changed shape leaves most lines unattributed, and selecting on
        // `records >= 1` let one stray old line re-select a stale grammar over
        // a wholly changed file.
        let attributed: usize =
            records.len() + records.iter().map(|r| r.continuation.len()).sum::<usize>();
        let total = attributed + unattributed.len();
        let covers_source = total > 0 && attributed.saturating_mul(2) >= total;
        if !records.is_empty() && covers_source {
            matched.push((format, records.len() as u64));
        }
    }
    if matched.is_empty() {
        return FormatSelection::NoMatch;
    }
    let best = matched.iter().map(|(f, _)| f.priority).max().unwrap_or(0);
    let mut top: Vec<&ReviewedFormat> = matched
        .iter()
        .filter(|(f, _)| f.priority == best)
        .map(|(f, _)| *f)
        .collect();
    top.sort_by(|a, b| a.format_id.cmp(&b.format_id));
    if top.len() > 1 {
        return FormatSelection::Conflict {
            format_ids: top.iter().map(|f| f.format_id.clone()).collect(),
        };
    }
    FormatSelection::Selected {
        format_id: top[0].format_id.clone(),
        version: top[0].version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `2024-05-03 12:24:22,729 INFO - Example message`
    fn common_format() -> ReviewedFormat {
        ReviewedFormat {
            schema_id: REVIEWED_FORMAT_SCHEMA_ID.to_string(),
            min_reader_version: 1,
            format_id: "example.app-log".to_string(),
            version: 1,
            name: "Example app log".to_string(),
            path_patterns: vec![SafePattern::new("**/app.log*")],
            timestamp: TimestampGrammar {
                tokens: vec![
                    TimeToken::Year4,
                    TimeToken::Literal('-'),
                    TimeToken::Month2,
                    TimeToken::Literal('-'),
                    TimeToken::Day2,
                    TimeToken::Literal(' '),
                    TimeToken::Hour24,
                    TimeToken::Literal(':'),
                    TimeToken::Minute2,
                    TimeToken::Literal(':'),
                    TimeToken::Second2,
                    TimeToken::Literal(','),
                    TimeToken::Millis3,
                ],
            },
            layout: vec![
                FieldSlot::Whitespace,
                FieldSlot::Level,
                FieldSlot::Whitespace,
                FieldSlot::Literal("- ".to_string()),
                FieldSlot::Message,
            ],
            multiline: MultilineRule::ContinuationUntilNextTimestamp,
            priority: 10,
            suggested_timezone: None,
        }
    }

    #[test]
    fn the_common_form_parses_and_the_timestamp_leaves_the_message() {
        let format = common_format();
        assert!(validate_reviewed_format(&format).valid);
        let fields =
            match_line(&format, "2024-05-03 12:24:22,729 INFO - Example message").expect("match");
        assert_eq!(fields.timestamp_text, "2024-05-03 12:24:22,729");
        assert_eq!(fields.level.as_deref(), Some("INFO"));
        assert_eq!(fields.message, "Example message");
        assert!(
            !fields.message.contains("2024-05-03"),
            "the timestamp must leave the message field"
        );
        assert!(!fields.message.contains("INFO"));
    }

    #[test]
    fn a_grammar_without_an_offset_yields_unresolved_local_never_an_instant() {
        let format = common_format();
        assert_eq!(
            format.timestamp.provenance(),
            TimestampProvenance::UnresolvedLocal
        );
        let preview = preview_reviewed_format(&format, "2024-05-03 12:24:22,729 INFO - hello");
        assert!(preview.needs_timezone_review);
    }

    #[test]
    fn an_offset_token_is_what_makes_an_instant_explicit() {
        let mut format = common_format();
        format.timestamp.tokens.push(TimeToken::Offset);
        assert_eq!(
            format.timestamp.provenance(),
            TimestampProvenance::ExplicitWallClock
        );
        let fields = match_line(&format, "2024-05-03 12:24:22,729+02:00 INFO - hi").expect("match");
        assert_eq!(fields.timestamp_text, "2024-05-03 12:24:22,729+02:00");
        assert!(
            !preview_reviewed_format(&format, "2024-05-03 12:24:22,729Z INFO - hi")
                .needs_timezone_review
        );
    }

    #[test]
    fn a_suggested_timezone_is_inert_and_must_be_a_real_zone() {
        let mut format = common_format();
        format.suggested_timezone = Some("America/Chicago".to_string());
        assert!(validate_reviewed_format(&format).valid);
        // Suggesting does not resolve: provenance is unchanged.
        assert_eq!(
            format.timestamp.provenance(),
            TimestampProvenance::UnresolvedLocal
        );
        assert!(
            preview_reviewed_format(&format, "2024-05-03 12:24:22,729 INFO - x")
                .needs_timezone_review
        );

        format.suggested_timezone = Some("Mars/Olympus".to_string());
        assert!(!validate_reviewed_format(&format).valid);
    }

    #[test]
    fn multiline_continuations_attach_and_do_not_bleed_into_the_next_record() {
        let format = common_format();
        let text = "2024-05-03 12:24:22,729 ERROR - boom\n\
                    java.lang.IllegalStateException: boom\n\
                    \tat com.example.A.run(A.java:10)\n\
                    2024-05-03 12:24:23,000 INFO - next\n";
        let (records, leading) = assemble_records(&format, text);
        assert!(leading.is_empty());
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].continuation.len(), 2);
        assert_eq!(records[0].fields.message, "boom");
        assert_eq!(records[1].fields.message, "next");
        assert!(
            records[1].continuation.is_empty(),
            "a continuation must not bleed into the following record"
        );
    }

    #[test]
    fn a_flush_left_continuation_still_attaches() {
        // Ownership is decided by "does a new record start here", not by
        // indentation — a flush-left traceback line would otherwise split.
        let format = common_format();
        let text = "2024-05-03 12:24:22,729 ERROR - boom\n\
                    Traceback (most recent call last):\n\
                    ValueError: bad\n";
        let (records, _) = assemble_records(&format, text);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].continuation.len(), 2);
    }

    #[test]
    fn a_preamble_is_kept_unattributed_rather_than_glued_to_the_first_record() {
        let format = common_format();
        let text = "### rotated at boot\n2024-05-03 12:24:22,729 INFO - first\n";
        let (records, leading) = assemble_records(&format, text);
        assert_eq!(leading, vec!["### rotated at boot".to_string()]);
        assert_eq!(records.len(), 1);
        assert!(records[0].continuation.is_empty());
    }

    #[test]
    fn optional_logger_and_thread_slots_extract_without_touching_the_message() {
        let mut format = common_format();
        format.layout = vec![
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Whitespace,
            FieldSlot::Thread {
                open: Some('['),
                close: Some(']'),
            },
            FieldSlot::Whitespace,
            FieldSlot::Logger {
                open: None,
                close: None,
            },
            FieldSlot::Whitespace,
            FieldSlot::Literal("- ".to_string()),
            FieldSlot::Message,
        ];
        let fields = match_line(
            &format,
            "2024-05-03 12:24:22,729 WARN [pool-1-thread-2] com.example.Svc - disk almost full",
        )
        .expect("match");
        assert_eq!(fields.level.as_deref(), Some("WARN"));
        assert_eq!(fields.thread.as_deref(), Some("pool-1-thread-2"));
        assert_eq!(fields.logger.as_deref(), Some("com.example.Svc"));
        assert_eq!(fields.message, "disk almost full");
    }

    #[test]
    fn rolled_files_share_one_profile_but_unrelated_sources_do_not_match() {
        let format = common_format();
        for rolled in [
            "logs/app.log",
            "logs/app.log.1",
            "logs/app.log.2024-05-03",
            "srv/logs/app.log.2024-05-04.gz",
        ] {
            assert!(is_candidate_for(&format, rolled), "{rolled} should match");
        }
        for unrelated in ["logs/access.log", "logs/postgres.log", "metrics/ops.json"] {
            assert!(
                !is_candidate_for(&format, unrelated),
                "{unrelated} must not be claimed"
            );
        }
    }

    #[test]
    fn a_path_candidate_still_has_to_match_the_content() {
        // Name narrows candidates; content decides. A file called app.log that
        // holds a different shape must not be parsed by this grammar.
        let format = common_format();
        assert!(is_candidate_for(&format, "logs/app.log"));
        assert_eq!(
            select_format(
                std::slice::from_ref(&format),
                "logs/app.log",
                "not a timestamped line at all\n",
            ),
            FormatSelection::NoMatch
        );
    }

    #[test]
    fn competing_formats_tie_into_a_conflict_rather_than_a_guess() {
        let mut a = common_format();
        a.format_id = "b.second".to_string();
        let mut b = common_format();
        b.format_id = "a.first".to_string();
        let sample = "2024-05-03 12:24:22,729 INFO - x\n";

        // Equal priority -> explicit conflict, order-independent.
        let forward = select_format(&[a.clone(), b.clone()], "logs/app.log", sample);
        let reverse = select_format(&[b.clone(), a.clone()], "logs/app.log", sample);
        assert_eq!(forward, reverse);
        assert_eq!(
            forward,
            FormatSelection::Conflict {
                format_ids: vec!["a.first".to_string(), "b.second".to_string()]
            }
        );

        // A higher priority resolves it deterministically.
        let mut winner = a.clone();
        winner.priority = 20;
        assert_eq!(
            select_format(&[winner, b], "logs/app.log", sample),
            FormatSelection::Selected {
                format_id: "b.second".to_string(),
                version: 1
            }
        );
    }

    #[test]
    fn an_invalid_format_never_previews_or_selects() {
        let mut format = common_format();
        format.schema_id = "wrong".to_string();
        let preview = preview_reviewed_format(&format, "2024-05-03 12:24:22,729 INFO - x");
        assert_eq!(preview.records_matched, 0);
        assert_eq!(
            select_format(
                &[format],
                "logs/app.log",
                "2024-05-03 12:24:22,729 INFO - x\n"
            ),
            FormatSelection::NoMatch
        );
    }

    #[test]
    fn validation_rejects_a_grammar_that_cannot_place_an_event() {
        let mut format = common_format();
        format.timestamp = TimestampGrammar {
            tokens: vec![
                TimeToken::Hour24,
                TimeToken::Literal(':'),
                TimeToken::Minute2,
            ],
        };
        let codes: Vec<_> = validate_reviewed_format(&format)
            .diagnostics
            .iter()
            .map(|d| d.code)
            .collect();
        assert!(codes.contains(&ReviewedFormatDiagnosticCode::TimestampGrammarIncomplete));

        let mut partial_with_offset = common_format();
        partial_with_offset.timestamp.tokens = vec![
            TimeToken::Year4,
            TimeToken::Literal(' '),
            TimeToken::Hour24,
            TimeToken::Offset,
        ];
        let validation = validate_reviewed_format(&partial_with_offset);
        assert!(!validation.valid);
        assert!(validation.diagnostics.iter().any(
            |finding| finding.code == ReviewedFormatDiagnosticCode::TimestampGrammarIncomplete
        ));
    }

    #[test]
    fn validation_rejects_ambiguous_time_tokens_and_half_delimiters() {
        let mut duplicate_year = common_format();
        duplicate_year.timestamp.tokens.insert(0, TimeToken::Year4);
        assert!(validate_reviewed_format(&duplicate_year)
            .diagnostics
            .iter()
            .any(
                |finding| finding.code == ReviewedFormatDiagnosticCode::TimestampGrammarIncomplete
            ));

        let mut competing_fractions = common_format();
        competing_fractions
            .timestamp
            .tokens
            .push(TimeToken::Micros6);
        assert!(validate_reviewed_format(&competing_fractions)
            .diagnostics
            .iter()
            .any(|finding| finding.code == ReviewedFormatDiagnosticCode::TimestampGrammarInvalid));

        let mut half_delimiter = common_format();
        half_delimiter.layout.insert(
            half_delimiter.layout.len() - 1,
            FieldSlot::Logger {
                open: Some('['),
                close: None,
            },
        );
        assert!(validate_reviewed_format(&half_delimiter)
            .diagnostics
            .iter()
            .any(|finding| finding.code == ReviewedFormatDiagnosticCode::LayoutInvalid));
    }

    #[test]
    fn validation_requires_message_last_and_forbids_duplicate_slots() {
        let mut format = common_format();
        format.layout = vec![FieldSlot::Message, FieldSlot::Whitespace];
        assert!(validate_reviewed_format(&format)
            .diagnostics
            .iter()
            .any(|d| d.code == ReviewedFormatDiagnosticCode::MessageSlotMisplaced));

        let mut format = common_format();
        format.layout = vec![
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Message,
        ];
        assert!(validate_reviewed_format(&format)
            .diagnostics
            .iter()
            .any(|d| d.code == ReviewedFormatDiagnosticCode::DuplicateFieldSlot));
    }

    #[test]
    fn matching_is_bounded_and_refuses_a_pathological_line() {
        let format = common_format();
        let huge = format!(
            "2024-05-03 12:24:22,729 INFO - {}",
            "x".repeat(MAX_MATCHABLE_LINE_BYTES)
        );
        let started = std::time::Instant::now();
        assert!(
            match_line(&format, &huge).is_none(),
            "an over-long line is refused before matching"
        );
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }

    #[test]
    fn matching_stays_linear_on_adversarial_input() {
        // The closed token vocabulary is what makes this safe: there is no
        // user-supplied pattern that could backtrack.
        let format = common_format();
        let hostile = "2024-05-03 12:24:22,72".repeat(2_000);
        let started = std::time::Instant::now();
        let _ = match_line(&format, &hostile);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(100),
            "matching must stay linear: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn preview_redacts_and_bounds_its_samples() {
        let format = common_format();
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let mut text = String::new();
        for index in 0..20 {
            text.push_str(&format!(
                "2024-05-03 12:24:2{},729 INFO - key={secret} n={index}\n",
                index % 10
            ));
        }
        let preview = preview_reviewed_format(&format, &text);
        assert!(preview.samples.len() <= MAX_PREVIEW_SAMPLES);
        let encoded = serde_json::to_string(&preview).expect("serialize");
        assert!(
            !encoded.contains(secret),
            "a preview is shown in a UI and pasted into tickets; it must be redacted"
        );
        assert_eq!(
            preview.records_matched, 20,
            "counts stay exact while samples are bounded"
        );
    }

    #[test]
    fn dropped_continuation_lines_are_counted_not_silently_destroyed() {
        // The cap bounds memory, so dropping is right; reporting nothing was
        // not. Every physical line must still be accounted for.
        let format = common_format();
        let mut text = String::from("2024-05-03 12:24:22,729 INFO - a\n");
        for index in 0..1000 {
            text.push_str(&format!("continuation {index}\n"));
        }
        let (records, unattributed) = assemble_records(&format, &text);
        assert_eq!(records[0].continuation.len(), MAX_MULTILINE_LINES);
        assert!(records[0].truncated);
        assert_eq!(records[0].lines_dropped, 1000 - MAX_MULTILINE_LINES as u64);

        let accounted = records.len()
            + records.iter().map(|r| r.continuation.len()).sum::<usize>()
            + records
                .iter()
                .map(|r| r.lines_dropped as usize)
                .sum::<usize>()
            + unattributed.len();
        assert_eq!(accounted, 1001, "every physical line must be accounted for");

        let preview = preview_reviewed_format(&format, &text);
        assert_eq!(preview.lines_dropped, 1000 - MAX_MULTILINE_LINES as u64);
    }

    #[test]
    fn truncation_is_visible_even_when_the_record_is_past_the_sample_window() {
        // `truncated` lives on a sampled record, so a fat record beyond the
        // sample cap used to leave no trace in the preview at all.
        let format = common_format();
        let mut text = String::new();
        for index in 0..(MAX_PREVIEW_SAMPLES + 10) {
            text.push_str(&format!(
                "2024-05-03 12:24:2{},000 INFO - r{index}\n",
                index % 10
            ));
        }
        for index in 0..900 {
            text.push_str(&format!("tail continuation {index}\n"));
        }
        let preview = preview_reviewed_format(&format, &text);
        assert!(
            preview.lines_dropped > 0,
            "a truncated record outside the sample window must still be disclosed"
        );
        assert!(preview.samples.iter().all(|s| !s.truncated));
    }

    #[test]
    fn an_over_long_line_is_unattributed_not_swallowed_as_a_continuation() {
        // An over-long line is refused BEFORE matching, so its record status is
        // unknown. Treating it as a continuation moved a real record's text
        // into an unrelated record's body.
        let format = common_format();
        let long = format!(
            "2024-05-03 12:24:23,000 ERROR - {}",
            "x".repeat(MAX_MATCHABLE_LINE_BYTES)
        );
        let text = format!(
            "2024-05-03 12:24:22,729 INFO - first\n{long}\n2024-05-03 12:24:24,000 INFO - third\n"
        );
        let (records, unattributed) = assemble_records(&format, &text);
        assert!(
            records[0].continuation.is_empty(),
            "a record start must never end up inside another record's body"
        );
        assert_eq!(unattributed.len(), 1, "the over-long line is reported");
        assert_eq!(
            match_line_outcome(&format, &long),
            LineOutcome::TooLong,
            "the two failure modes must stay distinguishable"
        );
    }

    #[test]
    fn an_impossible_offset_is_refused_rather_than_stamped_explicit() {
        let mut format = common_format();
        format.timestamp.tokens.push(TimeToken::Offset);
        for bad in ["+99:99", "+24:00", "-30:00", "+05:60"] {
            assert!(
                format
                    .timestamp
                    .match_prefix(&format!("2024-05-03 12:24:22,729{bad}"))
                    .is_none(),
                "{bad} must not match"
            );
        }
        for good in ["+23:59", "-23:59", "Z", "+00:00"] {
            assert!(
                format
                    .timestamp
                    .match_prefix(&format!("2024-05-03 12:24:22,729{good}"))
                    .is_some(),
                "{good} must match"
            );
        }
    }

    #[test]
    fn impossible_calendar_and_clock_values_never_match() {
        let format = common_format();
        for bad in [
            "2024-00-03 12:24:22,729",
            "2024-13-03 12:24:22,729",
            "2024-02-30 12:24:22,729",
            "2023-02-29 12:24:22,729",
            "2024-05-03 24:24:22,729",
            "2024-05-03 12:60:22,729",
            "2024-05-03 12:24:61,729",
        ] {
            assert!(
                format.timestamp.match_prefix(bad).is_none(),
                "{bad} must not match as calendar evidence"
            );
        }
        assert!(format
            .timestamp
            .match_prefix("2024-02-29 23:59:60,999")
            .is_some());
    }

    #[test]
    fn a_stale_grammar_is_not_reselected_by_one_incidental_line() {
        // Fail-closed staleness: selecting on "at least one record" let a
        // single stray old line re-select a grammar over a wholly changed file.
        let format = common_format();
        let mut changed = String::new();
        for index in 0..200 {
            changed.push_str(&format!(
                "May  3 12:24:{:02} host app: syslog now\n",
                index % 60
            ));
        }
        changed.push_str("2024-05-03 12:24:22,729 INFO - one stray old line\n");
        assert_eq!(
            select_format(std::slice::from_ref(&format), "logs/app.log", &changed),
            FormatSelection::NoMatch,
            "one incidental line is not evidence the grammar still fits"
        );
        // A source the grammar genuinely covers still selects.
        assert!(matches!(
            select_format(
                std::slice::from_ref(&format),
                "logs/app.log",
                "2024-05-03 12:24:22,729 INFO - a\n2024-05-03 12:24:23,000 INFO - b\n"
            ),
            FormatSelection::Selected { .. }
        ));
    }

    #[test]
    fn preview_redacts_every_captured_field_not_only_the_message() {
        // A grammar decides what lands in level/logger/thread, and a preview
        // is exactly what gets screenshotted into a ticket.
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let mut format = common_format();
        format.layout = vec![
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Whitespace,
            FieldSlot::Logger {
                open: None,
                close: None,
            },
            FieldSlot::Whitespace,
            FieldSlot::Literal("- ".to_string()),
            FieldSlot::Message,
        ];
        let body = format!("2024-05-03 12:24:22,729 INFO {secret} - hello\n");
        let preview = preview_reviewed_format(&format, &body);
        let encoded = serde_json::to_string(&preview).expect("serialize");
        assert!(
            !encoded.contains(secret),
            "a secret captured into logger must not survive the preview"
        );
    }

    #[test]
    fn an_invalid_format_preview_says_so_instead_of_looking_like_no_match() {
        let mut format = common_format();
        format.schema_id = "wrong".to_string();
        let preview = preview_reviewed_format(&format, "2024-05-03 12:24:22,729 INFO - x\n");
        assert!(!preview.format_valid);
        assert_eq!(preview.records_matched, 0);

        let valid = preview_reviewed_format(&common_format(), "nothing matches here\n");
        assert!(
            valid.format_valid,
            "a valid grammar that matched nothing is different"
        );
        assert_eq!(valid.records_matched, 0);
    }

    #[test]
    fn the_document_round_trips_and_rejects_unknown_fields() {
        let format = common_format();
        let encoded = serde_json::to_string(&format).expect("serialize");
        let decoded: ReviewedFormat = serde_json::from_str(&encoded).expect("round trip");
        assert_eq!(decoded, format);
        let tampered = encoded.replace("{\"schemaId\"", "{\"exec\":\"rm -rf /\",\"schemaId\"");
        assert!(
            serde_json::from_str::<ReviewedFormat>(&tampered).is_err(),
            "a reviewed format is not code; unknown fields must be refused"
        );
    }
}
