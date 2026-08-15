//! Fail-closed, privacy-safe result contract for batch corpus import.
//!
//! The ingest engine already fails closed: a malformed archive aborts the run,
//! staging is removed, and nothing is published. What it could not previously
//! answer is the operator's first question — *which* source, *which* archive
//! member, and *where* inside it. Aggregate counters plus twenty redacted
//! basenames cannot name `outer.zip!/inner.zip!/app.log`, because
//! [`crate::process_progress::LogIngestEvidence`] deliberately discards archive
//! ancestry for the progress channel.
//!
//! This module adds the missing answer as an explicit, versioned document:
//!
//! * a three-way [`ImportOutcomeClass`] — complete, partial, or rejected, so a
//!   caller can never read "partial" as "done";
//! * a bounded, deterministically ordered ledger of [`ImportDefect`]s, each
//!   naming the exact [`SourceLocator`] (full archive member chain) and, where
//!   the engine knows it, the [`RecordLocation`] inside that member;
//! * stable [`ImportDefectCode`]s instead of free-form operating-system, ZIP,
//!   or parser text.
//!
//! # Privacy contract
//!
//! Structural identity is reported; payload never is.
//!
//! * Every path component and archive container name passes through the same
//!   secret scrub the progress channel uses (`redact_basename`), so credentials
//!   embedded in a filename and names resembling private hosts are replaced,
//!   not exposed. That scrub also strips `!` from each component, so a member
//!   literally named `a!/b` cannot forge an extra archive level in the chain.
//! * A [`RecordLocation`] carries ordinals and byte offsets only. There is no
//!   field anywhere in this contract that can hold a log record, a message, a
//!   parsed parameter, or an error string produced by the OS or a ZIP reader.
//!   That is why [`ImportDefect`] has a code and no `detail` — a free-form
//!   detail is exactly where a path-bearing `io::Error` would leak.
//! * Reporting a member identity is already the established boundary elsewhere
//!   in ingest: `SourceIngestConfidence.source` and
//!   `ReviewedFormatApplication.source_identity` are portable identities on the
//!   same wire. [`super::import_diagnose`] is stricter (aggregate-only) because
//!   it is built to be pasted into a public bug report; this contract is the
//!   operator's own result for their own import.

use super::ingest::{IngestReport, IngestStats};
use crate::error::CoreError;
use crate::process_progress::redact_basename;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Public schema id for the import outcome document.
pub const IMPORT_OUTCOME_SCHEMA_ID: &str = "contextdesk.import_outcome.v1";

/// Schema version for [`ImportOutcomeReport`].
pub const IMPORT_OUTCOME_SCHEMA_VERSION: u32 = 1;

/// Maximum individually located defects retained in one report.
///
/// Aggregate `defect_counts` stay complete when this bound truncates the
/// located list, so a truncated report still states the true totals.
pub const MAX_IMPORT_DEFECTS: usize = 64;

/// Maximum archive containers named in one [`SourceLocator`] chain.
///
/// One above [`super::ingest::MAX_RAW_LOG_ARCHIVE_DEPTH`] so a depth-limit
/// refusal can still name the container that tripped it.
pub const MAX_LOCATOR_ARCHIVE_CHAIN: usize = 4;

/// Separator the ingest walk uses between an archive and its member.
pub(crate) const ARCHIVE_MEMBER_SEPARATOR: &str = "!/";

/// Marker that carries a failing member's identity out on an error message.
///
/// The preview walk finds a corrupt nested container while it still knows the
/// member's identity, but it can only return `CoreError` — there is no ledger
/// on that path. Rather than widen a shared error enum used across the crate,
/// the identity rides along in the message behind this marker, and
/// [`ImportOutcomeReport::rejected_from_error`] reads it back. The original
/// message stays intact at the front, so existing callers that match on it
/// (`contains("zip open")`) are unaffected.
///
/// The payload is percent-encoded for `[`, `]`, and `%` so an attacker-
/// controlled ZIP member name cannot forge a second frame or leave a leftover
/// `[member=` after a missed parse. Operator-facing surfaces must still run
/// [`strip_member_annotation`]: a missed caller that prints `Display` raw is
/// fail-open for the marker, which is why every host boundary seals.
const MEMBER_ANNOTATION_MARKER: &str = "[member=";
const MEMBER_ANNOTATION_OPEN: &str = " [member=";
const MEMBER_ANNOTATION_CLOSE: char = ']';

/// Append a failing member's identity to an error message.
///
/// Idempotent by design: the innermost frame that knows the identity annotates
/// it, and outer frames re-propagating the same error leave it alone, so the
/// deepest (most specific) locator is the one that survives. An empty identity
/// is not written — an empty frame is indistinguishable from a parse failure
/// and would only leak the marker.
pub(crate) fn annotate_member(message: &str, identity: &str) -> String {
    if message.contains(MEMBER_ANNOTATION_MARKER) || identity.is_empty() {
        return message.to_string();
    }
    format!(
        "{message}{MEMBER_ANNOTATION_OPEN}{}{MEMBER_ANNOTATION_CLOSE}",
        encode_member_identity(identity)
    )
}

/// Read a member identity back out of an annotated message, if present.
///
/// Fail-closed: a missing closer, an empty payload, or a corrupt encoding
/// yields `None`. The operator seal still strips the marker; the locator is
/// simply omitted rather than guessed from leftover text.
pub(crate) fn member_annotation(message: &str) -> Option<String> {
    let open_at = message.find(MEMBER_ANNOTATION_OPEN)?;
    let start = open_at + MEMBER_ANNOTATION_OPEN.len();
    let rest = message.get(start..)?;
    let end = rest.find(MEMBER_ANNOTATION_CLOSE)?;
    let encoded = rest.get(..end)?;
    if encoded.is_empty() {
        return None;
    }
    // A well-formed annotation is a single frame. Leftover transport after
    // this closer means the string is not ours — do not guess an identity.
    let after = rest.get(end + MEMBER_ANNOTATION_CLOSE.len_utf8()..)?;
    if after.contains(MEMBER_ANNOTATION_MARKER) {
        return None;
    }
    decode_member_identity(encoded)
}

/// The message an operator should see, with any annotation removed.
///
/// Fail-closed: the first occurrence of `[member=` is cut through to the end
/// of the string, whether or not the frame parses. A malformed or nested
/// marker therefore cannot leave leftover `[member=` in operator prose.
pub fn strip_member_annotation(message: &str) -> &str {
    match message.find(MEMBER_ANNOTATION_MARKER) {
        Some(at) => {
            let cut = if at > 0 && message.as_bytes().get(at - 1) == Some(&b' ') {
                at - 1
            } else {
                at
            };
            message.get(..cut).unwrap_or(message).trim_end()
        }
        None => message,
    }
}

