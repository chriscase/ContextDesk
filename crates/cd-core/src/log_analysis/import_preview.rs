//! Bounded, read-only inventory of an import source before publication.
//!
//! This module answers one question: *if the user imported this path right
//! now, what exactly would happen to every file and archive member in it?* It
//! never writes a corpus, never stages anything, and never mutates the source.
//!
//! # Why this exists separately from [`super::ingest`]
//!
//! `ingest` is a publish path: it walks, parses, and commits in one pass.
//! Issue #751 asks for a *preview before publication*, and #763 asks the same
//! import action to accept raw files, raw folders, raw ZIPs, and evidence
//! bundles. Preview therefore reuses `ingest`'s traversal, safety limits, and
//! identity rules verbatim (`collect_log_files`, `preflight_raw_log_zip`,
//! [`super::ingest::portable_source_identity`]) rather than re-deriving them —
//! a second, subtly different walker would be a security bug waiting to
//! happen.
//!
//! # Evidence rules
//!
//! * Path, name, and extension are **weak hints only**. Status is decided from
//!   bounded content samples through [`super::format_profile::fingerprint_format`],
//!   which itself ignores the path. A file called `app.log` holding a PNG is
//!   `Unsupported`, and a file called `notes.txt` holding JSON records is a
//!   strong match.
//! * Samples are taken from **head, interior, and tail** windows. First-window
//!   lock-in is explicitly rejected by #751, because a mixed-format file whose
//!   first lines happen to be JSON is not a JSON corpus.
//! * Every representative record leaves this module **bounded and redacted**
//!   (see [`representative_excerpt`]). Nothing in [`ImportPreviewReport`]
//!   carries raw sample bytes, absolute paths, or archive ancestry, so the
//!   report is safe to hand to a provider as context. That is asserted by
//!   tests, not merely intended.
//!
//! # What "nothing disappears silently" means here
//!
//! Every entry the walk observes becomes exactly one [`ImportPreviewItem`],
//! including ones that will never import. A blocked symlink, a binary blob,
//! and an over-ratio archive member each appear with a status and a reason
//! code. The only bound is [`MAX_IMPORT_PREVIEW_ITEMS`], and reaching it sets
//! [`ImportPreviewReport::truncated`] rather than quietly dropping the tail.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CoreResult;
use crate::process_progress::CancelFlag;

use super::format_profile::{
    fingerprint_format, FormatFingerprint, FormatFingerprintOutcome, MIN_STRUCTURED_FORMAT_SCORE,
};
use super::ingest_confidence::IngestFormatOutcome;

/// Schema version of [`ImportPreviewReport`].
///
/// Bumped only for breaking wire changes, matching the `READER_VERSION`
/// convention in [`crate::incident_evidence`].
pub const IMPORT_PREVIEW_SCHEMA_VERSION: u32 = 1;

/// Maximum number of items a single preview report may contain.
///
/// Well below [`super::ingest::MAX_RAW_LOG_ENTRIES`] because a preview is
/// rendered in a UI and handed to models, not streamed to disk.
pub const MAX_IMPORT_PREVIEW_ITEMS: usize = 5_000;

/// Maximum bytes of a bounded redacted representative record.
///
/// Matches `MAX_NOISE_REPRESENTATIVE_EXCERPT_BYTES` so every representative
/// surface in the product shares one budget.
pub const MAX_IMPORT_PREVIEW_REPRESENTATIVE_BYTES: usize = 512;

/// Bytes read per sampling window (head, interior, tail).
pub const IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES: usize = 16 * 1024;

/// Number of bounded sampling windows taken per source.
pub const IMPORT_PREVIEW_SAMPLE_WINDOWS: usize = 3;

/// Bytes sniffed to decide whether content is binary.
pub const IMPORT_PREVIEW_BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// What kind of thing the user selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportSourceKind {
    /// A single regular file.
    File,
    /// A directory walked with the ingest traversal rules.
    Directory,
    /// A ZIP archive selected directly.
    Archive,
}

/// Disposition of one previewed item.
///
/// Ordering is deliberate: the variants run from "will import" to "cannot
/// import", and [`ImportItemStatus::is_selectable`] draws the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportItemStatus {
    /// Strong deterministic match, or declared by a validated manifest.
    Ready,
    /// Genuinely uncertain — competing formats, or mixed records. Visible and
    /// selectable, but never preselected.
    Review,
    /// Readable text with no structured match. Imports as raw lines if the
    /// user asks; "keep raw" is offered, never assumed.
    RawFallback,
    /// Not a log: metrics documents, attachments, readmes. Routed separately.
    Supporting,
    /// Deliberately skipped noise — hidden entries and directory bookkeeping.
    ///
    /// Distinct from [`ImportItemStatus::Unsupported`]: unsupported means
    /// "tried and cannot", ignored means "not attempted by policy". Kept as
    /// its own ledger state so ignored noise stays countable and inspectable
    /// rather than being folded into supporting documents.
    Ignored,
    /// Readable but not importable as events (binary, empty).
    Unsupported,
    /// Refused by policy. Never selectable at any confidence.
    Blocked,
}

impl ImportItemStatus {
    /// Whether a user may choose to import this item at all.
    ///
    /// [`ImportItemStatus::Blocked`] is the only hard no; everything else is a
    /// question of defaults, which [`preselect`] decides.
    pub fn is_selectable(self) -> bool {
        !matches!(self, ImportItemStatus::Blocked)
    }
}

/// Proposed handling role for an item.
///
/// String values match `role` in the Incident Evidence Bundle manifest
/// (`log`, `operational_metrics`, `attachment`, `readme`) so a bundle's own
/// declaration maps across without translation, plus `unknown` for raw input
/// that declares nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportItemRole {
    /// Event-bearing log source.
    Log,
    /// Operational metrics document, routed to the metrics path.
    OperationalMetrics,
    /// Bounded supporting attachment.
    Attachment,
    /// Human-readable bundle readme.
    Readme,
    /// No role could be established from content or a manifest.
    Unknown,
}

/// Machine-readable explanation for an item's status.
///
/// Every item carries at least one. These are stable identifiers for UI copy
/// and tests — never free-form prose, which would leak content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportPreviewReason {
    /// A validated evidence-bundle manifest declares this component.
    ManifestDeclared,
    /// Deterministic fingerprint matched at or above the structured threshold.
    StrongFormatMatch,
    /// Two or more formats tied, or a source produced conflicting matches.
    AmbiguousFormatMatch,
    /// Different sampling windows matched different formats.
    MixedFormatRecords,
    /// Readable text, but no structured grammar matched.
    NoStructuredMatch,
    /// Content sniffing found NUL bytes or invalid UTF-8 dominance.
    BinaryContent,
    /// Zero bytes, or nothing but whitespace.
    EmptyContent,
    /// Exceeds the per-file byte limit.
    Oversized,
    /// Dot-prefixed file or directory.
    Hidden,
    /// Symlink — refused by ingest policy.
    SymlinkRejected,
    /// Not a regular file (device, socket, fifo).
    NonRegularRejected,
    /// Archive nesting deeper than the allowed depth.
    ArchiveDepthExceeded,
    /// Expanded/compressed ratio beyond the decompression-bomb limit.
    CompressionRatioExceeded,
    /// Member path escapes its root or forges the archive-boundary syntax.
    TraversalRejected,
    /// Two members normalize to the same identity.
    DuplicateIdentity,
    /// Encrypted archive entry.
    EncryptedEntry,
    /// Could not be opened or read.
    ReadFailed,
    /// Parsed as an operational-metrics document.
    MetricsDocument,
    /// Recognized as bundle documentation.
    ReadmeDocument,
    /// Only the name/extension suggested a format; content did not agree.
    /// Recorded so a misleading name is visible rather than silently trusted.
    WeakNameHintOnly,
    /// A nested archive the real import would descend into was too large to
    /// inventory within the preview's memory bound. Disclosed rather than
    /// skipped, and sets [`ImportPreviewReport::truncated`].
    NestedArchiveNotInventoried,
}

