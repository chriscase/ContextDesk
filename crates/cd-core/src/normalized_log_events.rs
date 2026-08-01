//! `contextdesk.normalized_log_events.v1` — a standalone JSONL contract a
//! producer can emit so its logs arrive already parsed, without ContextDesk
//! having to guess a grammar.
//!
//! # Standalone, optional, and never required
//!
//! A producer is **never** obliged to normalize. Raw logs stay first-class
//! (#763 lists raw logs as a bundle component type; #789 requires that
//! "normalized access never replaces raw evidence"). This contract is an
//! opt-in fast lane, and a bundle that carries only raw logs is fully
//! conforming.
//!
//! The file is self-contained: it can be validated, shipped, and read with no
//! Incident Evidence Bundle around it. When it *is* carried inside a bundle,
//! the bundle manifest remains authoritative for component identity and bounds
//! (#763: "the outer evidence manifest remains authoritative"), and the
//! manifest's optional `contentSchemaId` is what enrols a component as
//! normalized. Folder coincidence never enrols anything.
//!
//! # Why JSONL, and why this sidesteps #788
//!
//! #788 (bounded logical-record framing) exists because a *raw* multi-line
//! record — a Java stack trace, pretty-printed JSON — cannot be framed by
//! splitting on newlines. That problem is real and unsolved for raw input.
//!
//! This contract does not inherit it, because **the producer has already
//! framed its own records**. One JSON object per line describes one logical
//! event, however many physical lines it originally spanned; the original
//! text is preserved verbatim in [`NormalizedLogEvent::canonical`], newlines
//! and all. So normalizing is precisely the act of moving framing to the side
//! that actually knows the answer. A producer that cannot frame its own
//! records should emit raw logs instead — that is the honest fallback, not a
//! degraded one.
//!
//! # Old-reader fallback
//!
//! A ContextDesk build that predates this contract has no idea what these
//! files are. It must still behave honestly, and it does — by construction
//! rather than by promise:
//!
//! * Every line is a standalone JSON object, so the existing deterministic
//!   fingerprinter classifies the file as `json-object-line` and imports it as
//!   ordinary events.
//! * No line carries a bare epoch or a zone-less timestamp in a field an old
//!   reader would treat as authoritative wall-clock time, so the fallback is
//!   **order-only** rather than a fabricated instant.
//!
//! `normalized_log_events_fallback.rs` proves both properties against the real
//! ingest path rather than asserting them here.
//!
//! # What this module does not do
//!
//! It defines and validates the contract. It does **not** import anything, and
//! nothing here makes a normalized file faster to ingest — the fast path is a
//! later slice and does not exist yet.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::error::CoreResult;

/// Schema identifier every conforming file declares on its header line.
pub const NORMALIZED_LOG_EVENTS_SCHEMA_ID: &str = "contextdesk.normalized_log_events.v1";

/// Highest schema version this build can read.
///
/// A file declaring a higher `minReaderVersion` is refused whole rather than
/// partially understood, matching [`crate::incident_evidence::READER_VERSION`].
pub const NORMALIZED_LOG_EVENTS_READER_VERSION: u32 = 1;

/// Maximum bytes of one JSONL line, header or event.
///
/// Deliberately below `log_analysis::ingest::MAX_RAW_LOG_LINE_BYTES` (16 MiB)
/// so a conforming file is always readable by the raw path too — the
/// old-reader fallback would be a dead letter if a normalized line could
/// exceed what the raw reader accepts.
pub const MAX_NORMALIZED_LINE_BYTES: usize = 1024 * 1024;

/// Maximum bytes of a retained canonical original record.
///
/// Matches `log_analysis::redact_log::MAX_ORIGINAL_REDACTED_BYTES` so the
/// round-trip a producer can offer is exactly the round-trip ContextDesk
/// itself retains — promising more would be a promise the reader discards.
pub const MAX_CANONICAL_BYTES: usize = 64 * 1024;

/// Maximum characters in an identifier-shaped field.
pub const MAX_NORMALIZED_ID_CHARS: usize = 128;

/// Maximum characters in a rendered message.
pub const MAX_MESSAGE_CHARS: usize = 64 * 1024;

/// Maximum typed correlations on one event.
pub const MAX_CORRELATIONS_PER_EVENT: usize = 32;

/// Maximum attributes on one event.
pub const MAX_ATTRIBUTES_PER_EVENT: usize = 256;

/// Maximum characters in one attribute key.
pub const MAX_ATTRIBUTE_KEY_CHARS: usize = 128;

/// Highest legal OTel severity number (#790: "OTel 0–24 or unspecified").
pub const MAX_SEVERITY_NUMBER: u8 = 24;

/// Maximum bounded, re-redacted sample lines retained in a validation report.
pub const MAX_ERROR_SAMPLES: usize = 5;

/// Maximum characters of any single re-redacted error sample.
pub const MAX_ERROR_SAMPLE_CHARS: usize = 256;

/// Maximum nesting depth of any JSON value on a line.
///
/// Bounds parser work and stack use on hostile input. A deeply nested
/// attribute map is the cheap way to make a validator expensive.
pub const MAX_JSON_DEPTH: usize = 32;

/// Schema identifiers this build knows how to read.
///
/// A registry rather than a single constant so a future minor can be added
/// without the reader silently best-effort parsing an unknown major. Anything
/// absent here is refused outright.
pub const SUPPORTED_SCHEMA_IDS: &[&str] = &[NORMALIZED_LOG_EVENTS_SCHEMA_ID];

/// Top-level event keys a conforming file may never carry.
///
/// The old-reader fallback works because a reader predating this contract
/// treats each line as an ordinary JSON log record. That same generic parser
/// (`log_analysis::parse::parse_json`) reads `ts`, `timestamp`, `time`, and
/// `@timestamp` as authoritative wall-clock time, and a bare integer epoch in
/// any of them becomes an `ExplicitWallClock` instant.
///
/// So an event could declare `resolution: "order_only"` — no usable time at
/// all — while carrying a convenience `"ts": 1767225600`, and the only reader
/// that exists today would place the corpus on a 2026 wall clock derived from
/// a producer-supplied epoch with no offset and no timezone. That defeats the
/// guessed-instant guard and the order-only fallback simultaneously, and it is
/// reachable without malice: an exporter that spreads its original record into
/// the event object produces it naturally.
///
/// These keys are refused outright. `time` is absent from the list because it
/// is this contract's own field and is always an object, which the generic
/// parser decodes as unusable rather than as an instant.
pub const RESERVED_EVENT_KEYS: &[&str] = &["ts", "timestamp", "@timestamp"];

/// How an event's instant came to exist.
///
/// This enum is the whole timestamp legality story: it names the *provenance*
/// of an instant, and [`validate_event`] refuses every combination that would
/// let a guessed instant exist. There is deliberately **no variant meaning
/// "inferred", "assumed", or "best effort"** — a guessed instant is not
/// merely discouraged here, it is unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeResolution {
    /// The source record itself carried an unambiguous instant — UTC, or a
    /// local time with an explicit numeric offset. `instant` is required.
    SourceExplicit,
    /// The source carried a zone-less local time and the **producer** resolved
    /// it using a timezone it declares. `instant`, `localText`, and
    /// `resolvedTimezone` are all required.
    ///
    /// This is a claim by the producer, not source truth. #763 already rules
    /// that "per-record explicit offsets remain authoritative" and that a
    /// producer default "must retain provenance"; keeping this a distinct,
    /// visible state is how the provenance survives. A reader may present,
    /// filter, or distrust these differently from
    /// [`TimeResolution::SourceExplicit`], and must never render them as
    /// source-declared.
    ProducerResolved,
    /// The source carried a local time with no zone and the producer did
    /// **not** resolve it. `localText` is required and `instant` is
    /// forbidden — the text is evidence, never an instant (#670: "unresolved
    /// local time remains evidence, never an instant").
    Unresolved,
    /// The source carried no usable time at all. Ordering is by
    /// `sourceSeq` only.
    OrderOnly,
}

/// Which axis an event's time lives on (#670's `time_basis`: wall, relative,
/// order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeBasis {
    /// Wall-clock time. Compatible with other wall sources.
    Wall,
    /// A monotonic or relative axis. Never comparable to wall time without an
    /// explicit validated mapping (#670).
    Relative,
    /// Order only.
    Order,
}