/// Operator-facing import error: sealed, optionally naming the scrubbed member.
///
/// This is the function every host should call instead of `error.to_string()`.
/// The transport marker never survives. When the annotation parses, the
/// member is named through the same secret-scrubbed locator the outcome
/// report uses; when it does not, the sealed engine wording stands alone.
pub fn operator_import_error(error: &CoreError) -> String {
    let raw = error.to_string();
    let sealed = strip_member_annotation(&raw);
    debug_assert!(
        !sealed.contains(MEMBER_ANNOTATION_MARKER),
        "seal left a transport marker: {sealed}"
    );
    if member_annotation(&raw).is_none() {
        return sealed.to_string();
    }
    let rejected = ImportOutcomeReport::rejected_from_error(error);
    match rejected.defects.first() {
        Some(defect) if !defect.source.identity.contains(MEMBER_ANNOTATION_MARKER) => {
            format!("{sealed} (failing member: {})", defect.source.identity)
        }
        _ => sealed.to_string(),
    }
}

fn encode_member_identity(identity: &str) -> String {
    let mut out = String::with_capacity(identity.len());
    for ch in identity.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            _ => out.push(ch),
        }
    }
    out
}

fn decode_member_identity(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = from_hex(bytes[i + 1])?;
            let lo = from_hex(bytes[i + 2])?;
            let decoded = (hi << 4) | lo;
            match decoded {
                b'%' => out.push('%'),
                b'[' => out.push('['),
                b']' => out.push(']'),
                _ => return None,
            }
            i += 3;
        } else {
            let ch = encoded[i..].chars().next()?;
            if matches!(ch, '[' | ']') {
                return None;
            }
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    Some(out)
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

/// Map an engine error kind to the code a rejection carries.
fn rejection_code(error: &CoreError) -> ImportDefectCode {
    match error {
        CoreError::Policy(_) => ImportDefectCode::ArchiveUnreadable,
        _ => ImportDefectCode::Unclassified,
    }
}

/// Terminal class of one import run.
///
/// The three values are deliberately not a boolean plus a flag: a caller that
/// matches on this enum cannot accidentally treat a partial corpus as a
/// complete one, which is the failure mode this contract exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportOutcomeClass {
    /// Every discovered source intended for import was read through EOF and
    /// published. No source failed, none was excluded, and no record was
    /// rejected as malformed.
    Complete,
    /// A corpus was published, but it does not contain everything the source
    /// offered. The ledger names what is missing.
    Partial,
    /// Nothing was published. Staging was removed and the library is unchanged.
    Rejected,
}

impl ImportOutcomeClass {
    /// Stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::Rejected => "rejected",
        }
    }

    /// True when a corpus reached the library.
    ///
    /// Both `Complete` and `Partial` publish; only `Complete` may be presented
    /// as the whole of the source.
    pub fn published(self) -> bool {
        matches!(self, Self::Complete | Self::Partial)
    }
}

/// Whether a defect stopped the import or only reduced its coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportDefectSeverity {
    /// Aborted the run. Nothing was published.
    Fatal,
    /// Content intended for import is missing from a published corpus.
    Degraded,
}

impl ImportDefectSeverity {
    /// Stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fatal => "fatal",
            Self::Degraded => "degraded",
        }
    }
}

/// Stable diagnostic code for one import defect.
///
/// Codes are the entire machine-readable explanation. Free-form operating
/// system, ZIP, and parser strings are deliberately excluded: they are
/// unstable across platforms and are the most likely place for an absolute
/// path or a credential to reach a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportDefectCode {
    /// An archive container's central directory could not be read or
    /// preflighted. The locator names the container, not its members.
    ArchiveUnreadable,
    /// A nested archive could not be copied into bounded private staging.
    NestedArchiveStagingFailed,
    /// The source-identity chain exceeded the archive depth bound.
    ArchiveDepthExceeded,
    /// An archive member changed between preflight and read, or its declared
    /// size did not match the bytes streamed.
    ArchiveMemberUnstable,
    /// A member's metadata could not be read.
    MemberMetadataFailed,
    /// A member could not be opened.
    MemberOpenFailed,
    /// A member was opened but could not be read through EOF.
    MemberReadFailed,
    /// A member exceeded the configured size bound.
    MemberTooLarge,
    /// A NUL-bearing member was classified as binary and not parsed.
    MemberBinary,
    /// A member was read completely and yielded no importable record.
    MemberEmpty,
    /// A member was a symlink and was refused by policy.
    MemberSymlink,
    /// A member was neither a regular file nor a directory.
    MemberNonRegular,
    /// A record in a structured (JSON Lines) member was not valid JSON and was
    /// stored as unstructured text instead of the member's declared grammar.
    MalformedStructuredRecord,
    /// A defect the engine recorded without a mapped code. Present so an
    /// unmapped reason is still reported rather than silently dropped.
    Unclassified,
}

impl ImportDefectCode {
    /// Stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArchiveUnreadable => "archive_unreadable",
            Self::NestedArchiveStagingFailed => "nested_archive_staging_failed",
            Self::ArchiveDepthExceeded => "archive_depth_exceeded",
            Self::ArchiveMemberUnstable => "archive_member_unstable",
            Self::MemberMetadataFailed => "member_metadata_failed",
            Self::MemberOpenFailed => "member_open_failed",
            Self::MemberReadFailed => "member_read_failed",
            Self::MemberTooLarge => "member_too_large",
            Self::MemberBinary => "member_binary",
            Self::MemberEmpty => "member_empty",
            Self::MemberSymlink => "member_symlink",
            Self::MemberNonRegular => "member_non_regular",
            Self::MalformedStructuredRecord => "malformed_structured_record",
            Self::Unclassified => "unclassified",
        }
    }

    /// One-line operator explanation. Constant text — never interpolates
    /// source content.
    pub fn operator_hint(self) -> &'static str {
        match self {
            Self::ArchiveUnreadable => "archive could not be opened or preflighted",
            Self::NestedArchiveStagingFailed => "nested archive could not be staged for reading",
            Self::ArchiveDepthExceeded => "archive nesting exceeded the depth bound",
            Self::ArchiveMemberUnstable => "member changed between preflight and read",
            Self::MemberMetadataFailed => "member metadata could not be read",
            Self::MemberOpenFailed => "member could not be opened",
            Self::MemberReadFailed => "member could not be read to the end",
            Self::MemberTooLarge => "member exceeded the size bound",
            Self::MemberBinary => "member looked binary and was not parsed",
            Self::MemberEmpty => "member held no importable record",
            Self::MemberSymlink => "member was a symlink and was refused",
            Self::MemberNonRegular => "member was not a regular file",
            Self::MalformedStructuredRecord => "record was not valid JSON in a JSON Lines member",
            Self::Unclassified => "unmapped ingest omission reason",
        }
    }

    /// Map an ingest omission reason to a code.
    ///
    /// Reasons the engine records for intentional filtering (`directory`,
    /// `hidden`, `not_selected`) are not defects and return `None`; they are
    /// counted as ignored and never make a corpus partial.
    pub fn from_ingest_reason(reason: &str) -> Option<Self> {
        Some(match reason {
            "read_failed" => Self::MemberReadFailed,
            "open_failed" => Self::MemberOpenFailed,
            "metadata_failed" => Self::MemberMetadataFailed,
            "too_large" => Self::MemberTooLarge,
            "binary" => Self::MemberBinary,
            "empty" => Self::MemberEmpty,
            "symlink" => Self::MemberSymlink,
            "non_regular" => Self::MemberNonRegular,
            "archive_unreadable" => Self::ArchiveUnreadable,
            "nested_archive_staging_failed" => Self::NestedArchiveStagingFailed,
            "archive_depth_exceeded" => Self::ArchiveDepthExceeded,
            "archive_member_unstable" => Self::ArchiveMemberUnstable,
            "malformed_structured_record" => Self::MalformedStructuredRecord,
            "directory" | "hidden" | "not_selected" => return None,
            _ => Self::Unclassified,
        })
    }
}