/// One previewed file or archive member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewItem {
    /// Portable identity relative to the selected root, using `archive!/member`
    /// for archive members. Stable across directory and archive transports and
    /// unique within a report, so duplicate basenames stay distinct.
    pub identity: String,
    /// Redacted leaf name, safe for display without revealing ancestry.
    pub basename: String,
    /// Expanded size in bytes as declared by the filesystem or ZIP central
    /// directory. For archive members this is the *declared* size, validated
    /// against the plan before any payload read.
    pub bytes: u64,
    /// Disposition.
    pub status: ImportItemStatus,
    /// Proposed role.
    pub role: ImportItemRole,
    /// Whether deterministic preselection chose this item.
    pub selected: bool,
    /// Winning format identity, when one won outright.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_id: Option<String>,
    /// Winning format version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_version: Option<u16>,
    /// Three-valued fingerprint outcome, absent when no content was sampled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<IngestFormatOutcome>,
    /// Deterministic ranking score. Never a probability, never rendered as a
    /// percentage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<u16>,
    /// Margin over the runner-up, when more than one format matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_up_margin: Option<u16>,
    /// Non-authoritative producer family hint. Format identity is not producer
    /// identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer_hint: Option<String>,
    /// Stable clue codes explaining the decision in plain language.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisive_clue_codes: Vec<String>,
    /// Why this item has this status. Sorted and deduplicated.
    pub reasons: Vec<ImportPreviewReason>,
    /// Bounded, redacted representative record. Absent when nothing safe could
    /// be shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub representative: Option<String>,
    /// Group this item was folded into, when its fingerprint agreed with peers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

/// A set of rolled/date-suffixed sources whose content fingerprints agree.
///
/// Grouping is a *display* convenience. Every member keeps its own identity in
/// [`ImportPreviewReport::items`]; a group never replaces or hides members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewGroup {
    /// Stable group identifier, derived from the shared stem and format.
    pub group_id: String,
    /// Shared stem the members rolled from, e.g. `app.log`.
    pub stem: String,
    /// Format the members agree on.
    pub format_id: String,
    /// Version of that format.
    pub format_version: u16,
    /// Member identities, sorted.
    pub member_identities: Vec<String>,
    /// True when members may contain overlapping time ranges — rotation can
    /// duplicate records, and the preview discloses that rather than assuming
    /// a clean split.
    pub possible_overlap: bool,
}

/// Counts by status, for a summary that never requires re-walking items.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewCounts {
    /// Total items observed.
    pub total: u64,
    /// Items preselected for import.
    pub selected: u64,
    /// [`ImportItemStatus::Ready`] items.
    pub ready: u64,
    /// [`ImportItemStatus::Review`] items.
    pub review: u64,
    /// [`ImportItemStatus::RawFallback`] items.
    pub raw_fallback: u64,
    /// [`ImportItemStatus::Supporting`] items.
    pub supporting: u64,
    /// [`ImportItemStatus::Ignored`] items.
    pub ignored: u64,
    /// [`ImportItemStatus::Unsupported`] items.
    pub unsupported: u64,
    /// [`ImportItemStatus::Blocked`] items.
    pub blocked: u64,
}

/// Bounded summary of an evidence-bundle manifest found at the import root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportManifestSummary {
    /// Schema id the manifest declared.
    pub schema_id: String,
    /// Whether the manifest validated cleanly. Only a valid manifest is
    /// authoritative; an invalid one is reported and then ignored, never
    /// half-trusted.
    pub valid: bool,
    /// Number of components the manifest declared.
    pub declared_components: u64,
    /// Stable diagnostic codes from validation, bounded and payload-free.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostic_codes: Vec<String>,
}

/// Complete, bounded preview of one import source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewReport {
    /// Schema version of this document.
    pub schema_version: u32,
    /// What the user selected.
    pub source_kind: ImportSourceKind,
    /// Every observed entry, sorted by identity for determinism.
    pub items: Vec<ImportPreviewItem>,
    /// Fingerprint-agreeing rolled-file groups, sorted by group id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ImportPreviewGroup>,
    /// Status counts.
    pub counts: ImportPreviewCounts,
    /// True when [`MAX_IMPORT_PREVIEW_ITEMS`] was reached and later entries
    /// were not itemized. Disclosed, never silent.
    pub truncated: bool,
    /// Manifest summary when the root declared one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<ImportManifestSummary>,
}

/// Why a proposed import plan cannot proceed.
///
/// Returned by [`ImportPreviewReport::plan_block`]. Blocking lives in the
/// trusted core rather than the UI so every host — desktop, server, or a
/// third-party SDK consumer — gets the same refusal; a host that forgets to
/// check simply cannot construct a publishable plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportPlanBlock {
    /// The source contained no entries at all.
    SourceEmpty,
    /// Entries exist, but none of them can produce events. Publishing would
    /// create an empty corpus, which is a failure dressed as success.
    NoImportableSources,
    /// Every candidate was refused by policy.
    AllSourcesBlocked,
}

impl ImportPreviewReport {
    /// Whether any item could produce events if the user selected it.
    ///
    /// Counts the three statuses a user may actually import from. Supporting,
    /// ignored, unsupported, and blocked items can never yield events.
    pub fn importable_count(&self) -> u64 {
        self.counts.ready + self.counts.review + self.counts.raw_fallback
    }

    /// Why this preview cannot become an import plan, if it cannot.
    ///
    /// `None` means at least one source could produce events. A caller must
    /// treat `Some(_)` as fatal for publication: #751's ledger requires that
    /// unusable content be visible, and an import that publishes an empty
    /// corpus reports success while delivering nothing.
    pub fn plan_block(&self) -> Option<ImportPlanBlock> {
        if self.counts.total == 0 {
            return Some(ImportPlanBlock::SourceEmpty);
        }
        if self.importable_count() > 0 {
            return None;
        }
        if self.counts.blocked == self.counts.total {
            return Some(ImportPlanBlock::AllSourcesBlocked);
        }
        Some(ImportPlanBlock::NoImportableSources)
    }

    /// Identities that deterministic preselection chose, sorted.
    pub fn selected_identities(&self) -> Vec<&str> {
        self.items
            .iter()
            .filter(|item| item.selected)
            .map(|item| item.identity.as_str())
            .collect()
    }
}

/// Bounded content sample taken from up to three windows of one source.
#[derive(Debug, Clone, Default)]
pub(super) struct BoundedSample {
    /// Decoded text per window, in head/interior/tail order.
    windows: Vec<String>,
    /// True when a NUL byte or dominant invalid UTF-8 was seen.
    binary: bool,
    /// True when the source held no non-whitespace bytes.
    empty: bool,
}