/// One event's time, as a single indivisible unit.
///
/// Modelled as one struct rather than loose fields so the legality matrix can
/// be enforced in one place; scattering `instant`/`localText`/`basis` across
/// the event would make "an instant without provenance" merely a bug rather
/// than something the validator can categorically reject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTime {
    /// Which axis this event's time lives on.
    pub basis: TimeBasis,
    /// Where the instant came from, if there is one.
    pub resolution: TimeResolution,
    /// RFC3339 instant with an explicit offset. Legal only for
    /// [`TimeResolution::SourceExplicit`] and
    /// [`TimeResolution::ProducerResolved`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instant: Option<String>,
    /// The source's own timestamp text, verbatim and unparsed.
    ///
    /// Required whenever the source had local time (resolved or not), so the
    /// original representation is never discarded — #813's rule that changing
    /// a declaration "never rewrites or discards the stored original".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_text: Option<String>,
    /// IANA timezone the producer used to resolve `localText`. Required for,
    /// and legal only for, [`TimeResolution::ProducerResolved`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_timezone: Option<String>,
    /// Time the producer observed the record, distinct from the event time
    /// (#787: `observed_time` must not be overwritten by import time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
}

/// How confident the severity assignment is.
///
/// Separate from [`SeverityProvenance`] because *where* a value came from and
/// *how much to trust it* are different questions: a schema mapping is
/// high-confidence but not source-declared, while a text inference is
/// low-confidence by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeverityConfidence {
    /// The source stated a severity in a field meant for severity.
    High,
    /// Derived through a documented schema mapping.
    Medium,
    /// Guessed from message text. #790 requires this be treated as
    /// low-confidence and never presented as source-declared.
    Low,
}

/// Where the severity came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeverityProvenance {
    /// Read directly from the source's own severity field.
    SourceDeclared,
    /// Mapped from a known schema's vocabulary (syslog PRI, CEF, Pino, …).
    SchemaMapped,
    /// Inferred from message text. #790 names the failure this guards:
    /// inferring an error from the phrase "no errors detected".
    TextInferred,
    /// The source expressed no severity at all.
    Absent,
}

/// Severity: raw value, canonical value, confidence, and provenance.
///
/// The four are independent by design. `raw` is exactly what the source
/// emitted, in the source's own JSON type — a syslog PRI integer, a CEF 0–10,
/// a Windows level, a Pino numeric, or a string like `"NOTICE"` or `"D2"`.
/// `canonical` is the normalized OTel number used for filtering. Keeping both
/// is #790's requirement that "filters and UI can group by normalized bands
/// while details, exports, tools, and raw view retain source semantics".
///
/// `confidence` and `provenance` are always serialized, so a normalized value
/// can never be mistaken for a source-declared one — #790: *"never present
/// inferred severity as source-declared"*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Severity {
    /// The source's severity exactly as emitted, in its own JSON type.
    /// Absent only when the source expressed none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
    /// Normalized OTel severity number, 0–24.
    ///
    /// Absent rather than zero when unspecified: OTel assigns meaning to 0,
    /// so encoding "unknown" as 0 would silently claim TRACE.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<u8>,
    /// How much to trust `canonical`.
    pub confidence: SeverityConfidence,
    /// Where the severity came from.
    pub provenance: SeverityProvenance,
}

/// The eleven typed correlation classes from #789.
///
/// #789: *"Enforce distinct `trace_id` and `span_id`; retain
/// request/session/transaction/activity/audit/flow/boot/container/pod/event/query
/// IDs as named typed correlations."*
///
/// Trace and span are deliberately **absent** from this enum. They are their
/// own fields on [`NormalizedLogEvent`], so a producer cannot route a span id
/// into a trace slot through the correlation mechanism — the structural
/// distinctness #789 demands is enforced by the type, not by a lint. This is
/// the same class of bug as the live P0 in `parse_json`, which accepts
/// `span_id` as a `trace_id` alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrelationClass {
    /// Request identifier.
    Request,
    /// Session identifier.
    Session,
    /// Transaction identifier.
    Transaction,
    /// Activity identifier.
    Activity,
    /// Audit identifier.
    Audit,
    /// Flow identifier.
    Flow,
    /// Boot identifier — also the identity anchor for a relative time axis.
    Boot,
    /// Container identifier.
    Container,
    /// Pod identifier.
    Pod,
    /// Event identifier.
    Event,
    /// Query identifier.
    Query,
}

impl CorrelationClass {
    /// All eleven classes, in #789's stated order.
    pub const ALL: [CorrelationClass; 11] = [
        CorrelationClass::Request,
        CorrelationClass::Session,
        CorrelationClass::Transaction,
        CorrelationClass::Activity,
        CorrelationClass::Audit,
        CorrelationClass::Flow,
        CorrelationClass::Boot,
        CorrelationClass::Container,
        CorrelationClass::Pod,
        CorrelationClass::Event,
        CorrelationClass::Query,
    ];
}

/// One typed correlation identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Correlation {
    /// Which of the eleven classes this identifier belongs to.
    pub class: CorrelationClass,
    /// The identifier value.
    pub value: String,
}

/// Producer identity declared once, on the header line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerIdentity {
    /// Producer name.
    pub name: String,
    /// Producer version.
    pub version: String,
}

/// Redaction the producer *claims* to have performed.
///
/// **Advisory only.** ContextDesk's own redaction remains mandatory and runs
/// regardless of what this says; a producer asserting `credentialsRemoved:
/// true` does not exempt one byte from re-redaction on import. The field
/// exists so a producer can describe its intent and so a reviewer can notice a
/// producer that claims nothing — not so a reader can skip work.
///
/// This mirrors the existing rule for bundles, where `privacy` is a
/// declaration and the validator still scans for sentinels itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerRedactionClaim {
    /// Producer claims credentials were removed.
    pub credentials_removed: bool,
    /// Producer claims personal data was removed.
    pub personal_data_removed: bool,
    /// Free-text note, bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The first line of every conforming file.
///
/// Declaring schema and source identity once, rather than on every event,
/// keeps per-event overhead low and makes `sourceId` a property of the file
/// rather than something each line could disagree about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedLogHeader {
    /// Must equal [`NORMALIZED_LOG_EVENTS_SCHEMA_ID`].
    pub schema_id: String,
    /// Lowest reader version able to interpret this file.
    pub min_reader_version: u32,
    /// Stable identifier for the source these events came from.
    ///
    /// Half of the event identity `(sourceId, sourceSeq)`. Scoped to the
    /// producer and the bundle, not globally unique — a reader assigns its own
    /// local ids on import and keeps this for lineage, exactly as #763
    /// requires for bundle components.
    pub source_id: String,
    /// Producer identity.
    pub producer: ProducerIdentity,
    /// What the producer claims about redaction. Advisory only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction: Option<ProducerRedactionClaim>,
    /// Optional human label for the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
}