/// The exact source or archive member a defect belongs to.
///
/// Structural only. Every component is secret-scrubbed; nothing here can hold
/// a log record.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocator {
    /// Redacted portable identity, `outer.zip!/inner.zip!/app.log`.
    ///
    /// This is the string an operator matches against the import preview.
    pub identity: String,
    /// Redacted archive containers, outermost first. Empty for a source read
    /// directly from the filesystem.
    pub archive_chain: Vec<String>,
    /// Redacted leaf name of the failing member.
    pub member: String,
    /// Number of archive containers named in `identity`.
    ///
    /// The selected import root is **not** counted, because the engine's
    /// portable identities do not name it — the operator chose it, so it is
    /// context rather than content. A member of a directly selected archive is
    /// therefore depth `0`, exactly as a member of a selected directory is;
    /// a member of an archive *inside* that archive is depth `1`.
    pub archive_depth: u32,
}

impl SourceLocator {
    /// Build a locator from an ingest source identity.
    ///
    /// The identity arrives in the engine's own form — either a filesystem path
    /// or an `archive!/member` chain built by the archive walk. Each level is
    /// scrubbed independently so the chain's *shape* survives while its
    /// *content* is sanitized.
    ///
    /// In-archive levels keep their relative directory path, because that is
    /// exactly the portable identity the import preview shows and the reviewed
    /// selection matches on — an operator must be able to match this string
    /// against what they selected, and two members can share a basename.
    /// Absolute filesystem paths are reduced to their leaf instead: their
    /// ancestry is the user's home directory, which is not the operator's
    /// question and not ours to publish.
    pub fn from_identity(identity: &str) -> Self {
        let mut chain: Vec<String> = identity
            .split(ARCHIVE_MEMBER_SEPARATOR)
            .map(redact_portable_path)
            .collect();
        // `split` on a non-empty separator always yields at least one element.
        let leaf_path = chain.pop().unwrap_or_else(|| "[unknown]".to_string());
        // `member` is the bare name; `identity` keeps the relative path so the
        // two questions "which file" and "where does it live" both have an
        // answer without re-parsing.
        let member = leaf_path
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .unwrap_or(leaf_path.as_str())
            .to_string();
        let archive_depth = chain.len() as u32;
        if chain.len() > MAX_LOCATOR_ARCHIVE_CHAIN {
            // Keep the outermost container (the thing the operator selected)
            // and the innermost ones (where the defect is). Depth stays exact.
            let keep_inner = MAX_LOCATOR_ARCHIVE_CHAIN - 1;
            let mut trimmed = vec![chain[0].clone()];
            trimmed.extend_from_slice(&chain[chain.len() - keep_inner..]);
            chain = trimmed;
        }
        let identity = chain
            .iter()
            .cloned()
            .chain(std::iter::once(leaf_path))
            .collect::<Vec<_>>()
            .join(ARCHIVE_MEMBER_SEPARATOR);
        Self {
            identity,
            archive_chain: chain,
            member,
            archive_depth,
        }
    }

    /// True when this source sits inside a further archive below the import
    /// root — the nested-archive case.
    ///
    /// Not "came from an archive": a member of a directly selected archive
    /// reports `false`, because the selected root is not part of the identity.
    pub fn is_nested(&self) -> bool {
        self.archive_depth > 0
    }
}

/// Maximum path segments kept inside one archive level.
///
/// Deep in-archive trees are bounded so one pathological entry cannot make a
/// report unbounded; the innermost segments are kept because they are the
/// specific ones.
const MAX_LOCATOR_PATH_SEGMENTS: usize = 8;

/// Scrub one level of an identity chain, keeping relative structure.
///
/// Absolute paths collapse to their leaf; relative paths keep their segments,
/// each scrubbed with the same rules the progress channel uses.
fn redact_portable_path(level: &str) -> String {
    if is_absolute_path(level) {
        return forbid_member_marker(&redact_basename(level));
    }
    let mut segments: Vec<String> = level
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(|segment| forbid_member_marker(&redact_basename(segment)))
        .collect();
    if segments.is_empty() {
        return forbid_member_marker(&redact_basename(level));
    }
    if segments.len() > MAX_LOCATOR_PATH_SEGMENTS {
        segments = segments.split_off(segments.len() - MAX_LOCATOR_PATH_SEGMENTS);
        segments.insert(0, "…".to_string());
    }
    segments.join("/")
}

/// A locator component must never carry the transport marker. An attacker-
/// controlled ZIP name can legally contain `[member=`; publishing that
/// substring would re-open the leak the operator seal exists to close.
fn forbid_member_marker(component: &str) -> String {
    if component.contains(MEMBER_ANNOTATION_MARKER) {
        "[REDACTED_BASENAME]".to_string()
    } else {
        component.to_string()
    }
}

fn is_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with('\\')
        // Windows drive prefix (`C:\logs\app.log`) or UNC share.
        || value
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':' && value.as_bytes()[0].is_ascii_alphabetic())
}