impl BoundedSample {
    /// First non-blank line across all windows, for a representative record.
    fn first_record(&self) -> Option<&str> {
        self.windows
            .iter()
            .flat_map(|window| window.lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
    }
}

/// Read up to three bounded windows (head, interior, tail) from a reader.
///
/// Deliberately does not read the whole source: a preview must stay bounded
/// on a 512 MiB file. Interior and tail windows exist because #751 rejects
/// first-window lock-in — a file whose first lines are a JSON banner and whose
/// body is plain text must not be reported as JSON.
/// Trim a raw byte window to **whole physical records**.
///
/// A window that starts at an arbitrary byte offset almost always begins in
/// the middle of a record. Fingerprinting that fragment reports `Unknown`,
/// which made a *uniform* structured file look mixed and demoted it from
/// `Ready` to `Review` — the sampler manufacturing the very uncertainty it
/// exists to detect.
///
/// * Unless the window starts at byte 0, everything up to and including the
///   first `\n` is discarded as an incomplete prefix.
/// * Unless the window ends at EOF, everything after the last `\n` is
///   discarded as an incomplete suffix. (At EOF a final record legitimately
///   has no trailing newline.)
/// * A window containing no usable record boundary yields an empty slice.
///   Callers must drop such a window rather than fingerprint it, so a single
///   record larger than the window degrades to "no evidence" instead of
///   "disagreeing evidence".
///
/// This also resolves UTF-8 split boundaries honestly: `\n` is ASCII and can
/// never occur inside a multi-byte sequence, so a newline-aligned slice always
/// starts and ends on a character boundary. Lossy decoding of an aligned slice
/// therefore cannot emit replacement characters that the raw window did not
/// genuinely contain.
pub(super) fn align_to_records(bytes: &[u8], at_source_start: bool, at_source_end: bool) -> &[u8] {
    let mut start = 0usize;
    if !at_source_start {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(index) => start = index + 1,
            None => return &[],
        }
    }
    let mut end = bytes.len();
    if !at_source_end {
        match bytes[start..].iter().rposition(|byte| *byte == b'\n') {
            Some(index) => end = start + index + 1,
            None => return &[],
        }
    }
    &bytes[start..end]
}

pub(super) fn sample_bounded<R: Read + Seek>(reader: &mut R, total_bytes: u64) -> BoundedSample {
    let window = IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES as u64;
    let mut offsets = vec![0u64];
    if total_bytes > window.saturating_mul(2) {
        offsets.push(total_bytes / 2);
    }
    if total_bytes > window.saturating_mul(3) {
        offsets.push(total_bytes.saturating_sub(window));
    }

    let mut sample = BoundedSample {
        empty: true,
        ..BoundedSample::default()
    };
    for offset in offsets.into_iter().take(IMPORT_PREVIEW_SAMPLE_WINDOWS) {
        if reader.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = vec![0u8; IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES];
        let read = match read_bounded(reader, &mut buf) {
            Ok(read) => read,
            Err(_) => continue,
        };
        if read == 0 {
            continue;
        }
        let bytes = &buf[..read];
        // Binary detection runs on the RAW window: a binary blob has no
        // newlines to align to, and alignment would otherwise turn it into an
        // empty (and therefore "empty file") sample.
        if is_binary(bytes) {
            sample.binary = true;
            sample.empty = false;
            return sample;
        }
        let at_source_start = offset == 0;
        let at_source_end = offset.saturating_add(read as u64) >= total_bytes;
        let aligned = align_to_records(bytes, at_source_start, at_source_end);
        if aligned.is_empty() {
            // No whole record in this window — no evidence, not contrary
            // evidence.
            continue;
        }
        let text = String::from_utf8_lossy(aligned).into_owned();
        if !text.trim().is_empty() {
            sample.empty = false;
        }
        sample.windows.push(text);
    }
    sample
}

/// Outcome of streaming a member for classification.
///
/// A read or decompression failure is **not** a content classification. An
/// earlier version swallowed both into whatever bytes had arrived so far,
/// which let a truncated or corrupt member be reported as a confident format
/// match — partial content presented as trustworthy. Callers must map
/// [`SampleOutcome::ReadFailed`] to an explicit ledger failure, the same way
/// `ingest` records `stats.failed` for a member it could not read.
#[derive(Debug)]
pub(super) enum SampleOutcome {
    /// The member was read to completion and classified.
    Sampled(BoundedSample),
    /// The member could not be fully read. Never classified.
    ReadFailed,
}

/// Head/interior/tail sampling for a **non-seekable** reader.
///
/// ZIP entries decompress as a stream, so the seeking [`sample_bounded`] uses
/// is unavailable. Reading only the first window instead would re-introduce
/// first-window lock-in inside archives.
///
/// Streams the member once at bounded memory: the first window, one window
/// captured as the midpoint is crossed, and a rolling last window. Peak memory
/// is three windows regardless of member size.
///
/// Every window is trimmed to whole records by [`align_to_records`] before
/// decoding — the interior and tail windows begin mid-record by construction,
/// and fingerprinting those fragments reported a uniform file as mixed.
///
/// Cancellation is polled on every chunk, so a cancelled preview stops
/// promptly on a large member instead of decompressing it to the end first.
pub(super) fn sample_streaming<R: Read>(
    reader: &mut R,
    total_bytes: u64,
    cancel: Option<&CancelFlag>,
) -> CoreResult<SampleOutcome> {
    let window = IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES;
    let mut head: Vec<u8> = Vec::new();
    let mut middle: Vec<u8> = Vec::new();
    let mut tail: Vec<u8> = Vec::new();
    let mut consumed: u64 = 0;
    let midpoint = total_bytes / 2;
    let mut middle_taken = false;
    let mut binary = false;
    let mut chunk = vec![0u8; 8 * 1024];

    loop {
        if cancel.is_some_and(CancelFlag::is_cancelled) {
            return Err(crate::error::CoreError::Cancelled);
        }
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            // A mid-stream read or decompression error means the member was
            // never fully seen. Report the failure; do not classify a prefix.
            Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(crate::error::CoreError::Cancelled);
            }
            Err(_) => return Ok(SampleOutcome::ReadFailed),
        };
        let bytes = &chunk[..read];
        if !binary && is_binary(bytes) {
            binary = true;
        }
        if head.len() < window {
            let take = read.min(window - head.len());
            head.extend_from_slice(&bytes[..take]);
        }
        if !middle_taken
            && total_bytes > (window as u64) * 2
            && consumed + (read as u64) >= midpoint
        {
            middle.extend_from_slice(&bytes[..read.min(window)]);
            middle_taken = true;
        }
        tail.extend_from_slice(bytes);
        if tail.len() > window {
            let drop_to = tail.len() - window;
            tail.drain(..drop_to);
        }
        consumed = consumed.saturating_add(read as u64);
    }

    if binary {
        return Ok(SampleOutcome::Sampled(BoundedSample {
            windows: Vec::new(),
            binary: true,
            empty: false,
        }));
    }

    // `head` starts at byte 0; `tail` ends at EOF. `middle` is interior on both
    // sides, and `tail` starts mid-record whenever the member exceeded one
    // window.
    let tail_starts_at_source_start = consumed <= window as u64;
    let mut windows = Vec::new();
    let mut empty = true;
    for (raw, at_start, at_end) in [
        (head, true, consumed <= window as u64),
        (middle, false, false),
        (tail, tail_starts_at_source_start, true),
    ] {
        if raw.is_empty() {
            continue;
        }
        let aligned = align_to_records(&raw, at_start, at_end);
        if aligned.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(aligned).into_owned();
        if !text.trim().is_empty() {
            empty = false;
        }
        windows.push(text);
    }
    Ok(SampleOutcome::Sampled(BoundedSample {
        windows,
        binary: false,
        empty,
    }))
}