/// One normalized log event: one line of the file after the header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedLogEvent {
    /// Monotonically increasing sequence within this source, starting at 0.
    ///
    /// The other half of the identity. Identity is **derived**, never
    /// declared: there is deliberately no `uid`/`eventId` field a producer
    /// could forge, collide, or reuse across files. `(sourceId, sourceSeq)` is
    /// checkable — the validator proves the sequence is strictly increasing
    /// and gap-free — where an opaque producer-chosen uid is not.
    pub source_seq: u64,
    /// This event's time and its provenance.
    pub time: EventTime,
    /// Severity, in #790's four independent fields.
    pub severity: Severity,
    /// Rendered human-readable message.
    pub message: String,
    /// W3C trace identifier. Structurally distinct from `spanId` (#789).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    /// W3C span identifier. Never accepted as a trace identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    /// Typed correlations from the eleven classes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub correlations: Vec<Correlation>,
    /// Bounded structured attributes.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub attributes: serde_json::Map<String, serde_json::Value>,
    /// Logger or component name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    /// Service identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// Host identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The original record text, verbatim, bounded to
    /// [`MAX_CANONICAL_BYTES`].
    ///
    /// Retaining this is what makes the contract honest: a reader can always
    /// show what the producer actually saw, and can re-parse it if it distrusts
    /// the normalization. Multi-line originals keep their newlines here, which
    /// is why moving framing to the producer loses nothing.
    ///
    /// Subject to ContextDesk's redaction on import like any other text.
    pub canonical: String,
    /// True when `canonical` was truncated at [`MAX_CANONICAL_BYTES`].
    ///
    /// Disclosed rather than silent, so "round trip" is never claimed for a
    /// record that cannot round-trip.
    #[serde(default, skip_serializing_if = "is_false")]
    pub canonical_truncated: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Stable machine-readable validation codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedLogDiagnosticCode {
    /// File was empty, so it has no header.
    MissingHeader,
    /// Header line was not valid JSON, or not an object.
    HeaderMalformed,
    /// `schemaId` was absent or not [`NORMALIZED_LOG_EVENTS_SCHEMA_ID`].
    SchemaIdInvalid,
    /// `minReaderVersion` exceeds this build.
    ReaderTooOld,
    /// `minReaderVersion` was zero or absent.
    MinReaderVersionInvalid,
    /// An identifier field was empty or over its bound.
    IdentifierInvalid,
    /// An event line was not valid JSON, or not an object.
    EventMalformed,
    /// A line exceeded [`MAX_NORMALIZED_LINE_BYTES`].
    LineTooLong,
    /// `sourceSeq` did not continue the strictly increasing, gap-free run.
    SequenceNotContiguous,
    /// An instant was present where the resolution forbids one — the guessed
    /// instant guard.
    InstantNotPermitted,
    /// An instant was required by the resolution and absent.
    InstantRequired,
    /// An instant was not RFC3339 with an explicit offset.
    InstantMalformed,
    /// `localText` was required by the resolution and absent.
    LocalTextRequired,
    /// `resolvedTimezone` was required by the resolution and absent, or
    /// present where it is not permitted.
    ResolvedTimezoneInvalid,
    /// The declared basis and resolution cannot coexist.
    TimeBasisInconsistent,
    /// `severity.number` was outside 0–[`MAX_SEVERITY_NUMBER`].
    SeverityNumberOutOfRange,
    /// The same correlation class appeared more than once on one event.
    DuplicateCorrelationClass,
    /// Too many correlations, attributes, or over-long keys/values.
    BoundsExceeded,
    /// `canonical` was empty, or truncated without declaring it.
    CanonicalInvalid,
    /// A field carried a forbidden evaluator sentinel.
    ForbiddenSentinel,
    /// A trace or span identifier was malformed.
    TraceIdentifierMalformed,
    /// The line carried a top-level key from [`RESERVED_EVENT_KEYS`], which an
    /// older reader would treat as authoritative wall-clock time.
    ReservedKeyPresent,
    /// A JSON value nested deeper than [`MAX_JSON_DEPTH`].
    DepthExceeded,
    /// The line was not valid UTF-8.
    InvalidUtf8,
    /// Severity confidence and provenance contradict each other.
    SeverityProvenanceInconsistent,
}

/// One validation finding, with a bounded re-redacted sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedLogDiagnostic {
    /// Stable code.
    pub code: NormalizedLogDiagnosticCode,
    /// 1-based line number in the file.
    pub line: u64,
    /// Dotted location within the line, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// Result of validating one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedLogValidation {
    /// True only when there are no diagnostics at all.
    ///
    /// Partial acceptance does not exist: a file with one bad event is not a
    /// file with `n-1` good events. See [`validate_file`].
    pub ok: bool,
    /// Events that parsed and validated cleanly.
    ///
    /// Reported for transparency about how far validation got. It is **not** a
    /// count of importable events — when `ok` is false, nothing is importable.
    pub events_validated: u64,
    /// All findings, ordered by line.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<NormalizedLogDiagnostic>,
    /// Bounded, re-redacted excerpts of offending lines.
    ///
    /// Capped at [`MAX_ERROR_SAMPLES`] entries of
    /// [`MAX_ERROR_SAMPLE_CHARS`] each, and passed through ContextDesk's own
    /// redaction — a malformed line is still log content, and a validation
    /// report is exactly the kind of artifact that gets pasted into a ticket.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub error_samples: Vec<String>,
}

/// Whether a string is a plausible RFC3339 instant with an explicit offset.
///
/// Deliberately strict about the offset: an instant with no offset is exactly
/// the guessed instant this contract refuses to represent, so it must fail
/// here rather than be normalized to UTC by a lenient parser.
fn is_rfc3339_with_offset(value: &str) -> bool {
    // Minimum: 1970-01-01T00:00:00Z
    if value.len() < 20 {
        return false;
    }
    let bytes = value.as_bytes();
    let digits_ok = |range: std::ops::Range<usize>| {
        range
            .clone()
            .all(|index| bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()))
    };
    if !digits_ok(0..4) || bytes.get(4) != Some(&b'-') {
        return false;
    }
    if !digits_ok(5..7) || bytes.get(7) != Some(&b'-') {
        return false;
    }
    if !digits_ok(8..10) || bytes.get(10) != Some(&b'T') {
        return false;
    }
    if !digits_ok(11..13) || bytes.get(13) != Some(&b':') {
        return false;
    }
    if !digits_ok(14..16) || bytes.get(16) != Some(&b':') {
        return false;
    }
    if !digits_ok(17..19) {
        return false;
    }
    // Byte-safe throughout: the crate warns on `clippy::string_slice` precisely
    // because indexing a `str` can panic mid-character, and this function is
    // fed producer-controlled text.
    let rest = match value.get(19..) {
        Some(rest) => rest,
        None => return false,
    };
    let rest = match rest.strip_prefix('.') {
        None => rest,
        Some(fraction) => {
            let digits = fraction.chars().take_while(char::is_ascii_digit).count();
            if digits == 0 {
                return false;
            }
            match fraction.get(digits..) {
                Some(tail) => tail,
                None => return false,
            }
        }
    };
    if rest == "Z" || rest == "z" {
        return true;
    }
    // ±HH:MM, and never -00:00 (RFC3339 reserves it for "offset unknown",
    // which is the same thing as not having one).
    let offset = rest.as_bytes();
    if offset.len() != 6 || (offset[0] != b'+' && offset[0] != b'-') {
        return false;
    }
    if offset[3] != b':' {
        return false;
    }
    if !offset[1..3].iter().all(u8::is_ascii_digit) || !offset[4..6].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    // Digit shape alone is not an offset: RFC3339 bounds hours to 00-23 and
    // minutes to 00-59. Without this, `+30:00` and `+99:99` passed here while
    // the JSON Schema and both reference producers rejected them — the
    // authority disagreeing with everything that mirrors it.
    let hours = (offset[1] - b'0') * 10 + (offset[2] - b'0');
    let minutes = (offset[4] - b'0') * 10 + (offset[5] - b'0');
    if hours > 23 || minutes > 59 {
        return false;
    }
    rest != "-00:00"
}

/// Whether an identifier is non-empty, bounded, and control-free.
fn is_valid_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_NORMALIZED_ID_CHARS
        && !value.chars().any(char::is_control)
}

/// Whether a trace/span identifier is lowercase hex of the right shape.
fn is_hex_identifier(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value == value.to_ascii_lowercase()
        && value.bytes().any(|byte| byte != b'0')
}

/// Validate one header.
pub fn validate_header(
    header: &NormalizedLogHeader,
    line: u64,
    out: &mut Vec<NormalizedLogDiagnostic>,
) {
    let mut push = |code: NormalizedLogDiagnosticCode, location: &str| {
        out.push(NormalizedLogDiagnostic {
            code,
            line,
            location: Some(location.to_string()),
        });
    };
    if !SUPPORTED_SCHEMA_IDS.contains(&header.schema_id.as_str()) {
        push(NormalizedLogDiagnosticCode::SchemaIdInvalid, "schemaId");
    }
    if header.min_reader_version == 0 {
        push(
            NormalizedLogDiagnosticCode::MinReaderVersionInvalid,
            "minReaderVersion",
        );
    } else if header.min_reader_version > NORMALIZED_LOG_EVENTS_READER_VERSION {
        push(
            NormalizedLogDiagnosticCode::ReaderTooOld,
            "minReaderVersion",
        );
    }
    if !is_valid_identifier(&header.source_id) {
        push(NormalizedLogDiagnosticCode::IdentifierInvalid, "sourceId");
    }
    if !is_valid_identifier(&header.producer.name) {
        push(
            NormalizedLogDiagnosticCode::IdentifierInvalid,
            "producer.name",
        );
    }
    if !is_valid_identifier(&header.producer.version) {
        push(
            NormalizedLogDiagnosticCode::IdentifierInvalid,
            "producer.version",
        );
    }
    if let Some(label) = &header.source_label {
        if label.chars().count() > MAX_NORMALIZED_ID_CHARS {
            push(
                NormalizedLogDiagnosticCode::IdentifierInvalid,
                "sourceLabel",
            );
        }
    }
    for text in [
        header.source_id.as_str(),
        header.producer.name.as_str(),
        header.source_label.as_deref().unwrap_or(""),
        header
            .redaction
            .as_ref()
            .and_then(|claim| claim.note.as_deref())
            .unwrap_or(""),
    ] {
        if crate::incident_evidence::contains_forbidden_sentinel(text) {
            push(NormalizedLogDiagnosticCode::ForbiddenSentinel, "header");
        }
    }
}