/// Where inside a member a record-level defect occurred.
///
/// Ordinals and offsets only. There is intentionally no field for the record's
/// text, its parsed fields, or a surrounding excerpt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLocation {
    /// 1-based physical line ordinal within the member.
    pub line: u64,
    /// Byte offset of the record's first byte within the member's decoded
    /// stream, counted before parsing.
    pub byte_offset: u64,
}

impl RecordLocation {
    /// Build a location for a 1-based line and its starting byte offset.
    pub fn new(line: u64, byte_offset: u64) -> Self {
        Self { line, byte_offset }
    }
}

/// One located import defect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDefect {
    /// Stable diagnostic code.
    pub code: ImportDefectCode,
    /// Whether this stopped the run or only reduced coverage.
    pub severity: ImportDefectSeverity,
    /// Exact source or archive member.
    pub source: SourceLocator,
    /// Record position when the engine knows it. `None` for whole-member and
    /// whole-archive defects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<RecordLocation>,
    /// How many times this `(code, source, location)` was observed. Record-level
    /// codes coalesce per member so one badly formed member cannot flood the
    /// ledger; the first occurrence keeps its exact location.
    pub occurrences: u64,
}

impl ImportDefect {
    /// Sort key giving a deterministic ledger order across runs and platforms.
    ///
    /// Fatal defects first (the operator's first question), then code, then
    /// identity, then position.
    fn sort_key(&self) -> (ImportDefectSeverity, ImportDefectCode, &str, u64, u64) {
        let (line, offset) = self
            .location
            .map(|l| (l.line, l.byte_offset))
            .unwrap_or((0, 0));
        (
            self.severity,
            self.code,
            self.source.identity.as_str(),
            line,
            offset,
        )
    }
}

/// Source and record counts for one import run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcomeCounts {
    /// Entries the walk discovered before policy or read decisions.
    pub sources_discovered: u64,
    /// Sources read through EOF and imported.
    pub sources_imported: u64,
    /// Sources that could not be opened or completely read.
    pub sources_failed: u64,
    /// Sources omitted by an explicit policy guard.
    pub sources_excluded: u64,
    /// Entries intentionally filtered (directories, hidden files, unselected).
    /// Never a defect and never makes a corpus partial.
    pub sources_ignored: u64,
    /// Records imported into the corpus.
    pub records_imported: u64,
    /// Records rejected as malformed for their member's declared grammar.
    pub records_malformed: u64,
}

/// Explicit privacy statement carried by every report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcomePrivacy {
    /// Redaction mode id.
    pub redaction_mode: String,
    /// What this report does and does not contain.
    pub policy_summary: String,
    /// True when the located defect list hit [`MAX_IMPORT_DEFECTS`].
    /// `defect_counts` remain complete regardless.
    pub defects_truncated: bool,
}

impl ImportOutcomePrivacy {
    fn new(defects_truncated: bool) -> Self {
        Self {
            redaction_mode: "identity_structural_only".into(),
            policy_summary: "Source and archive member identities are reported after secret \
                             scrubbing. Record positions are ordinals and byte offsets. No log \
                             record, message, parsed field, or operating-system error text is \
                             included."
                .into(),
            defects_truncated,
        }
    }
}

/// Fail-closed result document for one batch corpus import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcomeReport {
    /// Stable schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Terminal class.
    pub class: ImportOutcomeClass,
    /// True only when a corpus was atomically published into the library.
    pub published: bool,
    /// Published corpus id. Always `None` when `class` is `rejected`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_id: Option<String>,
    /// Source and record counts.
    pub counts: ImportOutcomeCounts,
    /// Bounded, deterministically ordered located defects.
    pub defects: Vec<ImportDefect>,
    /// Complete per-code totals, unaffected by the located-list bound.
    pub defect_counts: BTreeMap<String, u64>,
    /// Privacy statement.
    pub privacy: ImportOutcomePrivacy,
    /// Deterministic digest over the classified, ordered content of this
    /// report. Identical inputs produce an identical digest; wall-clock
    /// timings and corpus ids are excluded so the digest is comparable across
    /// runs of the same source.
    pub manifest_digest: String,
}

impl ImportOutcomeReport {
    /// Build a published outcome from a successful ingest.
    ///
    /// Classification is derived here, not supplied: a caller cannot hand in
    /// `Complete` alongside a non-empty defect ledger.
    pub fn published(
        corpus_id: impl Into<String>,
        stats: &IngestStats,
        ledger: &DefectLedger,
    ) -> Self {
        let counts = counts_from(stats, ledger);
        let (defects, defect_counts, truncated) = ledger.finish(ImportDefectSeverity::Degraded);
        let class = if defects.is_empty()
            && defect_counts.is_empty()
            && counts.sources_failed == 0
            && counts.sources_excluded == 0
            && counts.records_malformed == 0
            && !stats.partial
        {
            ImportOutcomeClass::Complete
        } else {
            ImportOutcomeClass::Partial
        };
        Self::assemble(
            class,
            Some(corpus_id.into()),
            counts,
            defects,
            defect_counts,
            truncated,
        )
    }

    /// Build a rejected outcome. Nothing was published.
    ///
    /// `stats` is the best-effort snapshot from the aborted walk; its counts
    /// describe how far the run got, never what was kept, because a rejected
    /// run keeps nothing.
    pub fn rejected(stats: &IngestStats, ledger: &DefectLedger) -> Self {
        let counts = counts_from(stats, ledger);
        let (defects, defect_counts, truncated) = ledger.finish(ImportDefectSeverity::Fatal);
        Self::assemble(
            ImportOutcomeClass::Rejected,
            None,
            ImportOutcomeCounts {
                // A rejected run published nothing, so nothing was imported no
                // matter how far the aborted walk got.
                sources_imported: 0,
                records_imported: 0,
                ..counts
            },
            defects,
            defect_counts,
            truncated,
        )
    }

    /// Build a rejected outcome for a run that failed before any defect was
    /// attributable to a specific source.
    ///
    /// The engine's typed error kind is mapped to a code; the error's message
    /// is deliberately not carried, because it can hold an absolute path.
    pub fn rejected_without_locator(error: &CoreError) -> Self {
        let mut ledger = DefectLedger::new();
        ledger.record_fatal(rejection_code(error), "[import root]", None);
        Self::rejected(&IngestStats::default(), &ledger)
    }