/// Fill `buf` as far as the reader allows without treating a short read as EOF.
fn read_bounded<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0usize;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {
                // `BoundedSourceReader` signals cancellation this way.
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "cancelled",
                ));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Whether a byte window looks binary.
///
/// A NUL byte is decisive. Otherwise a window is binary when more than one
/// byte in eight fails UTF-8 decoding, which catches images and compiled
/// objects while tolerating a stray invalid byte in an otherwise-text log.
pub(super) fn is_binary(bytes: &[u8]) -> bool {
    let sniff = &bytes[..bytes.len().min(IMPORT_PREVIEW_BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return true;
    }
    match std::str::from_utf8(sniff) {
        Ok(_) => false,
        Err(err) => {
            // Trailing bytes may simply be a split multi-byte char.
            let valid = err.valid_up_to();
            if err.error_len().is_none() && valid + 4 >= sniff.len() {
                return false;
            }
            let invalid = sniff.len().saturating_sub(valid);
            invalid.saturating_mul(8) > sniff.len()
        }
    }
}

/// Bounded, redacted, single-line excerpt of one representative record.
///
/// Two redaction passes plus a forbidden-sentinel check, matching
/// `noise_candidates::safe_excerpt`. The result is safe to place in model
/// context: it carries no credentials, no evaluator markers, and no path
/// ancestry.
pub(super) fn representative_excerpt(record: &str) -> Option<String> {
    let scrubbed = super::redact_log::redact_message(record);
    let candidate = crate::redact::redact_candidate(&scrubbed);
    let text = if candidate.blocked {
        "[credential-dominant record redacted]".to_string()
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
    if trimmed.is_empty() {
        return None;
    }
    Some(bound_text(trimmed, MAX_IMPORT_PREVIEW_REPRESENTATIVE_BYTES))
}

/// Truncate on a char boundary with an explicit ellipsis.
fn bound_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let keep = max_bytes.saturating_sub('…'.len_utf8());
    format!("{}…", crate::text::truncate_bytes(value, keep))
}

/// Redacted leaf name, reusing the ingest evidence redaction rules verbatim.
pub(super) fn redacted_basename(identity: &str) -> String {
    crate::process_progress::redact_basename(identity)
}

/// Fingerprint a bounded sample across all of its windows.
///
/// Returns the agreed fingerprint plus whether windows disagreed. Disagreement
/// is *not* folded into the fingerprint: a mixed-format file is a distinct,
/// reportable condition (`MixedFormatRecords`), not merely an ambiguous one.
pub(super) fn fingerprint_sample(sample: &BoundedSample) -> (Option<FormatFingerprint>, bool) {
    let mut best: Option<FormatFingerprint> = None;
    let mut mixed = false;
    for window in &sample.windows {
        let Some(record) = window.lines().map(str::trim).find(|l| !l.is_empty()) else {
            continue;
        };
        // `None` path: the fingerprinter must not see a name hint here.
        let fp = fingerprint_format(record, None);
        match &best {
            None => best = Some(fp),
            Some(previous) => {
                let previous_id = previous.format_id;
                let next_id = fp.format_id;
                if previous_id != next_id {
                    mixed = true;
                    // Keep the stronger-scoring window as the representative
                    // outcome, but the mixed flag downgrades status later.
                    if fp.score > previous.score {
                        best = Some(fp);
                    }
                }
            }
        }
    }
    (best, mixed)
}

/// Convert a core fingerprint outcome to its serde-facing projection.
fn wire_outcome(outcome: FormatFingerprintOutcome) -> IngestFormatOutcome {
    match outcome {
        FormatFingerprintOutcome::Matched => IngestFormatOutcome::Matched,
        FormatFingerprintOutcome::Ambiguous => IngestFormatOutcome::Ambiguous,
        FormatFingerprintOutcome::Unknown => IngestFormatOutcome::Unknown,
    }
}

/// Deterministic status + role + reasons for one sampled entry.
///
/// This is the single place preselection semantics live, so the rules can be
/// tested directly without a filesystem.
pub(super) fn classify(
    identity: &str,
    sample: &BoundedSample,
    manifest_role: Option<ImportItemRole>,
    manifest_valid: bool,
) -> (
    ImportItemStatus,
    ImportItemRole,
    Vec<ImportPreviewReason>,
    Option<FormatFingerprint>,
) {
    let mut reasons = Vec::new();

    if sample.binary {
        reasons.push(ImportPreviewReason::BinaryContent);
        if name_hints_log(identity) {
            // A `.log` file holding binary content is exactly the misleading
            // name case; record it so the UI can explain the mismatch.
            reasons.push(ImportPreviewReason::WeakNameHintOnly);
        }
        return (
            ImportItemStatus::Unsupported,
            ImportItemRole::Unknown,
            reasons,
            None,
        );
    }
    if sample.empty {
        reasons.push(ImportPreviewReason::EmptyContent);
        return (
            ImportItemStatus::Unsupported,
            ImportItemRole::Unknown,
            reasons,
            None,
        );
    }

    let (fingerprint, mixed) = fingerprint_sample(sample);

    // A validated manifest is authoritative for role, per #763. It is not
    // authoritative for *format* — content still decides that.
    if manifest_valid {
        if let Some(role) = manifest_role {
            reasons.push(ImportPreviewReason::ManifestDeclared);
            let status = match role {
                ImportItemRole::Log => ImportItemStatus::Ready,
                ImportItemRole::OperationalMetrics => {
                    reasons.push(ImportPreviewReason::MetricsDocument);
                    ImportItemStatus::Supporting
                }
                ImportItemRole::Readme => {
                    reasons.push(ImportPreviewReason::ReadmeDocument);
                    ImportItemStatus::Supporting
                }
                ImportItemRole::Attachment | ImportItemRole::Unknown => {
                    ImportItemStatus::Supporting
                }
            };
            reasons.sort_unstable();
            reasons.dedup();
            return (status, role, reasons, fingerprint);
        }
    }

    if mixed {
        reasons.push(ImportPreviewReason::MixedFormatRecords);
        reasons.sort_unstable();
        reasons.dedup();
        return (
            ImportItemStatus::Review,
            ImportItemRole::Log,
            reasons,
            fingerprint,
        );
    }

    let Some(fp) = fingerprint else {
        reasons.push(ImportPreviewReason::NoStructuredMatch);
        return (
            ImportItemStatus::RawFallback,
            ImportItemRole::Log,
            reasons,
            None,
        );
    };

    let status = match fp.outcome {
        FormatFingerprintOutcome::Matched if fp.score >= MIN_STRUCTURED_FORMAT_SCORE => {
            reasons.push(ImportPreviewReason::StrongFormatMatch);
            ImportItemStatus::Ready
        }
        FormatFingerprintOutcome::Matched => {
            // Matched below the structured threshold is real uncertainty.
            reasons.push(ImportPreviewReason::AmbiguousFormatMatch);
            ImportItemStatus::Review
        }
        FormatFingerprintOutcome::Ambiguous => {
            reasons.push(ImportPreviewReason::AmbiguousFormatMatch);
            ImportItemStatus::Review
        }
        FormatFingerprintOutcome::Unknown => {
            reasons.push(ImportPreviewReason::NoStructuredMatch);
            ImportItemStatus::RawFallback
        }
    };

    if name_hints_log(identity) && status == ImportItemStatus::RawFallback {
        reasons.push(ImportPreviewReason::WeakNameHintOnly);
    }

    reasons.sort_unstable();
    reasons.dedup();
    (status, ImportItemRole::Log, reasons, Some(fp))
}

/// Whether the name alone suggests a log. Never decisive on its own.
fn name_hints_log(identity: &str) -> bool {
    let leaf = identity.rsplit('/').next().unwrap_or(identity);
    let lower = leaf.to_ascii_lowercase();
    lower.ends_with(".log")
        || lower.ends_with(".jsonl")
        || lower.ends_with(".ndjson")
        || lower.contains(".log.")
}

/// Deterministic preselection.
///
/// Exactly two things are preselected: components a **validated** manifest
/// declared as logs, and sources whose **content** matched a structured format
/// outright. Everything else — uncertainty, raw text, supporting documents —
/// is visible and unselected, because #751 makes "keep raw" the honest default
/// and forbids silent decisions. Blocked items are never selectable.
pub(super) fn preselect(status: ImportItemStatus, role: ImportItemRole) -> bool {
    matches!(status, ImportItemStatus::Ready) && matches!(role, ImportItemRole::Log)
}

/// Strip a rotation suffix, returning the shared stem when one is present.
///
/// Recognizes `app.log.1`, `app.log.2026-01-01`, `app-2026-01-01.log`, and
/// `app.log.gz`-style trailers. Returns `None` when the name is not rolled,
/// so unrelated files are never grouped.
pub(super) fn rolled_stem(identity: &str) -> Option<String> {
    let (dir, leaf) = match identity.rsplit_once('/') {
        Some((dir, leaf)) => (Some(dir), leaf),
        None => (None, identity),
    };
    let stem = rolled_leaf_stem(leaf)?;
    Some(match dir {
        Some(dir) => format!("{dir}/{stem}"),
        None => stem,
    })
}

/// Build a bare item for tests in sibling modules.
///
/// `#[cfg(test)]` so it cannot be reached from a production build: import profile
/// matching must always be exercised against reports the real classifier
/// produced, and this exists only to let sibling unit tests state a status
/// and observed format directly.
#[cfg(test)]
pub(super) fn item_for_test(
    identity: &str,
    status: ImportItemStatus,
    format_id: Option<&str>,
) -> ImportPreviewItem {
    ImportPreviewItem {
        identity: identity.to_string(),
        basename: redacted_basename(identity),
        bytes: 0,
        status,
        role: ImportItemRole::Log,
        selected: preselect(status, ImportItemRole::Log),
        format_id: format_id.map(str::to_string),
        format_version: format_id.map(|_| 1),
        outcome: None,
        score: None,
        runner_up_margin: None,
        producer_hint: None,
        decisive_clue_codes: Vec::new(),
        reasons: Vec::new(),
        representative: None,
        group_id: None,
    }
}

/// Assemble a report from test items.
#[cfg(test)]
pub(super) fn finish_report_for_test(
    source_kind: ImportSourceKind,
    items: Vec<ImportPreviewItem>,
) -> ImportPreviewReport {
    finish_report(source_kind, items, false, None)
}

/// Assemble a deliberately truncated report from test items.
#[cfg(test)]
pub(super) fn truncated_report_for_test(
    source_kind: ImportSourceKind,
    items: Vec<ImportPreviewItem>,
) -> ImportPreviewReport {
    finish_report(source_kind, items, true, None)
}

/// Build a bare item with an explicit status and role, for sibling tests.
#[cfg(test)]
pub(super) fn item_with_status_for_test(
    identity: &str,
    status: ImportItemStatus,
) -> ImportPreviewItem {
    let mut item = item_for_test(identity, status, None);
    item.role = ImportItemRole::Unknown;
    item.selected = false;
    item
}

/// Rotation-suffix stripping for a single leaf name.
fn rolled_leaf_stem(leaf: &str) -> Option<String> {
    // Trailing numeric or date segment: app.log.1 / app.log.2026-01-01
    if let Some((head, tail)) = leaf.rsplit_once('.') {
        if !tail.is_empty() && is_rotation_token(tail) && head.contains('.') {
            return Some(head.to_string());
        }
    }
    // Embedded date before the extension: app-2026-01-01.log / app_20260101.log
    //
    // Matched by width from the right rather than by splitting on the last
    // separator, because `rsplit_once('-')` on `app-2026-01-01` yields `01`
    // and would never recognize the date.
    if let Some((head, ext)) = leaf.rsplit_once('.') {
        for width in [10usize, 8] {
            if head.len() <= width + 1 || !head.is_char_boundary(head.len() - width) {
                continue;
            }
            let (base, tail) = head.split_at(head.len() - width);
            if !is_date_token(tail) {
                continue;
            }
            let base = base.trim_end_matches(['-', '_']);
            if !base.is_empty() {
                return Some(format!("{base}.{ext}"));
            }
        }
    }
    None
}

/// Whether a token looks like a rotation index or date.
fn is_rotation_token(token: &str) -> bool {
    is_date_token(token) || (token.len() <= 4 && token.chars().all(|c| c.is_ascii_digit()))
}

/// Whether a token looks like `YYYY-MM-DD` or `YYYYMMDD`.
fn is_date_token(token: &str) -> bool {
    let digits = token.chars().filter(char::is_ascii_digit).count();
    let seps = token.chars().filter(|c| *c == '-' || *c == '_').count();
    (token.len() == 8 && digits == 8) || (token.len() == 10 && digits == 8 && seps == 2)
}

/// Fold rolled sources into groups, but only where fingerprints agree.
///
/// #751 is explicit that sources may be grouped *only* when their content
/// fingerprints agree. A shared stem is a hint that they might belong
/// together; it is never sufficient. Members that share a stem but disagree on
/// format are deliberately left ungrouped, and each keeps its own row.
pub(super) fn build_groups(items: &mut [ImportPreviewItem]) -> Vec<ImportPreviewGroup> {
    let mut by_stem: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        if item.format_id.is_none() {
            continue;
        }
        if !matches!(item.status, ImportItemStatus::Ready) {
            continue;
        }
        if let Some(stem) = rolled_stem(&item.identity) {
            by_stem.entry(stem).or_default().push(index);
        }
    }

    let mut groups = Vec::new();
    for (stem, indices) in by_stem {
        if indices.len() < 2 {
            continue;
        }
        let first = &items[indices[0]];
        let (Some(format_id), Some(format_version)) =
            (first.format_id.clone(), first.format_version)
        else {
            continue;
        };
        // Fingerprint agreement is the gate. One disagreeing member dissolves
        // the whole group rather than silently excluding that member.
        let agrees = indices.iter().all(|index| {
            items[*index].format_id.as_deref() == Some(format_id.as_str())
                && items[*index].format_version == Some(format_version)
        });
        if !agrees {
            continue;
        }
        let group_id = format!("{stem}#{format_id}@{format_version}");
        let mut member_identities: Vec<String> = indices
            .iter()
            .map(|index| items[*index].identity.clone())
            .collect();
        member_identities.sort();
        for index in &indices {
            items[*index].group_id = Some(group_id.clone());
        }
        groups.push(ImportPreviewGroup {
            group_id,
            stem,
            format_id,
            format_version,
            // Rotation can duplicate records across files; the preview
            // discloses the possibility rather than asserting a clean split.
            possible_overlap: true,
            member_identities,
        });
    }
    groups.sort_by(|left, right| left.group_id.cmp(&right.group_id));
    groups
}