/// The timestamp legality matrix, enforced.
///
/// | resolution | `instant` | `localText` | `resolvedTimezone` |
/// | --- | --- | --- | --- |
/// | `source_explicit` | **required** | optional | forbidden |
/// | `producer_resolved` | **required** | **required** | **required** |
/// | `unresolved` | **forbidden** | **required** | forbidden |
/// | `order_only` | **forbidden** | forbidden | forbidden |
///
/// There is no row that produces an instant without either an explicit offset
/// in the source or a producer-declared timezone. That is the whole point: a
/// guessed instant has no representation, so it cannot be emitted, cannot be
/// validated, and cannot reach a reader.
///
/// Basis is checked against resolution too — an `order` basis with an instant,
/// or a `wall` basis with no instant, are both contradictions.
pub fn validate_event_time(time: &EventTime, line: u64, out: &mut Vec<NormalizedLogDiagnostic>) {
    let mut push = |code: NormalizedLogDiagnosticCode, location: &str| {
        out.push(NormalizedLogDiagnostic {
            code,
            line,
            location: Some(location.to_string()),
        });
    };

    let instant_permitted = matches!(
        time.resolution,
        TimeResolution::SourceExplicit | TimeResolution::ProducerResolved
    );
    match (&time.instant, instant_permitted) {
        (Some(instant), true) => {
            if !is_rfc3339_with_offset(instant) {
                push(
                    NormalizedLogDiagnosticCode::InstantMalformed,
                    "time.instant",
                );
            }
        }
        (Some(_), false) => push(
            NormalizedLogDiagnosticCode::InstantNotPermitted,
            "time.instant",
        ),
        (None, true) => push(NormalizedLogDiagnosticCode::InstantRequired, "time.instant"),
        (None, false) => {}
    }

    let local_required = matches!(
        time.resolution,
        TimeResolution::ProducerResolved | TimeResolution::Unresolved
    );
    if local_required && time.local_text.is_none() {
        push(
            NormalizedLogDiagnosticCode::LocalTextRequired,
            "time.localText",
        );
    }
    if matches!(time.resolution, TimeResolution::OrderOnly) && time.local_text.is_some() {
        push(
            NormalizedLogDiagnosticCode::TimeBasisInconsistent,
            "time.localText",
        );
    }

    match (
        &time.resolved_timezone,
        matches!(time.resolution, TimeResolution::ProducerResolved),
    ) {
        (Some(zone), true) => {
            // Must be a REAL IANA zone, not merely a non-empty string. The
            // point of `producer_resolved` is that its provenance is
            // checkable; accepting "Mars/Olympus" would let a guessed instant
            // be laundered through a plausible-looking declaration.
            if zone.trim().is_empty()
                || zone.chars().count() > MAX_NORMALIZED_ID_CHARS
                || zone.parse::<chrono_tz::Tz>().is_err()
            {
                push(
                    NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
                    "time.resolvedTimezone",
                );
            }
        }
        (Some(_), false) => push(
            NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
            "time.resolvedTimezone",
        ),
        (None, true) => push(
            NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
            "time.resolvedTimezone",
        ),
        (None, false) => {}
    }

    let basis_ok = match time.resolution {
        TimeResolution::SourceExplicit | TimeResolution::ProducerResolved => {
            matches!(time.basis, TimeBasis::Wall)
        }
        TimeResolution::Unresolved | TimeResolution::OrderOnly => {
            matches!(time.basis, TimeBasis::Order | TimeBasis::Relative)
        }
    };
    if !basis_ok {
        push(
            NormalizedLogDiagnosticCode::TimeBasisInconsistent,
            "time.basis",
        );
    }

    if let Some(observed) = &time.observed {
        if !is_rfc3339_with_offset(observed) {
            push(
                NormalizedLogDiagnosticCode::InstantMalformed,
                "time.observed",
            );
        }
    }
}