    /// Build a rejected outcome, naming the archive member when the engine
    /// annotated one onto the error.
    ///
    /// The import *preview* walks nested archives before ingest ever starts, so
    /// a corrupt inner container is detected there — with the member's identity
    /// in hand but no ledger to write it to. [`member_annotation`] carries that
    /// identity out on the error; this reads it back so a pre-ingest rejection
    /// names the same member an ingest-time one would. Falls back to the
    /// unlocated form when there is no annotation.
    pub fn rejected_from_error(error: &CoreError) -> Self {
        let message = error.to_string();
        let Some(identity) = member_annotation(&message) else {
            return Self::rejected_without_locator(error);
        };
        // The annotation is only ever applied while walking inside an archive,
        // so its presence is itself the evidence: this is an unreadable
        // container, not the `Unclassified` fallback a bare message would get.
        let mut ledger = DefectLedger::new();
        ledger.record_fatal(ImportDefectCode::ArchiveUnreadable, &identity, None);
        Self::rejected(&IngestStats::default(), &ledger)
    }

    fn assemble(
        class: ImportOutcomeClass,
        corpus_id: Option<String>,
        counts: ImportOutcomeCounts,
        defects: Vec<ImportDefect>,
        defect_counts: BTreeMap<String, u64>,
        truncated: bool,
    ) -> Self {
        let published = class.published();
        let mut report = Self {
            schema_id: IMPORT_OUTCOME_SCHEMA_ID.into(),
            schema_version: IMPORT_OUTCOME_SCHEMA_VERSION,
            class,
            published,
            // A rejected run must never carry a corpus id: the id would invite
            // a caller to go looking for a corpus that was never published.
            corpus_id: published.then_some(corpus_id).flatten(),
            counts,
            defects,
            defect_counts,
            privacy: ImportOutcomePrivacy::new(truncated),
            manifest_digest: String::new(),
        };
        report.manifest_digest = report.compute_manifest_digest();
        debug_assert!(report.invariants_hold(), "outcome invariants: {report:?}");
        report
    }

    /// Check the contract's own invariants.
    ///
    /// Exposed so hosts and tests can assert the guarantee directly rather than
    /// re-deriving it: a complete outcome is published and defect-free, and a
    /// rejected outcome published nothing and names no corpus.
    pub fn invariants_hold(&self) -> bool {
        match self.class {
            ImportOutcomeClass::Complete => {
                self.published
                    && self.corpus_id.is_some()
                    && self.defects.is_empty()
                    && self.defect_counts.is_empty()
                    && self.counts.sources_failed == 0
                    && self.counts.sources_excluded == 0
                    && self.counts.records_malformed == 0
            }
            ImportOutcomeClass::Partial => self.published && self.corpus_id.is_some(),
            ImportOutcomeClass::Rejected => {
                !self.published
                    && self.corpus_id.is_none()
                    && self.counts.sources_imported == 0
                    && self.counts.records_imported == 0
            }
        }
    }

    /// Deterministic digest over classified content.
    ///
    /// Excludes the corpus id (a fresh UUID per run) and every wall-clock
    /// value, so two imports of the same bytes agree.
    fn compute_manifest_digest(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(IMPORT_OUTCOME_SCHEMA_ID.as_bytes());
        hasher.update([0u8]);
        hasher.update(IMPORT_OUTCOME_SCHEMA_VERSION.to_be_bytes());
        hasher.update(self.class.as_str().as_bytes());
        hasher.update([u8::from(self.published)]);
        for value in [
            self.counts.sources_discovered,
            self.counts.sources_imported,
            self.counts.sources_failed,
            self.counts.sources_excluded,
            self.counts.sources_ignored,
            self.counts.records_imported,
            self.counts.records_malformed,
        ] {
            hasher.update(value.to_be_bytes());
        }
        // `defects` is sorted and `defect_counts` is a BTreeMap, so both
        // iterate in one fixed order regardless of discovery order.
        for defect in &self.defects {
            hasher.update(defect.code.as_str().as_bytes());
            hasher.update([0u8]);
            hasher.update(defect.severity.as_str().as_bytes());
            hasher.update([0u8]);
            hasher.update(defect.source.identity.as_bytes());
            hasher.update([0u8]);
            let (line, offset) = defect
                .location
                .map(|l| (l.line, l.byte_offset))
                .unwrap_or((0, 0));
            hasher.update(line.to_be_bytes());
            hasher.update(offset.to_be_bytes());
            hasher.update(defect.occurrences.to_be_bytes());
        }
        for (code, count) in &self.defect_counts {
            hasher.update(code.as_bytes());
            hasher.update([0u8]);
            hasher.update(count.to_be_bytes());
        }
        format!("sha256:{:x}", hasher.finalize())
    }

    /// Machine-readable form.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ImportOutcomeReport is always serializable")
    }

    /// Operator-readable summary.
    ///
    /// Leads with the verdict, because the one thing a reader must not
    /// mis-take away is whether the corpus is the whole source.
    pub fn render_summary(&self) -> String {
        let mut out = String::new();
        let headline = match self.class {
            ImportOutcomeClass::Complete => {
                "COMPLETE — every discovered source was imported".to_string()
            }
            ImportOutcomeClass::Partial => format!(
                "PARTIAL — a corpus was published but {} source(s) and {} record(s) are missing",
                self.counts.sources_failed + self.counts.sources_excluded,
                self.counts.records_malformed
            ),
            ImportOutcomeClass::Rejected => {
                "REJECTED — nothing was published; the library is unchanged".to_string()
            }
        };
        out.push_str(&format!("Import outcome: {headline}\n"));
        if let Some(id) = &self.corpus_id {
            out.push_str(&format!("  Corpus       {id}\n"));
        }
        out.push_str(&format!(
            "  Sources      {} discovered, {} imported, {} failed, {} excluded, {} ignored\n",
            self.counts.sources_discovered,
            self.counts.sources_imported,
            self.counts.sources_failed,
            self.counts.sources_excluded,
            self.counts.sources_ignored,
        ));
        out.push_str(&format!(
            "  Records      {} imported, {} malformed\n",
            self.counts.records_imported, self.counts.records_malformed
        ));
        if self.defects.is_empty() {
            out.push_str(&format!("  Manifest     {}\n", self.manifest_digest));
            return out;
        }
        out.push_str("\nDefects\n\n");
        for defect in &self.defects {
            let position = match defect.location {
                Some(location) => {
                    format!(" at line {} (byte {})", location.line, location.byte_offset)
                }
                None => String::new(),
            };
            let repeat = if defect.occurrences > 1 {
                format!(" ×{}", defect.occurrences)
            } else {
                String::new()
            };
            out.push_str(&format!(
                "  [{}] {}{}{}\n      {} — {}\n",
                defect.severity.as_str(),
                defect.source.identity,
                position,
                repeat,
                defect.code.as_str(),
                defect.code.operator_hint(),
            ));
        }
        if self.privacy.defects_truncated {
            out.push_str(&format!(
                "\n  (located list capped at {MAX_IMPORT_DEFECTS}; per-code totals below are complete)\n"
            ));
        }
        out.push_str("\nTotals by code\n\n");
        for (code, count) in &self.defect_counts {
            out.push_str(&format!("  {code}={count}\n"));
        }
        out.push_str(&format!("\n  Manifest     {}\n", self.manifest_digest));
        out
    }
}