/// Assemble a finished report from classified items.
pub(super) fn finish_report(
    source_kind: ImportSourceKind,
    mut items: Vec<ImportPreviewItem>,
    truncated: bool,
    manifest: Option<ImportManifestSummary>,
) -> ImportPreviewReport {
    items.sort_by(|left, right| left.identity.cmp(&right.identity));
    let groups = build_groups(&mut items);

    let mut counts = ImportPreviewCounts {
        total: items.len() as u64,
        ..ImportPreviewCounts::default()
    };
    for item in &items {
        match item.status {
            ImportItemStatus::Ready => counts.ready += 1,
            ImportItemStatus::Review => counts.review += 1,
            ImportItemStatus::RawFallback => counts.raw_fallback += 1,
            ImportItemStatus::Supporting => counts.supporting += 1,
            ImportItemStatus::Ignored => counts.ignored += 1,
            ImportItemStatus::Unsupported => counts.unsupported += 1,
            ImportItemStatus::Blocked => counts.blocked += 1,
        }
        if item.selected {
            counts.selected += 1;
        }
    }

    ImportPreviewReport {
        schema_version: IMPORT_PREVIEW_SCHEMA_VERSION,
        source_kind,
        items,
        groups,
        counts,
        truncated,
        manifest,
    }
}