/// Maximum nesting depth of a JSON value.
fn json_depth(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Object(map) => 1 + map.values().map(json_depth).max().unwrap_or(0),
        serde_json::Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// Whether a confidence/provenance pair is coherent.
///
/// The pair is the whole point of keeping both: a text inference that claims
/// high confidence, or a source-declared value that claims low, would let a
/// guess wear the clothes of source truth.
fn severity_pair_is_coherent(
    confidence: SeverityConfidence,
    provenance: SeverityProvenance,
) -> bool {
    match provenance {
        SeverityProvenance::SourceDeclared => confidence == SeverityConfidence::High,
        SeverityProvenance::SchemaMapped => confidence != SeverityConfidence::Low,
        SeverityProvenance::TextInferred => confidence == SeverityConfidence::Low,
        SeverityProvenance::Absent => true,
    }
}

/// Validate one event, including its position in the sequence.
pub fn validate_event(
    event: &NormalizedLogEvent,
    expected_seq: u64,
    line: u64,
    out: &mut Vec<NormalizedLogDiagnostic>,
) {
    if event.source_seq != expected_seq {
        out.push(NormalizedLogDiagnostic {
            code: NormalizedLogDiagnosticCode::SequenceNotContiguous,
            line,
            location: Some("sourceSeq".to_string()),
        });
    }

    validate_event_time(&event.time, line, out);

    let mut push = |code: NormalizedLogDiagnosticCode, location: &str| {
        out.push(NormalizedLogDiagnostic {
            code,
            line,
            location: Some(location.to_string()),
        });
    };

    if let Some(canonical) = event.severity.canonical {
        if canonical > MAX_SEVERITY_NUMBER {
            push(
                NormalizedLogDiagnosticCode::SeverityNumberOutOfRange,
                "severity.canonical",
            );
        }
    }
    if !severity_pair_is_coherent(event.severity.confidence, event.severity.provenance) {
        push(
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
            "severity",
        );
    }
    if matches!(event.severity.provenance, SeverityProvenance::Absent)
        && event.severity.raw.is_some()
    {
        // "The source expressed no severity" and "here is the source's
        // severity" cannot both be true.
        push(
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
            "severity.raw",
        );
    }
    if let Some(raw) = &event.severity.raw {
        if json_depth(raw) > MAX_JSON_DEPTH {
            push(NormalizedLogDiagnosticCode::DepthExceeded, "severity.raw");
        }
    }

    if let Some(trace) = &event.trace_id {
        if !is_hex_identifier(trace, 32) {
            push(
                NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
                "traceId",
            );
        }
    }
    if let Some(span) = &event.span_id {
        if !is_hex_identifier(span, 16) {
            push(
                NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
                "spanId",
            );
        }
    }

    if event.correlations.len() > MAX_CORRELATIONS_PER_EVENT {
        push(NormalizedLogDiagnosticCode::BoundsExceeded, "correlations");
    }
    let mut seen = BTreeSet::new();
    for correlation in &event.correlations {
        if !seen.insert(correlation.class) {
            push(
                NormalizedLogDiagnosticCode::DuplicateCorrelationClass,
                "correlations",
            );
        }
        if !is_valid_identifier(&correlation.value) {
            push(
                NormalizedLogDiagnosticCode::IdentifierInvalid,
                "correlations",
            );
        }
    }

    if event.attributes.len() > MAX_ATTRIBUTES_PER_EVENT {
        push(NormalizedLogDiagnosticCode::BoundsExceeded, "attributes");
    }
    for (key, value) in &event.attributes {
        if key.is_empty() || key.chars().count() > MAX_ATTRIBUTE_KEY_CHARS {
            push(NormalizedLogDiagnosticCode::BoundsExceeded, "attributes");
        }
        if json_depth(value) > MAX_JSON_DEPTH {
            push(NormalizedLogDiagnosticCode::DepthExceeded, "attributes");
        }
    }

    if event.message.chars().count() > MAX_MESSAGE_CHARS {
        push(NormalizedLogDiagnosticCode::BoundsExceeded, "message");
    }

    if event.canonical.is_empty() {
        push(NormalizedLogDiagnosticCode::CanonicalInvalid, "canonical");
    }
    if event.canonical.len() > MAX_CANONICAL_BYTES {
        push(NormalizedLogDiagnosticCode::CanonicalInvalid, "canonical");
    }

    for text in [event.message.as_str(), event.canonical.as_str()] {
        if crate::incident_evidence::contains_forbidden_sentinel(text) {
            push(NormalizedLogDiagnosticCode::ForbiddenSentinel, "event");
        }
    }
}

/// Bounded, re-redacted excerpt of an offending line.
///
/// Two redaction passes plus a sentinel check, matching the representative
/// excerpt rules used elsewhere in the crate. A validation report is a
/// shareable artifact; an unredacted "here is the line that failed" would make
/// the validator itself the leak.
fn error_sample(raw: &str) -> String {
    let scrubbed = crate::log_analysis::redact_log::redact_message(raw);
    let candidate = crate::redact::redact_candidate(&scrubbed);
    let text = if candidate.blocked {
        "[credential-dominant line redacted]".to_string()
    } else {
        candidate.text
    };
    let text = if crate::incident_evidence::contains_forbidden_sentinel(&text) {
        "[protected evaluator marker omitted]".to_string()
    } else {
        text
    };
    let one_line = text.replace(['\r', '\n'], " ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= MAX_ERROR_SAMPLE_CHARS {
        return trimmed.to_string();
    }
    let kept: String = trimmed.chars().take(MAX_ERROR_SAMPLE_CHARS - 1).collect();
    format!("{kept}…")
}

/// Validate a normalized-log file from a **stream**, without ever holding the
/// whole file in memory.
///
/// [`validate_file`] takes a `&str`, which means the caller already read the
/// entire file — fine for a fixture, wrong for a multi-gigabyte export. This
/// reads one line at a time with a bounded buffer and refuses a line longer
/// than [`MAX_NORMALIZED_LINE_BYTES`] *without* buffering it, so an
/// unterminated 4 GiB "line" costs the reader a bounded read rather than the
/// process.
///
/// Invalid UTF-8 is a diagnostic, not a panic and not a lossy substitution:
/// silently replacing bytes would change the content being validated.
///
/// Diagnostics carry a record number and a field location, never payload and
/// never a filesystem path — a validation report is a shareable artifact.
pub fn validate_stream<R: std::io::BufRead>(reader: R) -> CoreResult<NormalizedLogValidation> {
    let mut diagnostics = Vec::new();
    let mut samples: Vec<String> = Vec::new();
    let mut events_validated = 0u64;
    let mut expected_seq = 0u64;
    let mut line_number = 0u64;
    let mut saw_header = false;

    let mut reader = reader;
    let mut raw: Vec<u8> = Vec::new();

    loop {
        raw.clear();
        // Bounded: read at most one byte past the limit so an over-long line is
        // detected without being materialized.
        // Bounded by hand rather than via `Take`, which does not expose
        // `read_until`: read one byte past the limit so an over-long line is
        // detected without materializing it.
        let read = read_bounded_line(&mut reader, &mut raw, MAX_NORMALIZED_LINE_BYTES + 1)
            .map_err(|error| crate::error::CoreError::Message(format!("read stream: {error}")))?;
        if read == 0 {
            break;
        }
        line_number += 1;

        if raw.last() == Some(&b'\n') {
            raw.pop();
        }
        if raw.last() == Some(&b'\r') {
            raw.pop();
        }

        if raw.len() > MAX_NORMALIZED_LINE_BYTES {
            diagnostics.push(NormalizedLogDiagnostic {
                code: NormalizedLogDiagnosticCode::LineTooLong,
                line: line_number,
                location: None,
            });
            // No drain needed: `read_bounded_line` already consumed through the
            // newline and merely capped what it STORED, so the stream is
            // already aligned on the next record. Draining here would eat the
            // following line instead.
            continue;
        }

        let text = match std::str::from_utf8(&raw) {
            Ok(text) => text,
            Err(_) => {
                diagnostics.push(NormalizedLogDiagnostic {
                    code: NormalizedLogDiagnosticCode::InvalidUtf8,
                    line: line_number,
                    location: None,
                });
                continue;
            }
        };

        if !saw_header {
            saw_header = true;
            match serde_json::from_str::<NormalizedLogHeader>(text) {
                Ok(header) => validate_header(&header, line_number, &mut diagnostics),
                Err(_) => {
                    diagnostics.push(NormalizedLogDiagnostic {
                        code: NormalizedLogDiagnosticCode::HeaderMalformed,
                        line: line_number,
                        location: None,
                    });
                    if samples.len() < MAX_ERROR_SAMPLES {
                        samples.push(error_sample(text));
                    }
                }
            }
            continue;
        }

        if text.trim().is_empty() {
            continue;
        }

        let before = diagnostics.len();
        validate_line_as_event(text, expected_seq, line_number, &mut diagnostics);
        match serde_json::from_str::<NormalizedLogEvent>(text) {
            Ok(event) => {
                if diagnostics.len() == before {
                    events_validated += 1;
                } else if samples.len() < MAX_ERROR_SAMPLES {
                    samples.push(error_sample(text));
                }
                expected_seq = event.source_seq.saturating_add(1);
            }
            Err(_) => {
                if samples.len() < MAX_ERROR_SAMPLES {
                    samples.push(error_sample(text));
                }
                expected_seq = expected_seq.saturating_add(1);
            }
        }
    }

    if !saw_header {
        diagnostics.push(NormalizedLogDiagnostic {
            code: NormalizedLogDiagnosticCode::MissingHeader,
            line: 0,
            location: None,
        });
    }

    diagnostics.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then(left.code.cmp(&right.code))
            .then(left.location.cmp(&right.location))
    });

    Ok(NormalizedLogValidation {
        ok: diagnostics.is_empty(),
        events_validated,
        diagnostics,
        error_samples: samples,
    })
}

/// Read one newline-terminated line, never buffering more than `limit` bytes.
fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
    out: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let available = match reader.fill_buf() {
            Ok(buffer) => buffer,
            Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(total);
        }
        match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                let take = index + 1;
                if out.len() < limit {
                    let room = limit - out.len();
                    out.extend_from_slice(&available[..take.min(room)]);
                }
                reader.consume(take);
                return Ok(total + take);
            }
            None => {
                let len = available.len();
                if out.len() < limit {
                    let room = limit - out.len();
                    out.extend_from_slice(&available[..len.min(room)]);
                }
                reader.consume(len);
                total += len;
            }
        }
    }
}

/// Shared event-line checking used by both the buffered and streaming paths,
/// so the two can never drift about what conformance means.
fn validate_line_as_event(
    raw: &str,
    expected_seq: u64,
    line_number: u64,
    diagnostics: &mut Vec<NormalizedLogDiagnostic>,
) {
    // Reserved keys are checked against the RAW line: serde drops unknown
    // fields before a typed check could see them.
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) {
        for reserved in RESERVED_EVENT_KEYS {
            if map.contains_key(*reserved) {
                diagnostics.push(NormalizedLogDiagnostic {
                    code: NormalizedLogDiagnosticCode::ReservedKeyPresent,
                    line: line_number,
                    location: Some((*reserved).to_string()),
                });
            }
        }
        if json_depth(&serde_json::Value::Object(map)) > MAX_JSON_DEPTH {
            diagnostics.push(NormalizedLogDiagnostic {
                code: NormalizedLogDiagnosticCode::DepthExceeded,
                line: line_number,
                location: None,
            });
        }
    }

    match serde_json::from_str::<NormalizedLogEvent>(raw) {
        Ok(event) => validate_event(&event, expected_seq, line_number, diagnostics),
        Err(_) => diagnostics.push(NormalizedLogDiagnostic {
            code: NormalizedLogDiagnosticCode::EventMalformed,
            line: line_number,
            location: None,
        }),
    }
}