fn counts_from(stats: &IngestStats, ledger: &DefectLedger) -> ImportOutcomeCounts {
    ImportOutcomeCounts {
        sources_discovered: stats.discovered_files,
        sources_imported: stats.files as u64,
        sources_failed: stats.failed_files,
        sources_excluded: stats.excluded_files,
        sources_ignored: stats.ignored_files,
        records_imported: stats.lines,
        records_malformed: ledger.malformed_records,
    }
}

/// Collector the ingest walk writes defects into.
///
/// Lives beside the walk's `IngestStats` and, unlike the report itself, is
/// readable after an aborted run — that is how a rejected outcome can still
/// name the member that stopped it.
#[derive(Debug, Clone, Default)]
pub struct DefectLedger {
    entries: Vec<ImportDefect>,
    counts: BTreeMap<String, u64>,
    truncated: bool,
    /// Records rejected as malformed for their member's declared grammar.
    malformed_records: u64,
}

impl DefectLedger {
    /// Empty ledger.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a coverage-reducing defect for one source identity.
    ///
    /// Reasons that denote intentional filtering are dropped, so the caller can
    /// route every omission here without first classifying it.
    pub fn record_ingest_reason(&mut self, reason: &str, identity: &str) {
        let Some(code) = ImportDefectCode::from_ingest_reason(reason) else {
            return;
        };
        self.push(code, ImportDefectSeverity::Degraded, identity, None);
    }

    /// Record a run-aborting defect against the source that caused it.
    pub fn record_fatal(
        &mut self,
        code: ImportDefectCode,
        identity: &str,
        location: Option<RecordLocation>,
    ) {
        self.push(code, ImportDefectSeverity::Fatal, identity, location);
    }

    /// Record a member that could not be read to the end, with the position
    /// reading stopped at.
    pub fn record_member_read_stop(&mut self, identity: &str, location: RecordLocation) {
        self.push(
            ImportDefectCode::MemberReadFailed,
            ImportDefectSeverity::Degraded,
            identity,
            Some(location),
        );
    }

    /// Record one malformed structured record.
    ///
    /// Occurrences coalesce per member: the first keeps its exact location so
    /// the operator can jump to it, and later ones only increment the count.
    /// A member of a million bad lines therefore costs one ledger entry.
    pub fn record_malformed_structured_record(&mut self, identity: &str, location: RecordLocation) {
        self.malformed_records = self.malformed_records.saturating_add(1);
        self.push_coalescing(
            ImportDefectCode::MalformedStructuredRecord,
            ImportDefectSeverity::Degraded,
            identity,
            Some(location),
        );
    }

    /// Number of malformed structured records seen.
    pub fn malformed_records(&self) -> u64 {
        self.malformed_records
    }

    /// True when nothing has been recorded.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.counts.is_empty()
    }

    fn push(
        &mut self,
        code: ImportDefectCode,
        severity: ImportDefectSeverity,
        identity: &str,
        location: Option<RecordLocation>,
    ) {
        *self.counts.entry(code.as_str().to_string()).or_insert(0) += 1;
        if self.entries.len() >= MAX_IMPORT_DEFECTS {
            self.truncated = true;
            return;
        }
        self.entries.push(ImportDefect {
            code,
            severity,
            source: SourceLocator::from_identity(identity),
            location,
            occurrences: 1,
        });
    }

    fn push_coalescing(
        &mut self,
        code: ImportDefectCode,
        severity: ImportDefectSeverity,
        identity: &str,
        location: Option<RecordLocation>,
    ) {
        *self.counts.entry(code.as_str().to_string()).or_insert(0) += 1;
        let locator = SourceLocator::from_identity(identity);
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|entry| entry.code == code && entry.source == locator)
        {
            existing.occurrences = existing.occurrences.saturating_add(1);
            return;
        }
        if self.entries.len() >= MAX_IMPORT_DEFECTS {
            self.truncated = true;
            return;
        }
        self.entries.push(ImportDefect {
            code,
            severity,
            source: locator,
            location,
            occurrences: 1,
        });
    }

    /// Finish into a deterministically ordered list plus complete per-code
    /// totals.
    ///
    /// `terminal` is the severity the run's own terminal defect carries: on a
    /// rejected run the last recorded defect is what stopped it.
    fn finish(
        &self,
        terminal: ImportDefectSeverity,
    ) -> (Vec<ImportDefect>, BTreeMap<String, u64>, bool) {
        let mut defects = self.entries.clone();
        if terminal == ImportDefectSeverity::Degraded {
            // A published run has no fatal defect by construction; anything
            // recorded as fatal but survived to publication is reported at the
            // severity that actually applies.
            for defect in &mut defects {
                defect.severity = ImportDefectSeverity::Degraded;
            }
        }
        defects.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
        (defects, self.counts.clone(), self.truncated)
    }
}