/// Build one item from a sampled source.
pub(super) fn item_from_sample(
    identity: &str,
    bytes: u64,
    sample: &BoundedSample,
    manifest_role: Option<ImportItemRole>,
    manifest_valid: bool,
) -> ImportPreviewItem {
    let (status, role, reasons, fingerprint) =
        classify(identity, sample, manifest_role, manifest_valid);
    let representative = sample.first_record().and_then(representative_excerpt);
    let selected = preselect(status, role);

    let (format_id, format_version, outcome, score, runner_up_margin, producer_hint, clues) =
        match &fingerprint {
            Some(fp) => (
                fp.format_id.map(str::to_string),
                fp.format_version,
                Some(wire_outcome(fp.outcome)),
                Some(fp.score),
                fp.runner_up_margin,
                fp.producer_hint.map(str::to_string),
                fp.decisive_clue_codes
                    .iter()
                    .map(|code| (*code).to_string())
                    .collect(),
            ),
            None => (None, None, None, None, None, None, Vec::new()),
        };

    ImportPreviewItem {
        identity: identity.to_string(),
        basename: redacted_basename(identity),
        bytes,
        status,
        role,
        selected,
        format_id,
        format_version,
        outcome,
        score,
        runner_up_margin,
        producer_hint,
        decisive_clue_codes: clues,
        reasons,
        representative,
        group_id: None,
    }
}

/// Build an item for an entry that was refused or excluded before sampling.
pub(super) fn excluded_item(
    identity: &str,
    bytes: u64,
    status: ImportItemStatus,
    reason: ImportPreviewReason,
) -> ImportPreviewItem {
    ImportPreviewItem {
        identity: identity.to_string(),
        basename: redacted_basename(identity),
        bytes,
        status,
        role: ImportItemRole::Unknown,
        selected: false,
        format_id: None,
        format_version: None,
        outcome: None,
        score: None,
        runner_up_margin: None,
        producer_hint: None,
        decisive_clue_codes: Vec::new(),
        reasons: vec![reason],
        representative: None,
        group_id: None,
    }
}

/// Map an ingest exclusion reason string to a preview status and reason code.
///
/// The strings are the stable ones `ingest` already records
/// (`"symlink"`, `"binary"`, …), so the two paths cannot drift apart in what
/// they consider excluded.
pub(super) fn map_exclusion(reason: &str) -> (ImportItemStatus, ImportPreviewReason) {
    match reason {
        "symlink" => (
            ImportItemStatus::Blocked,
            ImportPreviewReason::SymlinkRejected,
        ),
        "non_regular" => (
            ImportItemStatus::Blocked,
            ImportPreviewReason::NonRegularRejected,
        ),
        "binary" => (
            ImportItemStatus::Unsupported,
            ImportPreviewReason::BinaryContent,
        ),
        "too_large" => (ImportItemStatus::Blocked, ImportPreviewReason::Oversized),
        "hidden" => (ImportItemStatus::Ignored, ImportPreviewReason::Hidden),
        "directory" => (ImportItemStatus::Ignored, ImportPreviewReason::Hidden),
        _ => (
            ImportItemStatus::Unsupported,
            ImportPreviewReason::ReadFailed,
        ),
    }
}