/// Validate a complete normalized-log file.
///
/// # Fail closed
///
/// A file is conforming or it is not. There is no partial acceptance, and
/// `ok == false` means **no** event from this file may be imported — not
/// "import the good ones". Half a normalized source is worse than none: the
/// gaps are invisible downstream, the sequence no longer proves contiguity,
/// and a reader would silently under-report a corpus while believing it had
/// the whole thing. This mirrors the bundle rule that a partial publication
/// never happens.
///
/// `events_validated` is therefore transparency about how far validation got,
/// never a count of usable events.
pub fn validate_file(contents: &str) -> NormalizedLogValidation {
    let mut diagnostics = Vec::new();
    let mut samples = Vec::new();
    let mut events_validated = 0u64;

    let mut lines = contents.lines().enumerate();

    let Some((_, header_line)) = lines.next() else {
        return NormalizedLogValidation {
            ok: false,
            events_validated: 0,
            diagnostics: vec![NormalizedLogDiagnostic {
                code: NormalizedLogDiagnosticCode::MissingHeader,
                line: 0,
                location: None,
            }],
            error_samples: Vec::new(),
        };
    };

    if header_line.len() > MAX_NORMALIZED_LINE_BYTES {
        diagnostics.push(NormalizedLogDiagnostic {
            code: NormalizedLogDiagnosticCode::LineTooLong,
            line: 1,
            location: None,
        });
    }
    match serde_json::from_str::<NormalizedLogHeader>(header_line) {
        Ok(header) => validate_header(&header, 1, &mut diagnostics),
        Err(_) => {
            diagnostics.push(NormalizedLogDiagnostic {
                code: NormalizedLogDiagnosticCode::HeaderMalformed,
                line: 1,
                location: None,
            });
            if samples.len() < MAX_ERROR_SAMPLES {
                samples.push(error_sample(header_line));
            }
        }
    }

    let mut expected_seq = 0u64;
    for (index, raw) in lines {
        let line_number = (index + 1) as u64;
        if raw.trim().is_empty() {
            continue;
        }
        if raw.len() > MAX_NORMALIZED_LINE_BYTES {
            diagnostics.push(NormalizedLogDiagnostic {
                code: NormalizedLogDiagnosticCode::LineTooLong,
                line: line_number,
                location: None,
            });
            continue;
        }
        let before = diagnostics.len();
        validate_line_as_event(raw, expected_seq, line_number, &mut diagnostics);
        match serde_json::from_str::<NormalizedLogEvent>(raw) {
            Ok(event) => {
                if diagnostics.len() == before {
                    events_validated += 1;
                } else if samples.len() < MAX_ERROR_SAMPLES {
                    samples.push(error_sample(raw));
                }
                expected_seq = event.source_seq.saturating_add(1);
            }
            Err(_) => {
                if samples.len() < MAX_ERROR_SAMPLES {
                    samples.push(error_sample(raw));
                }
                expected_seq = expected_seq.saturating_add(1);
            }
        }
    }

    diagnostics.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then(left.code.cmp(&right.code))
            .then(left.location.cmp(&right.location))
    });

    NormalizedLogValidation {
        ok: diagnostics.is_empty(),
        events_validated,
        diagnostics,
        error_samples: samples,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> NormalizedLogHeader {
        NormalizedLogHeader {
            schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.to_string(),
            min_reader_version: 1,
            source_id: "checkout-api".to_string(),
            producer: ProducerIdentity {
                name: "example-exporter".to_string(),
                version: "1.0.0".to_string(),
            },
            redaction: Some(ProducerRedactionClaim {
                credentials_removed: true,
                personal_data_removed: false,
                note: None,
            }),
            source_label: Some("checkout api".to_string()),
        }
    }

    fn event(seq: u64, time: EventTime) -> NormalizedLogEvent {
        NormalizedLogEvent {
            source_seq: seq,
            time,
            severity: Severity {
                raw: Some(serde_json::json!(6)),
                canonical: Some(9),
                confidence: SeverityConfidence::High,
                provenance: SeverityProvenance::SourceDeclared,
            },
            message: "checkout completed".to_string(),
            trace_id: None,
            span_id: None,
            correlations: Vec::new(),
            attributes: serde_json::Map::new(),
            logger: None,
            service: None,
            host: None,
            canonical: "2026-01-01T00:00:00Z INFO checkout completed".to_string(),
            canonical_truncated: false,
        }
    }

    fn explicit() -> EventTime {
        EventTime {
            basis: TimeBasis::Wall,
            resolution: TimeResolution::SourceExplicit,
            instant: Some("2026-01-01T00:00:00Z".to_string()),
            local_text: None,
            resolved_timezone: None,
            observed: None,
        }
    }

    fn codes(diagnostics: &[NormalizedLogDiagnostic]) -> Vec<NormalizedLogDiagnosticCode> {
        diagnostics.iter().map(|d| d.code).collect()
    }

    #[test]
    fn a_conforming_file_validates() {
        let mut text = serde_json::to_string(&header()).unwrap();
        for seq in 0..3 {
            text.push('\n');
            text.push_str(&serde_json::to_string(&event(seq, explicit())).unwrap());
        }
        let report = validate_file(&text);
        assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
        assert_eq!(report.events_validated, 3);
    }

    #[test]
    fn a_guessed_instant_has_no_representation() {
        // Unresolved local time may not carry an instant...
        let mut time = explicit();
        time.resolution = TimeResolution::Unresolved;
        time.basis = TimeBasis::Order;
        time.local_text = Some("2026-01-01 00:00:00".to_string());
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::InstantNotPermitted));

        // ...nor may order-only.
        let mut time = explicit();
        time.resolution = TimeResolution::OrderOnly;
        time.basis = TimeBasis::Order;
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::InstantNotPermitted));
    }

    #[test]
    fn an_instant_without_an_offset_is_refused() {
        // This is the guessed instant in disguise: a local time that a lenient
        // parser would silently call UTC.
        let mut time = explicit();
        time.instant = Some("2026-01-01T00:00:00".to_string());
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::InstantMalformed));

        // RFC3339 reserves -00:00 for "offset unknown" — same thing as none.
        let mut time = explicit();
        time.instant = Some("2026-01-01T00:00:00-00:00".to_string());
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::InstantMalformed));

        for good in [
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123Z",
            "2026-01-01T00:00:00+05:30",
            "2026-01-01T00:00:00.000001-08:00",
        ] {
            let mut time = explicit();
            time.instant = Some(good.to_string());
            let mut out = Vec::new();
            validate_event_time(&time, 2, &mut out);
            assert!(out.is_empty(), "{good} should be legal: {out:?}");
        }
    }

    #[test]
    fn producer_resolved_must_declare_its_timezone_and_keep_the_local_text() {
        let mut time = explicit();
        time.resolution = TimeResolution::ProducerResolved;
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        let found = codes(&out);
        assert!(found.contains(&NormalizedLogDiagnosticCode::LocalTextRequired));
        assert!(found.contains(&NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid));

        // Complete and legal.
        time.local_text = Some("2026-01-01 00:00:00".to_string());
        time.resolved_timezone = Some("America/Chicago".to_string());
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn a_source_explicit_event_may_not_claim_a_producer_timezone() {
        // Otherwise "resolved by producer" could hide behind source truth.
        let mut time = explicit();
        time.resolved_timezone = Some("America/Chicago".to_string());
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid));
    }

    #[test]
    fn wall_basis_requires_an_instant_and_order_basis_forbids_one() {
        let mut time = explicit();
        time.basis = TimeBasis::Order;
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::TimeBasisInconsistent));

        let mut time = explicit();
        time.resolution = TimeResolution::OrderOnly;
        time.instant = None;
        time.basis = TimeBasis::Wall;
        let mut out = Vec::new();
        validate_event_time(&time, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::TimeBasisInconsistent));
    }

    #[test]
    fn identity_is_derived_and_the_sequence_must_be_contiguous() {
        let mut text = serde_json::to_string(&header()).unwrap();
        for seq in [0u64, 1, 3] {
            text.push('\n');
            text.push_str(&serde_json::to_string(&event(seq, explicit())).unwrap());
        }
        let report = validate_file(&text);
        assert!(!report.ok);
        assert!(codes(&report.diagnostics)
            .contains(&NormalizedLogDiagnosticCode::SequenceNotContiguous));
    }

    #[test]
    fn there_is_no_producer_supplied_identity_field() {
        // A forged/duplicated uid is impossible because no such field exists;
        // an unknown extra field is simply not part of the type.
        let encoded = serde_json::to_string(&event(0, explicit())).unwrap();
        for forgeable in ["\"uid\"", "\"eventId\"", "\"id\""] {
            assert!(
                !encoded.contains(forgeable),
                "{forgeable} must not be part of the contract"
            );
        }
    }

    #[test]
    fn span_ids_cannot_be_routed_into_the_trace_slot() {
        // The eleven correlation classes deliberately exclude trace and span,
        // so the #789 P0 (span_id accepted as a trace alias) has no expression
        // in this contract.
        let serialized: Vec<String> = CorrelationClass::ALL
            .iter()
            .map(|class| serde_json::to_string(class).unwrap())
            .collect();
        assert_eq!(serialized.len(), 11);
        assert!(!serialized.iter().any(|value| value.contains("trace")));
        assert!(!serialized.iter().any(|value| value.contains("span")));
        assert_eq!(
            serialized,
            vec![
                "\"request\"",
                "\"session\"",
                "\"transaction\"",
                "\"activity\"",
                "\"audit\"",
                "\"flow\"",
                "\"boot\"",
                "\"container\"",
                "\"pod\"",
                "\"event\"",
                "\"query\""
            ]
        );
    }

    #[test]
    fn trace_and_span_identifiers_are_shape_checked() {
        let mut item = event(0, explicit());
        // A 16-hex span value in the trace field is the exact P0 shape.
        item.trace_id = Some("00f067aa0ba902b7".to_string());
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::TraceIdentifierMalformed));

        let mut item = event(0, explicit());
        item.trace_id = Some("4bf92f3577b34da6a3ce929d0e0e4736".to_string());
        item.span_id = Some("00f067aa0ba902b7".to_string());
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(out.is_empty(), "{out:?}");

        // All-zero identifiers are the W3C "invalid" sentinel.
        let mut item = event(0, explicit());
        item.trace_id = Some("0".repeat(32));
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::TraceIdentifierMalformed));
    }

    #[test]
    fn duplicate_correlation_classes_are_rejected() {
        let mut item = event(0, explicit());
        item.correlations = vec![
            Correlation {
                class: CorrelationClass::Request,
                value: "r-1".to_string(),
            },
            Correlation {
                class: CorrelationClass::Request,
                value: "r-2".to_string(),
            },
        ];
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::DuplicateCorrelationClass));
    }

    #[test]
    fn severity_keeps_four_independent_fields_and_bounds_the_number() {
        let mut item = event(0, explicit());
        item.severity.canonical = Some(25);
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::SeverityNumberOutOfRange));

        // The source's own value survives verbatim beside the canonical one.
        let item_severity = Severity {
            raw: Some(serde_json::json!("D2")),
            canonical: Some(13),
            confidence: SeverityConfidence::Low,
            provenance: SeverityProvenance::TextInferred,
        };
        let encoded = serde_json::to_string(&item_severity).unwrap();
        assert!(encoded.contains("\"raw\":\"D2\""));
        assert!(encoded.contains("\"canonical\":13"));
        assert!(
            encoded.contains("\"confidence\":\"low\"")
                && encoded.contains("\"provenance\":\"text_inferred\""),
            "confidence and provenance must always serialize so a guess can \
             never read as source-declared"
        );
    }

    #[test]
    fn confidence_and_provenance_always_serialize() {
        let item = event(0, explicit());
        let encoded = serde_json::to_string(&item.severity).unwrap();
        assert!(encoded.contains("\"confidence\":\"high\""));
        assert!(encoded.contains("\"provenance\":\"source_declared\""));
    }

    #[test]
    fn severity_confidence_and_provenance_must_agree() {
        // A text inference claiming high confidence would let a guess wear the
        // clothes of source truth; a source-declared value claiming low would
        // understate real evidence.
        for (confidence, provenance, ok) in [
            (
                SeverityConfidence::High,
                SeverityProvenance::SourceDeclared,
                true,
            ),
            (
                SeverityConfidence::Low,
                SeverityProvenance::SourceDeclared,
                false,
            ),
            (
                SeverityConfidence::High,
                SeverityProvenance::TextInferred,
                false,
            ),
            (
                SeverityConfidence::Low,
                SeverityProvenance::TextInferred,
                true,
            ),
            (
                SeverityConfidence::Medium,
                SeverityProvenance::SchemaMapped,
                true,
            ),
            (
                SeverityConfidence::Low,
                SeverityProvenance::SchemaMapped,
                false,
            ),
        ] {
            let mut item = event(0, explicit());
            item.severity = Severity {
                raw: Some(serde_json::json!("X")),
                canonical: Some(9),
                confidence,
                provenance,
            };
            let mut out = Vec::new();
            validate_event(&item, 0, 2, &mut out);
            let inconsistent =
                codes(&out).contains(&NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent);
            assert_eq!(!inconsistent, ok, "{confidence:?}/{provenance:?}");
        }
    }

    #[test]
    fn absent_provenance_cannot_carry_a_raw_value() {
        let mut item = event(0, explicit());
        item.severity = Severity {
            raw: Some(serde_json::json!("WARN")),
            canonical: None,
            confidence: SeverityConfidence::Low,
            provenance: SeverityProvenance::Absent,
        };
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent));
    }

    #[test]
    fn deeply_nested_attributes_are_refused() {
        let mut item = event(0, explicit());
        let mut deep = serde_json::json!("leaf");
        for _ in 0..(MAX_JSON_DEPTH + 2) {
            deep = serde_json::json!({ "n": deep });
        }
        item.attributes.insert("deep".into(), deep);
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::DepthExceeded));
    }

    #[test]
    fn the_streaming_and_buffered_validators_agree() {
        // Two code paths that disagree about conformance would be worse than
        // one; validate_line_as_event is shared precisely to prevent it.
        let mut text = serde_json::to_string(&header()).unwrap();
        for seq in 0..4 {
            text.push('\n');
            text.push_str(&serde_json::to_string(&event(seq, explicit())).unwrap());
        }
        text.push('\n');

        let buffered = validate_file(&text);
        let streamed = validate_stream(std::io::Cursor::new(text.as_bytes())).unwrap();
        assert_eq!(buffered.ok, streamed.ok);
        assert_eq!(buffered.events_validated, streamed.events_validated);
        assert_eq!(buffered.diagnostics, streamed.diagnostics);

        // ...and they agree about a broken file too.
        let broken = text.replace("\"sourceSeq\":2", "\"sourceSeq\":9");
        let buffered = validate_file(&broken);
        let streamed = validate_stream(std::io::Cursor::new(broken.as_bytes())).unwrap();
        assert_eq!(buffered.ok, streamed.ok);
        assert_eq!(buffered.diagnostics, streamed.diagnostics);
    }

    #[test]
    fn the_stream_refuses_an_over_long_line_without_buffering_it() {
        let mut text = serde_json::to_string(&header()).unwrap();
        text.push('\n');
        text.push_str(&"x".repeat(MAX_NORMALIZED_LINE_BYTES + 4096));
        text.push('\n');
        text.push_str(&serde_json::to_string(&event(0, explicit())).unwrap());
        text.push('\n');

        let report = validate_stream(std::io::Cursor::new(text.as_bytes())).unwrap();
        assert!(!report.ok);
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.code == NormalizedLogDiagnosticCode::LineTooLong));
        // Alignment is preserved: the following real event is still seen.
        assert_eq!(report.events_validated, 1);
    }

    #[test]
    fn invalid_utf8_is_a_diagnostic_not_a_panic_or_a_silent_substitution() {
        let mut bytes = serde_json::to_string(&header()).unwrap().into_bytes();
        bytes.push(b'\n');
        bytes.extend_from_slice(&[0xff, 0xfe, 0xfd]);
        bytes.push(b'\n');
        let report = validate_stream(std::io::Cursor::new(bytes)).unwrap();
        assert!(!report.ok);
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.code == NormalizedLogDiagnosticCode::InvalidUtf8));
    }

    #[test]
    fn diagnostics_carry_record_numbers_and_never_payload_or_paths() {
        let mut text = serde_json::to_string(&header()).unwrap();
        text.push_str("\n{\"sourceSeq\":0,\"secret\":\"/Users/someone/private.log\"}\n");
        let report = validate_stream(std::io::Cursor::new(text.as_bytes())).unwrap();
        assert!(!report.ok);
        assert!(report.diagnostics.iter().all(|d| d.line > 0));
        let encoded = serde_json::to_string(&report.diagnostics).unwrap();
        assert!(!encoded.contains("/Users/"));
        assert!(!encoded.contains("private.log"));
    }

    #[test]
    fn a_single_bad_event_fails_the_whole_file() {
        let mut text = serde_json::to_string(&header()).unwrap();
        text.push('\n');
        text.push_str(&serde_json::to_string(&event(0, explicit())).unwrap());
        text.push_str("\n{not json}\n");
        let mut third = event(2, explicit());
        third.source_seq = 2;
        text.push_str(&serde_json::to_string(&third).unwrap());

        let report = validate_file(&text);
        assert!(!report.ok, "one bad line must fail the file");
        assert!(
            report.events_validated < 3,
            "events_validated is transparency, not a licence to import"
        );
    }

    #[test]
    fn error_samples_are_bounded_and_re_redacted() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let mut text = serde_json::to_string(&header()).unwrap();
        for index in 0..20 {
            text.push_str(&format!(
                "\n{{bad json aws_access_key_id={secret} index={index}"
            ));
        }
        let report = validate_file(&text);
        assert!(!report.ok);
        assert!(report.error_samples.len() <= MAX_ERROR_SAMPLES);
        let encoded = serde_json::to_string(&report).unwrap();
        assert!(
            !encoded.contains(secret),
            "a validation report is shareable; it must not leak the line it rejected"
        );
        for sample in &report.error_samples {
            assert!(sample.chars().count() <= MAX_ERROR_SAMPLE_CHARS);
        }
    }

    #[test]
    fn canonical_is_required_and_bounded() {
        let mut item = event(0, explicit());
        item.canonical = String::new();
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::CanonicalInvalid));

        let mut item = event(0, explicit());
        item.canonical = "x".repeat(MAX_CANONICAL_BYTES + 1);
        let mut out = Vec::new();
        validate_event(&item, 0, 2, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::CanonicalInvalid));
    }

    #[test]
    fn a_multi_line_original_round_trips_through_canonical() {
        // The framing question #788 exists to answer is already answered by
        // the producer here: one event, many physical lines, preserved.
        let mut item = event(0, explicit());
        item.canonical =
            "2026-01-01T00:00:00Z ERROR boom\n\tat com.example.A(A.java:1)\n\tat com.example.B(B.java:2)"
                .to_string();
        let encoded = serde_json::to_string(&item).unwrap();
        assert!(
            !encoded.contains('\n'),
            "the JSONL line itself must stay one physical line"
        );
        let decoded: NormalizedLogEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.canonical, item.canonical);
        assert_eq!(decoded.canonical.lines().count(), 3);
    }

    #[test]
    fn a_newer_file_is_refused_whole_rather_than_partly_understood() {
        let mut head = header();
        head.min_reader_version = NORMALIZED_LOG_EVENTS_READER_VERSION + 1;
        let mut out = Vec::new();
        validate_header(&head, 1, &mut out);
        assert!(codes(&out).contains(&NormalizedLogDiagnosticCode::ReaderTooOld));
    }

    #[test]
    fn producer_redaction_claims_are_not_authority() {
        // The claim is recorded, and it changes nothing: a sentinel in the
        // payload is still caught while the producer swears it cleaned up.
        let head = NormalizedLogHeader {
            redaction: Some(ProducerRedactionClaim {
                credentials_removed: true,
                personal_data_removed: true,
                note: Some("fully sanitized".to_string()),
            }),
            ..header()
        };
        let mut text = serde_json::to_string(&head).unwrap();
        let mut item = event(0, explicit());
        item.message = "case expected_diagnosis=disk-full".to_string();
        text.push('\n');
        text.push_str(&serde_json::to_string(&item).unwrap());

        let report = validate_file(&text);
        assert!(!report.ok);
        assert!(
            codes(&report.diagnostics).contains(&NormalizedLogDiagnosticCode::ForbiddenSentinel)
        );
    }

    #[test]
    fn a_reserved_alias_key_is_refused_even_though_serde_would_ignore_it() {
        // The critical case: an event declares order_only (no usable time),
        // but carries a sidecar `ts` epoch. serde drops the unknown field, so
        // this MUST be caught against the raw line. Verified against the real
        // ingest path: without this guard the old reader placed the corpus on
        // a 2026 wall clock derived from that epoch.
        for reserved in RESERVED_EVENT_KEYS {
            let mut text = serde_json::to_string(&header()).unwrap();
            let mut item = event(0, explicit());
            item.time = EventTime {
                basis: TimeBasis::Order,
                resolution: TimeResolution::OrderOnly,
                instant: None,
                local_text: None,
                resolved_timezone: None,
                observed: None,
            };
            let mut value = serde_json::to_value(&item).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert((*reserved).to_string(), serde_json::json!(1_767_225_600i64));
            text.push('\n');
            text.push_str(&serde_json::to_string(&value).unwrap());

            let report = validate_file(&text);
            assert!(!report.ok, "{reserved} must be refused");
            assert!(
                codes(&report.diagnostics)
                    .contains(&NormalizedLogDiagnosticCode::ReservedKeyPresent),
                "{reserved} should report ReservedKeyPresent"
            );
        }
    }

    #[test]
    fn an_ordinary_additive_field_is_still_tolerated() {
        // The reserved-key guard must not become a blanket deny_unknown_fields:
        // spec rule 3 permits additive optional fields.
        let mut text = serde_json::to_string(&header()).unwrap();
        let mut value = serde_json::to_value(event(0, explicit())).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("futureOptionalField".into(), serde_json::json!({"a": 1}));
        text.push('\n');
        text.push_str(&serde_json::to_string(&value).unwrap());
        let report = validate_file(&text);
        assert!(report.ok, "{:?}", report.diagnostics);
    }

    #[test]
    fn impossible_utc_offsets_are_refused() {
        // Digit shape is not an offset. These passed before the hour/minute
        // bounds were added, while the JSON Schema and both reference
        // producers rejected them — the authority disagreeing with its mirrors.
        for bad in [
            "2026-01-01T00:00:00+24:00",
            "2026-01-01T00:00:00+30:00",
            "2026-01-01T00:00:00+99:99",
            "2026-01-01T00:00:00-99:99",
            "2026-01-01T00:00:00+05:60",
        ] {
            let mut time = explicit();
            time.instant = Some(bad.to_string());
            let mut out = Vec::new();
            validate_event_time(&time, 2, &mut out);
            assert!(
                codes(&out).contains(&NormalizedLogDiagnosticCode::InstantMalformed),
                "{bad} must be refused"
            );
        }
        // The boundary values remain legal.
        for good in ["2026-01-01T00:00:00+23:59", "2026-01-01T00:00:00-23:59"] {
            let mut time = explicit();
            time.instant = Some(good.to_string());
            let mut out = Vec::new();
            validate_event_time(&time, 2, &mut out);
            assert!(out.is_empty(), "{good} must stay legal: {out:?}");
        }
    }

    #[test]
    fn a_producer_resolved_timezone_must_be_a_real_iana_zone() {
        // Otherwise a guessed instant launders through a plausible-looking
        // declaration and the provenance is worthless.
        for bad in ["Mars/Olympus", "Not/AZone", "PST", "UTC+5"] {
            let mut time = explicit();
            time.resolution = TimeResolution::ProducerResolved;
            time.local_text = Some("2026-01-01 00:00:00".into());
            time.resolved_timezone = Some(bad.to_string());
            let mut out = Vec::new();
            validate_event_time(&time, 2, &mut out);
            assert!(
                codes(&out).contains(&NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid),
                "{bad} must be refused"
            );
        }
        for good in ["America/Chicago", "UTC", "Europe/London", "Asia/Tokyo"] {
            let mut time = explicit();
            time.resolution = TimeResolution::ProducerResolved;
            time.local_text = Some("2026-01-01 00:00:00".into());
            time.resolved_timezone = Some(good.to_string());
            let mut out = Vec::new();
            validate_event_time(&time, 2, &mut out);
            assert!(out.is_empty(), "{good} must be accepted: {out:?}");
        }
    }

    #[test]
    fn an_empty_file_has_no_header() {
        let report = validate_file("");
        assert!(!report.ok);
        assert_eq!(
            codes(&report.diagnostics),
            vec![NormalizedLogDiagnosticCode::MissingHeader]
        );
    }

    #[test]
    fn validation_report_serializes_camel_case_with_snake_case_enums() {
        let report = validate_file("");
        let encoded = serde_json::to_string(&report).unwrap();
        assert!(encoded.contains("\"eventsValidated\""));
        assert!(encoded.contains("\"missing_header\""));
    }
}