/// Build a published or rejected outcome from an ingest result.
///
/// The single place the three-way classification is decided, so no host can
/// invent a fourth reading of an ingest result. `aborted_stats` is the walk's
/// own stats value, which outlives a failed run and carries its defect ledger.
pub fn outcome_from_ingest(
    result: Result<&IngestReport, &CoreError>,
    aborted_stats: &IngestStats,
) -> ImportOutcomeReport {
    match result {
        Ok(report) => {
            ImportOutcomeReport::published(&report.corpus_id, &report.stats, &report.stats.defects)
        }
        Err(error) if aborted_stats.defects.is_empty() => {
            ImportOutcomeReport::rejected_without_locator(error)
        }
        Err(_) => ImportOutcomeReport::rejected(aborted_stats, &aborted_stats.defects),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(identity: &str) -> SourceLocator {
        SourceLocator::from_identity(identity)
    }

    #[test]
    fn locator_preserves_nested_archive_chain_shape() {
        let l = locator("bundles/inner.zip!/logs/app.log");
        // Relative in-archive structure survives so the identity still matches
        // what the import preview showed the operator.
        assert_eq!(l.identity, "bundles/inner.zip!/logs/app.log");
        assert_eq!(l.archive_chain, vec!["bundles/inner.zip"]);
        assert_eq!(l.member, "app.log");
        assert_eq!(l.archive_depth, 1);
        assert!(l.is_nested());
    }

    #[test]
    fn locator_distinguishes_same_named_members_in_different_directories() {
        let a = locator("node-a/service.log");
        let b = locator("node-b/service.log");
        assert_ne!(
            a.identity, b.identity,
            "two members sharing a basename must stay distinguishable"
        );
        assert_eq!(a.member, b.member);
    }

    #[test]
    fn locator_for_direct_source_has_no_archive_chain() {
        let l = locator("/home/someone/logs/app.log");
        assert_eq!(l.member, "app.log");
        assert!(l.archive_chain.is_empty());
        assert_eq!(l.archive_depth, 0);
        assert!(!l.is_nested());
        // Absolute filesystem ancestry is the user's home directory and never
        // survives into the report.
        assert_eq!(l.identity, "app.log");
        assert!(!l.identity.contains("someone"));
    }

    #[test]
    fn locator_collapses_windows_absolute_paths_too() {
        let l = locator("C:\\Users\\someone\\logs\\app.log");
        assert!(!l.identity.contains("someone"), "{}", l.identity);
    }

    #[test]
    fn locator_bounds_a_pathological_in_archive_depth() {
        let deep: String = (0..40)
            .map(|i| format!("dir{i}"))
            .collect::<Vec<_>>()
            .join("/");
        let l = locator(&format!("{deep}/app.log"));
        assert_eq!(l.member, "app.log");
        assert!(
            l.identity.split('/').count() <= MAX_LOCATOR_PATH_SEGMENTS + 1,
            "{}",
            l.identity
        );
        assert!(l.identity.ends_with("app.log"), "{}", l.identity);
    }

    #[test]
    fn locator_scrubs_secret_bearing_component_names() {
        let l = locator("bundle.zip!/sk-abcdefghijklmnop.log");
        assert!(!l.identity.contains("abcdefghijklmnop"), "{}", l.identity);
        assert!(!l.member.contains("abcdefghijklmnop"), "{}", l.member);
    }

    #[test]
    fn locator_replaces_private_host_shaped_names() {
        let l = locator("host.internal.zip!/app.log");
        assert_eq!(l.archive_chain, vec!["[REDACTED_BASENAME]"]);
    }

    #[test]
    fn locator_components_are_always_separator_free() {
        // The engine hands us an already-flattened string, so a literal `!/`
        // inside a real filename is indistinguishable from a container
        // separator — that ambiguity cannot be resolved here, and this parse
        // reads it as a level. What must hold regardless is that no *component*
        // carries the separator, so no single level can ever be re-split into
        // extra ones downstream.
        for identity in [
            "bundle.zip!/we!/ird.log",
            "bundle.zip!/inner.zip!/app.log",
            "plain.log",
        ] {
            let l = locator(identity);
            for component in l.archive_chain.iter().chain(std::iter::once(&l.member)) {
                assert!(
                    !component.contains(ARCHIVE_MEMBER_SEPARATOR),
                    "component {component:?} carries the separator: {identity}"
                );
            }
        }
    }

    #[test]
    fn reparsing_a_rendered_identity_never_inflates_depth() {
        // The property that actually guards the chain: feeding a rendered
        // identity back through the parser can never *gain* levels. Within the
        // cap the round trip is exact; past it the chain is abbreviated by
        // design (depth stays exact while the middle is dropped), so re-parsing
        // may report fewer levels — never more.
        for identity in [
            "bundle.zip!/we!/ird.log",
            "a.zip!/b.zip!/c.zip!/d.zip!/e.zip!/app.log",
            "logs/nested/app.log",
        ] {
            let first = locator(identity);
            let second = locator(&first.identity);
            assert!(
                second.archive_depth <= first.archive_depth,
                "re-parsing inflated depth {} -> {} for {identity}",
                first.archive_depth,
                second.archive_depth
            );
            assert_eq!(
                second.member, first.member,
                "member drifted on re-parse: {identity}"
            );
            if first.archive_depth as usize <= MAX_LOCATOR_ARCHIVE_CHAIN {
                assert_eq!(
                    second, first,
                    "within-cap identities must round-trip exactly: {identity}"
                );
            }
        }
    }

    #[test]
    fn complete_requires_an_empty_ledger() {
        let stats = IngestStats {
            discovered_files: 2,
            files: 2,
            lines: 10,
            ..IngestStats::default()
        };
        let report = ImportOutcomeReport::published("corpus-1", &stats, &DefectLedger::new());
        assert_eq!(report.class, ImportOutcomeClass::Complete);
        assert!(report.published);
        assert!(report.invariants_hold());
    }

    #[test]
    fn any_defect_downgrades_complete_to_partial() {
        let stats = IngestStats {
            discovered_files: 2,
            files: 1,
            failed_files: 1,
            partial: true,
            lines: 10,
            ..IngestStats::default()
        };
        let mut ledger = DefectLedger::new();
        ledger.record_ingest_reason("read_failed", "outer.zip!/broken.log");
        let report = ImportOutcomeReport::published("corpus-1", &stats, &ledger);
        assert_eq!(report.class, ImportOutcomeClass::Partial);
        assert!(report.published);
        assert!(report.invariants_hold());
        assert_eq!(report.defects.len(), 1);
        assert_eq!(report.defects[0].code, ImportDefectCode::MemberReadFailed);
    }

    #[test]
    fn rejected_never_carries_a_corpus_or_import_counts() {
        let stats = IngestStats {
            discovered_files: 3,
            files: 2,
            lines: 40,
            ..IngestStats::default()
        };
        let mut ledger = DefectLedger::new();
        ledger.record_fatal(
            ImportDefectCode::ArchiveUnreadable,
            "outer.zip!/inner.zip",
            None,
        );
        let report = ImportOutcomeReport::rejected(&stats, &ledger);
        assert_eq!(report.class, ImportOutcomeClass::Rejected);
        assert!(!report.published);
        assert!(report.corpus_id.is_none());
        assert_eq!(report.counts.sources_imported, 0);
        assert_eq!(report.counts.records_imported, 0);
        // The walk still reports how far it got.
        assert_eq!(report.counts.sources_discovered, 3);
        assert!(report.invariants_hold());
    }

    #[test]
    fn intentional_filtering_is_not_a_defect() {
        let mut ledger = DefectLedger::new();
        ledger.record_ingest_reason("hidden", "bundle.zip!/.DS_Store");
        ledger.record_ingest_reason("directory", "bundle.zip!/logs");
        ledger.record_ingest_reason("not_selected", "bundle.zip!/other.log");
        assert!(ledger.is_empty());
        let stats = IngestStats {
            discovered_files: 4,
            files: 1,
            ignored_files: 3,
            lines: 5,
            ..IngestStats::default()
        };
        let report = ImportOutcomeReport::published("corpus-1", &stats, &ledger);
        assert_eq!(report.class, ImportOutcomeClass::Complete);
    }

    #[test]
    fn malformed_records_coalesce_per_member_and_keep_first_location() {
        let mut ledger = DefectLedger::new();
        for line in 1..=5 {
            ledger.record_malformed_structured_record(
                "bundle.zip!/app.jsonl",
                RecordLocation::new(line, line * 40),
            );
        }
        assert_eq!(ledger.malformed_records(), 5);
        let (defects, counts, _) = ledger.finish(ImportDefectSeverity::Degraded);
        assert_eq!(defects.len(), 1);
        assert_eq!(defects[0].occurrences, 5);
        assert_eq!(defects[0].location, Some(RecordLocation::new(1, 40)));
        assert_eq!(counts["malformed_structured_record"], 5);
    }

    #[test]
    fn located_list_is_bounded_but_totals_stay_complete() {
        let mut ledger = DefectLedger::new();
        for i in 0..(MAX_IMPORT_DEFECTS + 25) {
            ledger.record_ingest_reason("read_failed", &format!("bundle.zip!/member-{i}.log"));
        }
        let stats = IngestStats {
            discovered_files: (MAX_IMPORT_DEFECTS + 25) as u64,
            failed_files: (MAX_IMPORT_DEFECTS + 25) as u64,
            partial: true,
            ..IngestStats::default()
        };
        let report = ImportOutcomeReport::published("corpus-1", &stats, &ledger);
        assert_eq!(report.defects.len(), MAX_IMPORT_DEFECTS);
        assert!(report.privacy.defects_truncated);
        assert_eq!(
            report.defect_counts["member_read_failed"],
            (MAX_IMPORT_DEFECTS + 25) as u64
        );
    }

    #[test]
    fn manifest_digest_is_order_independent_and_content_sensitive() {
        let stats = IngestStats {
            discovered_files: 3,
            files: 1,
            failed_files: 2,
            partial: true,
            lines: 7,
            ..IngestStats::default()
        };
        let mut forward = DefectLedger::new();
        forward.record_ingest_reason("read_failed", "b.zip!/two.log");
        forward.record_ingest_reason("binary", "a.zip!/one.log");
        let mut reverse = DefectLedger::new();
        reverse.record_ingest_reason("binary", "a.zip!/one.log");
        reverse.record_ingest_reason("read_failed", "b.zip!/two.log");

        let a = ImportOutcomeReport::published("corpus-a", &stats, &forward);
        let b = ImportOutcomeReport::published("corpus-b", &stats, &reverse);
        // Different corpus ids, different discovery order, same content.
        assert_eq!(a.manifest_digest, b.manifest_digest);

        let mut different = DefectLedger::new();
        different.record_ingest_reason("read_failed", "b.zip!/two.log");
        different.record_ingest_reason("binary", "a.zip!/other.log");
        let c = ImportOutcomeReport::published("corpus-c", &stats, &different);
        assert_ne!(a.manifest_digest, c.manifest_digest);
    }

    #[test]
    fn summary_names_the_member_and_never_prints_payload() {
        let stats = IngestStats {
            discovered_files: 2,
            files: 1,
            failed_files: 1,
            partial: true,
            lines: 3,
            ..IngestStats::default()
        };
        let mut ledger = DefectLedger::new();
        ledger.record_member_read_stop(
            "outer.zip!/inner.zip!/app.log",
            RecordLocation::new(41, 2048),
        );
        let report = ImportOutcomeReport::published("corpus-1", &stats, &ledger);
        let summary = report.render_summary();
        assert!(summary.contains("PARTIAL"), "{summary}");
        assert!(
            summary.contains("outer.zip!/inner.zip!/app.log"),
            "{summary}"
        );
        assert!(summary.contains("line 41"), "{summary}");
        assert!(summary.contains("member_read_failed"), "{summary}");
    }

    #[test]
    fn seal_is_fail_closed_for_malformed_and_nested_markers() {
        for raw in [
            "zip open: missing end record [member=]",
            "zip open: missing end record [member=foo [member=sk-abcdefghijklmnopqrst]]",
            "zip open: missing end record [member=x] [member=secret]",
            "zip open: missing end record[member=no-space]",
        ] {
            let sealed = strip_member_annotation(raw);
            assert!(
                !sealed.contains("[member="),
                "seal left a transport marker in {raw:?} → {sealed:?}"
            );
            assert!(
                sealed.starts_with("zip open: missing end record"),
                "engine wording must survive: {sealed}"
            );
            assert_eq!(
                member_annotation(raw),
                None,
                "malformed frame must not parse: {raw}"
            );
        }
    }

    #[test]
    fn encoded_identity_round_trips_even_when_the_name_contains_the_marker() {
        let identity = "foo [member=sk-abcdefghijklmnopqrst]";
        let annotated = annotate_member("zip open: missing end record", identity);
        assert!(
            annotated.contains("[member="),
            "the transport frame is still how identity rides on CoreError"
        );
        assert_eq!(member_annotation(&annotated).as_deref(), Some(identity));
        let sealed = strip_member_annotation(&annotated);
        assert_eq!(sealed, "zip open: missing end record");
        assert!(!sealed.contains("[member="), "{sealed}");

        let error = CoreError::Message(annotated);
        let shown = operator_import_error(&error);
        assert!(
            !shown.contains("[member="),
            "operator string leaked marker: {shown}"
        );
        assert!(
            !shown.contains("abcdefghijklmnopqrst"),
            "credential-shaped member name reached the operator string: {shown}"
        );
        assert!(
            shown.contains("zip open: missing end record"),
            "engine wording must stay at the front: {shown}"
        );
    }

    #[test]
    fn locator_refuses_to_publish_the_transport_marker() {
        let locator =
            SourceLocator::from_identity("bundle.zip!/foo [member=sk-abcdefghijklmnopqrst].log");
        assert!(
            !locator.identity.contains("[member="),
            "locator leaked the transport marker: {}",
            locator.identity
        );
        assert!(
            !locator.member.contains("[member="),
            "member leaked the transport marker: {}",
            locator.member
        );
    }

    #[test]
    fn json_round_trips_and_declares_its_schema() {
        let stats = IngestStats {
            discovered_files: 1,
            files: 1,
            lines: 2,
            ..IngestStats::default()
        };
        let report = ImportOutcomeReport::published("corpus-1", &stats, &DefectLedger::new());
        let json = report.to_json();
        assert_eq!(json["schemaId"], IMPORT_OUTCOME_SCHEMA_ID);
        assert_eq!(json["class"], "complete");
        assert_eq!(json["published"], true);
        let back: ImportOutcomeReport = serde_json::from_value(json).expect("round trip");
        assert_eq!(back, report);
    }
}