/// Preview a filesystem path without importing anything.
///
/// Accepts a regular file, a directory, or a ZIP archive, mirroring the single
/// guided import entry point #763 asks for. Reuses the ingest traversal and
/// safety limits exactly; a source that ingest would refuse is refused here
/// with the same error.
///
/// Never writes, stages, or publishes. Cancellation returns
/// `CoreError::Cancelled` and leaves nothing behind, because nothing was
/// created in the first place.
pub fn preview_import_path(
    path: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<ImportPreviewReport> {
    super::ingest::preview_import_path_impl(path, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_of(lines: &[&str]) -> BoundedSample {
        BoundedSample {
            windows: vec![lines.join("\n")],
            binary: false,
            empty: lines.iter().all(|l| l.trim().is_empty()),
        }
    }

    fn windows_of(windows: &[&str]) -> BoundedSample {
        BoundedSample {
            windows: windows.iter().map(|w| (*w).to_string()).collect(),
            binary: false,
            empty: false,
        }
    }

    #[test]
    fn strong_json_match_is_ready_and_preselected() {
        let sample = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"hello"}"#]);
        let item = item_from_sample("app.jsonl", 128, &sample, None, false);
        assert_eq!(item.status, ImportItemStatus::Ready);
        assert_eq!(item.role, ImportItemRole::Log);
        assert!(item.selected);
        assert!(item
            .reasons
            .contains(&ImportPreviewReason::StrongFormatMatch));
    }

    #[test]
    fn misleading_log_extension_over_binary_content_is_unsupported_not_ready() {
        let mut sample = sample_of(&["ignored"]);
        sample.binary = true;
        let item = item_from_sample("totally-real.log", 4096, &sample, None, false);
        assert_eq!(item.status, ImportItemStatus::Unsupported);
        assert!(!item.selected);
        assert!(item.reasons.contains(&ImportPreviewReason::BinaryContent));
        // The misleading name is disclosed rather than trusted.
        assert!(item
            .reasons
            .contains(&ImportPreviewReason::WeakNameHintOnly));
    }

    #[test]
    fn plain_text_is_raw_fallback_and_never_preselected() {
        let sample = sample_of(&["just some prose with no structure at all"]);
        let item = item_from_sample("notes.txt", 64, &sample, None, false);
        assert_eq!(item.status, ImportItemStatus::RawFallback);
        assert!(
            !item.selected,
            "raw fallback must stay opt-in; keep-raw is offered, never assumed"
        );
    }

    #[test]
    fn mixed_format_windows_downgrade_to_review() {
        let sample = windows_of(&[
            r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"json head"}"#,
            "plain interior line with no structure",
        ]);
        let item = item_from_sample("mixed.log", 999_999, &sample, None, false);
        assert_eq!(
            item.status,
            ImportItemStatus::Review,
            "a file that is only JSON in its first window must not be reported as JSON"
        );
        assert!(item
            .reasons
            .contains(&ImportPreviewReason::MixedFormatRecords));
        assert!(!item.selected);
    }

    #[test]
    fn validated_manifest_routes_metrics_away_from_logs() {
        let sample = sample_of(&[r#"{"series":[]}"#]);
        let item = item_from_sample(
            "metrics/ops.json",
            256,
            &sample,
            Some(ImportItemRole::OperationalMetrics),
            true,
        );
        assert_eq!(item.role, ImportItemRole::OperationalMetrics);
        assert_eq!(item.status, ImportItemStatus::Supporting);
        assert!(
            !item.selected,
            "metrics are routed separately, not imported as logs"
        );
        assert!(item.reasons.contains(&ImportPreviewReason::MetricsDocument));
    }

    #[test]
    fn invalid_manifest_is_not_authoritative() {
        let sample = sample_of(&["plain text body"]);
        let item = item_from_sample(
            "logs/app.log",
            256,
            &sample,
            Some(ImportItemRole::Log),
            false,
        );
        assert!(
            !item
                .reasons
                .contains(&ImportPreviewReason::ManifestDeclared),
            "an invalid manifest must never confer ready status"
        );
        assert_eq!(item.status, ImportItemStatus::RawFallback);
    }

    #[test]
    fn blocked_items_are_never_selectable() {
        assert!(!ImportItemStatus::Blocked.is_selectable());
        assert!(!preselect(ImportItemStatus::Blocked, ImportItemRole::Log));
        assert!(ImportItemStatus::Review.is_selectable());
    }

    #[test]
    fn rolled_names_are_detected_but_only_group_when_fingerprints_agree() {
        assert_eq!(rolled_stem("app.log.1").as_deref(), Some("app.log"));
        assert_eq!(
            rolled_stem("app.log.2026-01-01").as_deref(),
            Some("app.log")
        );
        assert_eq!(
            rolled_stem("app-2026-01-01.log").as_deref(),
            Some("app.log")
        );
        assert_eq!(rolled_stem("app.log"), None);
        assert_eq!(rolled_stem("unrelated.txt"), None);

        let json = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#]);
        let mut items = vec![
            item_from_sample("app.log.1", 10, &json, None, false),
            item_from_sample("app.log.2", 10, &json, None, false),
        ];
        let groups = build_groups(&mut items);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].member_identities.len(), 2);
        assert!(
            groups[0].possible_overlap,
            "rotation may duplicate records; overlap must be disclosed"
        );
    }

    #[test]
    fn rolled_names_with_disagreeing_fingerprints_are_not_grouped() {
        let json = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#]);
        let syslog = sample_of(&["<34>1 2026-01-01T00:00:00Z host app - - - boot"]);
        let mut items = vec![
            item_from_sample("app.log.1", 10, &json, None, false),
            item_from_sample("app.log.2", 10, &syslog, None, false),
        ];
        let groups = build_groups(&mut items);
        assert!(
            groups.is_empty(),
            "a shared rolled stem must never group sources whose content disagrees"
        );
        assert!(items.iter().all(|item| item.group_id.is_none()));
        assert_eq!(items.len(), 2, "both files keep their own identity");
    }

    #[test]
    fn representative_records_are_redacted_and_bounded() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let record = format!("2026-01-01 INFO aws_access_key={secret} starting");
        let excerpt = representative_excerpt(&record).expect("excerpt");
        assert!(
            !excerpt.contains(secret),
            "credentials must not survive preview"
        );

        let long = "x".repeat(MAX_IMPORT_PREVIEW_REPRESENTATIVE_BYTES * 4);
        let bounded = representative_excerpt(&long).expect("excerpt");
        assert!(bounded.len() <= MAX_IMPORT_PREVIEW_REPRESENTATIVE_BYTES);
    }

    #[test]
    fn representative_records_drop_forbidden_evaluator_sentinels() {
        let excerpt = representative_excerpt("case expected_diagnosis=disk-full").expect("excerpt");
        assert!(!excerpt.contains("expected_diagnosis"));
    }

    #[test]
    fn binary_sniffing_accepts_utf8_and_rejects_nul() {
        assert!(!is_binary("héllo wörld log line".as_bytes()));
        assert!(is_binary(b"\x00\x01\x02binary"));
        assert!(is_binary(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]));
    }

    #[test]
    fn counts_and_ordering_are_deterministic() {
        let json = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#]);
        let text = sample_of(&["plain"]);
        let items = vec![
            item_from_sample("z.jsonl", 1, &json, None, false),
            item_from_sample("a.txt", 2, &text, None, false),
            excluded_item(
                "link",
                0,
                ImportItemStatus::Blocked,
                ImportPreviewReason::SymlinkRejected,
            ),
        ];
        let report = finish_report(ImportSourceKind::Directory, items, false, None);
        let identities: Vec<&str> = report.items.iter().map(|i| i.identity.as_str()).collect();
        assert_eq!(identities, vec!["a.txt", "link", "z.jsonl"]);
        assert_eq!(report.counts.total, 3);
        assert_eq!(report.counts.ready, 1);
        assert_eq!(report.counts.raw_fallback, 1);
        assert_eq!(report.counts.blocked, 1);
        assert_eq!(report.counts.selected, 1);
        assert_eq!(report.selected_identities(), vec!["z.jsonl"]);
    }

    #[test]
    fn ignored_noise_is_its_own_ledger_state_not_a_supporting_document() {
        let (status, reason) = map_exclusion("hidden");
        assert_eq!(status, ImportItemStatus::Ignored);
        assert_eq!(reason, ImportPreviewReason::Hidden);

        let report = finish_report(
            ImportSourceKind::Directory,
            vec![excluded_item(
                ".cache",
                0,
                ImportItemStatus::Ignored,
                ImportPreviewReason::Hidden,
            )],
            false,
            None,
        );
        assert_eq!(report.counts.ignored, 1);
        assert_eq!(
            report.counts.supporting, 0,
            "ignored noise must stay countable separately from supporting documents"
        );
    }

    #[test]
    fn a_plan_with_nothing_importable_is_blocked_by_the_core() {
        let empty = finish_report(ImportSourceKind::Directory, Vec::new(), false, None);
        assert_eq!(empty.plan_block(), Some(ImportPlanBlock::SourceEmpty));

        let all_blocked = finish_report(
            ImportSourceKind::Directory,
            vec![excluded_item(
                "link",
                0,
                ImportItemStatus::Blocked,
                ImportPreviewReason::SymlinkRejected,
            )],
            false,
            None,
        );
        assert_eq!(
            all_blocked.plan_block(),
            Some(ImportPlanBlock::AllSourcesBlocked)
        );

        let only_noise = finish_report(
            ImportSourceKind::Directory,
            vec![
                excluded_item(
                    ".cache",
                    0,
                    ImportItemStatus::Ignored,
                    ImportPreviewReason::Hidden,
                ),
                excluded_item(
                    "image.png",
                    9,
                    ImportItemStatus::Unsupported,
                    ImportPreviewReason::BinaryContent,
                ),
            ],
            false,
            None,
        );
        assert_eq!(
            only_noise.plan_block(),
            Some(ImportPlanBlock::NoImportableSources),
            "publishing here would create an empty corpus and report success"
        );
    }

    #[test]
    fn a_plan_with_any_importable_source_is_not_blocked() {
        let json = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#]);
        let text = sample_of(&["plain"]);
        for sample in [&json, &text] {
            let report = finish_report(
                ImportSourceKind::Directory,
                vec![item_from_sample("a.log", 4, sample, None, false)],
                false,
                None,
            );
            assert_eq!(report.plan_block(), None);
            assert_eq!(report.importable_count(), 1);
        }
        // Raw fallback counts as importable even though it is not preselected:
        // the user may still choose to keep it raw.
        let raw = finish_report(
            ImportSourceKind::Directory,
            vec![item_from_sample("a.txt", 4, &text, None, false)],
            false,
            None,
        );
        assert_eq!(raw.counts.selected, 0);
        assert_eq!(raw.plan_block(), None);
    }

    #[test]
    fn record_alignment_discards_partial_prefixes_and_suffixes() {
        // Interior window: both ends incomplete.
        let raw = b"ial record\ncomplete\npartial";
        assert_eq!(align_to_records(raw, false, false), b"complete\n");
        // Head window: prefix is complete, suffix is not.
        assert_eq!(
            align_to_records(raw, true, false),
            b"ial record\ncomplete\n"
        );
        // Tail window: suffix runs to EOF, so the last record is legitimate.
        assert_eq!(align_to_records(raw, false, true), b"complete\npartial");
        // Whole source.
        assert_eq!(align_to_records(raw, true, true), raw);
        // A window sitting entirely inside one huge record yields no evidence.
        assert_eq!(align_to_records(b"no newline here", false, false), b"");
    }

    #[test]
    fn alignment_never_splits_a_utf8_sequence() {
        // Multi-byte characters either side of the boundary; `\n` is ASCII and
        // cannot occur inside a UTF-8 sequence, so an aligned slice is always
        // decodable without replacement characters.
        let raw = "héllo wörld\n日本語のログ\nおしまい".as_bytes();
        for (start, end) in [(true, true), (false, false), (true, false), (false, true)] {
            let aligned = align_to_records(raw, start, end);
            assert!(
                std::str::from_utf8(aligned).is_ok(),
                "aligned slice must be valid UTF-8"
            );
        }
    }

    /// Build a uniform JSONL body whose midpoint and tail offsets are
    /// guaranteed to land *inside* a record rather than on a boundary.
    fn uniform_jsonl(records: usize) -> Vec<u8> {
        let mut body = Vec::new();
        for index in 0..records {
            body.extend_from_slice(
                format!(
                    r#"{{"ts":"2026-01-01T00:00:00Z","level":"info","seq":{index},"msg":"padded out so records straddle every window boundary"}}"#
                )
                .as_bytes(),
            );
            body.push(b'\n');
        }
        body
    }

    #[test]
    fn a_uniform_jsonl_file_is_not_reported_as_mixed_when_windows_split_records() {
        let body = uniform_jsonl(4_000);
        // Prove the offsets genuinely land mid-record, or the test proves nothing.
        let mid = body.len() / 2;
        assert_ne!(body[mid - 1], b'\n', "midpoint must land inside a record");
        let tail_start = body.len() - IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES;
        assert_ne!(
            body[tail_start - 1],
            b'\n',
            "tail offset must land inside a record"
        );

        let mut cursor = std::io::Cursor::new(body.clone());
        let sample = sample_bounded(&mut cursor, body.len() as u64);
        let item = item_from_sample("uniform.jsonl", body.len() as u64, &sample, None, false);

        assert_eq!(
            item.status,
            ImportItemStatus::Ready,
            "a uniform JSONL file must stay Ready; reasons={:?}",
            item.reasons
        );
        assert!(!item
            .reasons
            .contains(&ImportPreviewReason::MixedFormatRecords));
        assert_eq!(item.format_id.as_deref(), Some("json-object-line"));
        assert!(item.selected);
    }

    #[test]
    fn a_uniform_logfmt_file_is_not_reported_as_mixed_when_windows_split_records() {
        let mut body = Vec::new();
        for index in 0..6_000 {
            body.extend_from_slice(
                format!(
                    "ts=2026-01-01T00:00:00Z level=info seq={index} msg=\"padded out so records straddle window boundaries\"\n"
                )
                .as_bytes(),
            );
        }
        let mut cursor = std::io::Cursor::new(body.clone());
        let sample = sample_bounded(&mut cursor, body.len() as u64);
        let item = item_from_sample("uniform.log", body.len() as u64, &sample, None, false);
        assert!(
            !item
                .reasons
                .contains(&ImportPreviewReason::MixedFormatRecords),
            "uniform logfmt must not be reported as mixed; reasons={:?}",
            item.reasons
        );
    }

    #[test]
    fn a_genuinely_mixed_file_is_still_detected_after_alignment() {
        // Control for the two tests above: alignment must not suppress real
        // mixing. JSON head, plain-text interior and tail.
        let mut body = uniform_jsonl(200);
        for index in 0..60_000 {
            body.extend_from_slice(format!("plain unstructured line {index}\n").as_bytes());
        }
        let mut cursor = std::io::Cursor::new(body.clone());
        let sample = sample_bounded(&mut cursor, body.len() as u64);
        let item = item_from_sample("mixed.log", body.len() as u64, &sample, None, false);
        assert_ne!(
            item.status,
            ImportItemStatus::Ready,
            "real mixing must still be caught"
        );
        assert!(!item.selected);
    }

    #[test]
    fn streaming_cancellation_returns_cancelled_promptly() {
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'x');
                if let Some(last) = buf.last_mut() {
                    *last = b'\n';
                }
                Ok(buf.len())
            }
        }
        let cancel = CancelFlag::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        let error = sample_streaming(&mut Endless, u64::MAX, Some(&cancel))
            .expect_err("cancelled stream must not classify");
        assert!(matches!(error, crate::error::CoreError::Cancelled));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancellation must be prompt, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_mid_stream_read_failure_is_reported_not_classified() {
        struct FailsAfterOneChunk {
            served: bool,
        }
        impl Read for FailsAfterOneChunk {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.served {
                    return Err(std::io::Error::other("decompression failed"));
                }
                self.served = true;
                let line = br#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#;
                let n = line.len().min(buf.len());
                buf[..n].copy_from_slice(&line[..n]);
                buf[n] = b'\n';
                Ok(n + 1)
            }
        }
        let outcome = sample_streaming(&mut FailsAfterOneChunk { served: false }, 1_000_000, None)
            .expect("a read failure is an outcome, not an error");
        assert!(
            matches!(outcome, SampleOutcome::ReadFailed),
            "a partially-read member must never be classified as trustworthy content"
        );
    }

    #[test]
    fn serialized_report_leaks_no_paths_or_raw_payload() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let sample = sample_of(&[&format!("2026-01-01 INFO aws_access_key_id={secret}")]);
        let items = vec![item_from_sample(
            "host-a.zip!/var/log/app.log",
            10,
            &sample,
            None,
            false,
        )];
        let report = finish_report(ImportSourceKind::Archive, items, false, None);
        let encoded = serde_json::to_string(&report).expect("serialize");
        assert!(!encoded.contains("/Users/"));
        assert!(!encoded.contains(secret));
    }
}
