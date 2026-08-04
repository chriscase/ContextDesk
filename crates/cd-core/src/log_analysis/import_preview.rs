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
//! * Path, name, and extension are **weak format hints only**. Status is
//!   normally decided from bounded content samples through
//!   [`super::format_profile::fingerprint_format`], which itself ignores the
//!   path. A file called `app.log` holding a PNG is `Unsupported`, while an
//!   unhinted text file holding repeated JSON records is a strong match. An
//!   extension may still identify a parser capability boundary: markup is
//!   kept visible as supporting material until a real event parser exists.
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

use crate::error::{CoreError, CoreResult};
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
    /// Genuinely uncertain — competing formats, or mixed records. Event-bearing
    /// log sources remain preselected so uncertainty never silently drops data.
    Review,
    /// Readable text with no structured match. Event-bearing log sources import
    /// as raw lines by default; the user may review and deselect them.
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
    /// An unhinted source did not contain enough distinct structured event
    /// records to justify automatic log import.
    InsufficientEventEvidence,
    /// XML-shaped material is inventoried but cannot yet be parsed into
    /// trustworthy event records.
    XmlEventParsingUnsupported,
    /// HTML-shaped material is inventoried but cannot be parsed into
    /// trustworthy event records by the line-oriented importer.
    HtmlEventParsingUnsupported,
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
    /// Host-only fingerprint of the bounded source evidence used to build
    /// this row. It is deliberately absent from the renderer DTO: the plan
    /// token needs change detection, while the webview does not need a raw
    /// content correlation handle.
    #[serde(skip)]
    pub(crate) plan_fingerprint: String,
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
    /// SHA-256 over the bytes actually examined. Streaming archive members
    /// cover the full member; seekable ordinary files cover the bounded
    /// head/interior/tail windows by design.
    content_fingerprint: String,
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
    use sha2::{Digest, Sha256};

    let mut sample = BoundedSample {
        empty: true,
        ..BoundedSample::default()
    };
    let mut content_hasher = Sha256::new();
    for offset in sample_offsets(total_bytes) {
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
        content_hasher.update(offset.to_le_bytes());
        content_hasher.update((read as u64).to_le_bytes());
        content_hasher.update(bytes);
        let at_source_start = offset == 0;
        let at_source_end = offset.saturating_add(read as u64) >= total_bytes;
        // Binary detection runs on the RAW window: a binary blob has no
        // newlines to align to, and alignment would otherwise turn it into an
        // empty (and therefore "empty file") sample.
        if is_binary_window(bytes, at_source_start) {
            sample.binary = true;
            sample.empty = false;
            sample.content_fingerprint = sha256_digest_hex(content_hasher.finalize());
            return sample;
        }
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
    sample.content_fingerprint = sha256_digest_hex(content_hasher.finalize());
    sample
}

/// Exact head/interior/tail offsets shared by seekable files and ZIP streams.
fn sample_offsets(total_bytes: u64) -> Vec<u64> {
    let window = IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES as u64;
    let mut offsets = vec![0];
    if total_bytes > window.saturating_mul(2) {
        offsets.push(total_bytes / 2);
    }
    if total_bytes > window.saturating_mul(3) {
        offsets.push(total_bytes.saturating_sub(window));
    }
    offsets.truncate(IMPORT_PREVIEW_SAMPLE_WINDOWS);
    offsets
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
    use sha2::{Digest, Sha256};

    let window = IMPORT_PREVIEW_SAMPLE_WINDOW_BYTES;
    let mut raw_windows: Vec<(u64, Vec<u8>)> = sample_offsets(total_bytes)
        .into_iter()
        .map(|offset| (offset, Vec::with_capacity(window)))
        .collect();
    let mut consumed: u64 = 0;
    let mut chunk = vec![0u8; 8 * 1024];
    let mut content_hasher = Sha256::new();

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
        content_hasher.update(bytes);
        let chunk_end = consumed.saturating_add(read as u64);
        for (offset, raw) in &mut raw_windows {
            let window_end = offset.saturating_add(window as u64).min(total_bytes);
            let overlap_start = consumed.max(*offset);
            let overlap_end = chunk_end.min(window_end);
            if overlap_start < overlap_end {
                let start = (overlap_start - consumed) as usize;
                let end = (overlap_end - consumed) as usize;
                raw.extend_from_slice(&bytes[start..end]);
            }
        }
        consumed = chunk_end;
    }

    // Classify the same bounded raw evidence as the seekable path. Transport
    // chunk boundaries are not content boundaries: a valid multi-byte UTF-8
    // code point can straddle two decompression reads.
    if raw_windows
        .iter()
        .any(|(offset, raw)| is_binary_window(raw, *offset == 0))
    {
        return Ok(SampleOutcome::Sampled(BoundedSample {
            windows: Vec::new(),
            binary: true,
            empty: false,
            content_fingerprint: sha256_digest_hex(content_hasher.finalize()),
        }));
    }

    let mut windows = Vec::new();
    let mut empty = true;
    for (offset, raw) in raw_windows {
        if raw.is_empty() {
            continue;
        }
        let at_start = offset == 0;
        let at_end = offset.saturating_add(raw.len() as u64) >= total_bytes;
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
        content_fingerprint: sha256_digest_hex(content_hasher.finalize()),
    }))
}

fn sha256_digest_hex(digest: impl AsRef<[u8]>) -> String {
    let bytes = digest.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn bounded_sample_plan_fingerprint(sample: &BoundedSample) -> String {
    if !sample.content_fingerprint.is_empty() {
        return sample.content_fingerprint.clone();
    }
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"contextdesk-import-preview-sample-v1");
    hasher.update([u8::from(sample.binary), u8::from(sample.empty)]);
    for window in &sample.windows {
        hasher.update((window.len() as u64).to_le_bytes());
        hasher.update(window.as_bytes());
    }
    sha256_digest_hex(hasher.finalize())
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
/// A NUL byte is decisive. Control-heavy content is also binary. Otherwise a
/// window is binary when more than one byte in eight actually fails UTF-8
/// decoding, which catches images and compiled objects while tolerating
/// isolated legacy-encoding bytes in an otherwise-text log.
#[cfg(test)]
pub(super) fn is_binary(bytes: &[u8]) -> bool {
    is_binary_window(bytes, true)
}

/// Binary sniffing for a raw sample window.
fn is_binary_window(bytes: &[u8], at_source_start: bool) -> bool {
    let sniff = &bytes[..bytes.len().min(IMPORT_PREVIEW_BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return true;
    }
    let disallowed_controls = sniff
        .iter()
        .filter(|byte| byte.is_ascii_control() && !matches!(**byte, b'\t' | b'\n' | b'\r' | 0x0c))
        .count();
    if disallowed_controls.saturating_mul(16) > sniff.len() {
        return true;
    }
    // Interior/tail windows may begin in the middle of one valid UTF-8 code
    // point. Ignore only the at-most-three continuation bytes that can belong
    // to that split character; dominant invalid data remains invalid.
    let leading_continuations = if at_source_start {
        0
    } else {
        sniff
            .iter()
            .take(3)
            .take_while(|byte| (**byte & 0b1100_0000) == 0b1000_0000)
            .count()
    };
    let sniff = &sniff[leading_continuations..];
    invalid_utf8_bytes(sniff).saturating_mul(8) > sniff.len()
}

/// Count only bytes belonging to malformed UTF-8 sequences.
///
/// `Utf8Error::valid_up_to` locates the first error; it does not say that the
/// entire suffix is invalid. Advance past each malformed sequence and keep
/// checking so valid text after an isolated legacy byte stays valid evidence.
/// An incomplete final code point is ignored because every bounded sampling
/// window may end in the middle of a valid source character.
fn invalid_utf8_bytes(mut bytes: &[u8]) -> usize {
    let mut invalid = 0usize;
    while !bytes.is_empty() {
        let Err(error) = std::str::from_utf8(bytes) else {
            break;
        };
        let valid = error.valid_up_to();
        let Some(error_len) = error.error_len() else {
            break;
        };
        invalid = invalid.saturating_add(error_len);
        bytes = &bytes[valid.saturating_add(error_len)..];
    }
    invalid
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

    // Markup needs record-boundary and field-mapping semantics that the
    // line-oriented fallback parser does not provide. Keep it in the ledger,
    // but never present it as useful event data by default. A validated
    // manifest can declare a role, but it does not supply a parser and
    // therefore cannot bypass these capability boundaries.
    let unsupported_markup = if name_or_sample_is_html(identity, sample) {
        Some(ImportPreviewReason::HtmlEventParsingUnsupported)
    } else if name_or_sample_is_xml(identity, sample) {
        Some(ImportPreviewReason::XmlEventParsingUnsupported)
    } else {
        None
    };
    if let Some(reason) = unsupported_markup {
        if manifest_valid && manifest_role.is_some() {
            reasons.push(ImportPreviewReason::ManifestDeclared);
        }
        reasons.push(reason);
        reasons.sort_unstable();
        reasons.dedup();
        return (
            ImportItemStatus::Supporting,
            ImportItemRole::Attachment,
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

    // A log/rotation name may keep raw text available as honest fallback, but
    // an unhinted document needs repeated, distinct structured records before
    // it is automatically treated as an event source. Deduplication prevents
    // overlapping head/interior/tail samples from manufacturing repetition.
    if !name_hints_log(identity) && credible_structured_record_count(sample) < 2 {
        if fingerprint
            .as_ref()
            .is_none_or(|fp| fp.outcome == FormatFingerprintOutcome::Unknown)
        {
            reasons.push(ImportPreviewReason::NoStructuredMatch);
        }
        reasons.push(ImportPreviewReason::InsufficientEventEvidence);
        reasons.sort_unstable();
        reasons.dedup();
        return (
            ImportItemStatus::Supporting,
            ImportItemRole::Attachment,
            reasons,
            fingerprint,
        );
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

/// Whether the name suggests a log or rotation.
///
/// This never decides format, but it preserves raw fallback candidacy for
/// files the operator's source convention explicitly presents as logs.
fn name_hints_log(identity: &str) -> bool {
    let leaf = identity.rsplit('/').next().unwrap_or(identity);
    let lower = leaf.to_ascii_lowercase();
    lower.ends_with(".log")
        || lower.ends_with(".jsonl")
        || lower.ends_with(".ndjson")
        || lower.contains(".log.")
        || rolled_leaf_stem(leaf).is_some_and(|stem| has_log_extension(&stem))
}

/// Count distinct strong structured records in the bounded sample.
///
/// Only the threshold (two) matters to callers, so stop once it is met. Full
/// record text is used as the deduplication key: the same sampled bytes must
/// not become multiple votes merely because windows overlap.
fn credible_structured_record_count(sample: &BoundedSample) -> usize {
    let mut distinct = std::collections::BTreeSet::new();
    for record in sample
        .windows
        .iter()
        .flat_map(|window| window.lines())
        .map(str::trim)
        .filter(|record| !record.is_empty())
    {
        let fingerprint = fingerprint_format(record, None);
        if fingerprint.outcome == FormatFingerprintOutcome::Matched
            && fingerprint.score >= MIN_STRUCTURED_FORMAT_SCORE
        {
            distinct.insert(record);
            if distinct.len() >= 2 {
                return 2;
            }
        }
    }
    distinct.len()
}

/// Whether a source crosses the current HTML parser-capability boundary.
///
/// Like XML detection, content sniffing is refusal-only and cannot promote
/// markup into event data.
fn name_or_sample_is_html(identity: &str, sample: &BoundedSample) -> bool {
    let leaf = identity.rsplit('/').next().unwrap_or(identity);
    let lower_leaf = leaf.to_ascii_lowercase();
    if lower_leaf.ends_with(".html") || lower_leaf.ends_with(".htm") {
        return true;
    }

    sample
        .windows
        .iter()
        .map(|window| window.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']))
        .find(|window| !window.is_empty())
        .is_some_and(|first| {
            let prefix = first
                .get(..first.len().min(64))
                .unwrap_or(first)
                .to_ascii_lowercase();
            prefix.starts_with("<!doctype html") || prefix.starts_with("<html")
        })
}

/// Whether a source crosses the current XML parser-capability boundary.
///
/// Content detection is refusal-only: it can keep XML-shaped material out of
/// the line parser, but can never promote arbitrary XML into event data.
fn name_or_sample_is_xml(identity: &str, sample: &BoundedSample) -> bool {
    let leaf = identity.rsplit('/').next().unwrap_or(identity);
    if leaf.to_ascii_lowercase().ends_with(".xml") {
        return true;
    }

    let first = sample
        .windows
        .iter()
        .map(|window| window.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']))
        .find(|window| !window.is_empty());
    let Some(first) = first else {
        return false;
    };

    if first.starts_with("<?xml") || first.starts_with("<!DOCTYPE") || first.starts_with("<!--") {
        return true;
    }

    let bytes = first.as_bytes();
    let starts_with_element = bytes.first() == Some(&b'<')
        && bytes
            .get(1)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(*byte, b'_' | b':'));
    starts_with_element
        && sample
            .windows
            .iter()
            .any(|window| window.contains("</") || window.contains("/>"))
}

fn has_log_extension(leaf: &str) -> bool {
    let lower = leaf.to_ascii_lowercase();
    lower.ends_with(".log") || lower.ends_with(".jsonl") || lower.ends_with(".ndjson")
}

/// Deterministic preselection.
///
/// Every source that can honestly produce log events is preselected: strong
/// structured matches, reviewable uncertain matches, and raw text fallback.
/// Supporting documents, ignored noise, unsupported content, and blocked
/// entries remain visible and unselected. This keeps broad log input by default
/// without silently treating non-log material as events.
pub(super) fn preselect(status: ImportItemStatus, role: ImportItemRole) -> bool {
    matches!(role, ImportItemRole::Log)
        && matches!(
            status,
            ImportItemStatus::Ready | ImportItemStatus::Review | ImportItemStatus::RawFallback
        )
}

/// Strip a rotation suffix, returning the shared stem when one is present.
///
/// Recognizes `app.log.1`, `app.log.2026-01-01`,
/// `app.log-20260101-120000`, `app-2026-01-01.log`, and `app.log.gz`-style
/// trailers. Returns `None` when the name is not rolled, so unrelated files
/// are never grouped.
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
        plan_fingerprint: String::new(),
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
    let (core, had_trailer) = strip_rotation_trailers(leaf);

    // Timestamp after an extension: service.log-20260101-120000 or
    // service.log.2026-01-01. Requiring an extension before the timestamp
    // avoids treating an arbitrary date-named document as a rolled source.
    for (index, separator) in core.char_indices() {
        if !matches!(separator, '-' | '.') {
            continue;
        }
        let Some(stem) = core.get(..index) else {
            continue;
        };
        let Some(token) = core.get(index + separator.len_utf8()..) else {
            continue;
        };
        if stem.contains('.') && is_datetime_token(token) {
            return Some(stem.to_string());
        }
    }

    // Timestamp before an extension: service-2026-01-01_030405.log.
    if let Some((head, extension)) = core.rsplit_once('.') {
        if let Some(mut base) = strip_datetime_suffix(head) {
            // Some producers couple a decimal process id directly to the
            // datetime (`worker.1234-...`). Strip that id only in this proven
            // datetime shape; a standalone dotted number remains untouched.
            if let Some((candidate, pid)) = base.rsplit_once('.') {
                if is_rotation_pid(pid) && !candidate.is_empty() {
                    base = candidate;
                }
            }
            if !base.is_empty() {
                return Some(format!("{base}.{extension}"));
            }
        }
    }

    // A generation/compression trailer alone is sufficient: app.log.1,
    // app.log.gz, and compositions such as app.log.1.gz all normalize to the
    // physical source stem. Content fingerprints still gate grouping.
    (had_trailer && core.contains('.')).then(|| core.to_string())
}

fn strip_rotation_trailers(mut leaf: &str) -> (&str, bool) {
    let mut stripped = false;
    for _ in 0..2 {
        let Some((head, trailer)) = leaf.rsplit_once('.') else {
            break;
        };
        let lower = trailer.to_ascii_lowercase();
        if is_rotation_index(trailer) || matches!(lower.as_str(), "gz" | "bz2" | "xz" | "zst") {
            leaf = head;
            stripped = true;
        } else {
            break;
        }
    }
    (leaf, stripped)
}

fn strip_datetime_suffix(head: &str) -> Option<&str> {
    for (index, separator) in head.char_indices() {
        if !matches!(separator, '-' | '_') {
            continue;
        }
        let Some(base) = head.get(..index) else {
            continue;
        };
        let base = base.trim_end_matches(['-', '_']);
        let Some(token) = head.get(index + separator.len_utf8()..) else {
            continue;
        };
        if !base.is_empty() && is_datetime_token(token) {
            return Some(base);
        }
    }
    None
}

fn is_rotation_index(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4 && token.chars().all(|c| c.is_ascii_digit())
}

fn is_rotation_pid(token: &str) -> bool {
    !token.is_empty() && token.len() <= 10 && token.chars().all(|c| c.is_ascii_digit())
}

fn is_datetime_token(token: &str) -> bool {
    for date_len in [8usize, 10] {
        if token.len() < date_len || !token.is_char_boundary(date_len) {
            continue;
        }
        let (date, rest) = token.split_at(date_len);
        if !is_date_token(date) {
            continue;
        }
        if rest.is_empty() {
            return true;
        }
        let mut chars = rest.chars();
        if !chars.next().is_some_and(|c| matches!(c, '-' | '_' | '.')) {
            continue;
        }
        if is_time_token(chars.as_str()) {
            return true;
        }
    }
    false
}

/// Whether a token looks like `YYYY-MM-DD` or `YYYYMMDD`.
fn is_date_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    (bytes.len() == 8 && bytes.iter().all(u8::is_ascii_digit))
        || (bytes.len() == 10
            && bytes[4] == bytes[7]
            && matches!(bytes[4], b'-' | b'_')
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()))
}

fn is_time_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    (bytes.len() == 6 && bytes.iter().all(u8::is_ascii_digit))
        || (bytes.len() == 8
            && bytes[2] == bytes[5]
            && matches!(bytes[2], b'-' | b'_')
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit()))
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
        plan_fingerprint: bounded_sample_plan_fingerprint(sample),
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
        plan_fingerprint: String::new(),
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

/// Version of the import-plan binding contract.
///
/// Bumped whenever the token derivation or verification semantics change so
/// a stale client can never present an old-format token as current.
pub const IMPORT_PLAN_VERSION: u32 = 1;

/// Deterministic token binding a reviewed preview to its exact inventory.
///
/// Covers the plan version, preview schema version, source kind, truncation
/// state, and every itemized entry's identity, byte count, status, and role.
/// Any inventory change — content resized, entries added or removed, a
/// classification shift — produces a different token, so a run presenting a
/// stale token fails closed before any staging.
pub fn import_plan_token(report: &ImportPreviewReport) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(IMPORT_PLAN_VERSION.to_le_bytes());
    hasher.update(report.schema_version.to_le_bytes());
    hasher.update(
        serde_json::to_string(&report.source_kind)
            .unwrap_or_default()
            .as_bytes(),
    );
    hasher.update([u8::from(report.truncated)]);
    for item in &report.items {
        hasher.update(item.identity.as_bytes());
        hasher.update([0x1f]);
        hasher.update(item.bytes.to_le_bytes());
        hasher.update(
            serde_json::to_string(&item.status)
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher.update(
            serde_json::to_string(&item.role)
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher.update(item.plan_fingerprint.as_bytes());
        hasher.update([0x1e]);
    }
    let digest = hasher.finalize();
    let mut token = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

/// A reviewed preview plus the plan binding a run to exactly this inventory.
///
/// The transportable wire shape every adapter returns from a preview: the
/// frozen report, the deterministic [`import_plan_token`], and the plan
/// contract version a run must present back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPreviewPlan {
    /// The bounded inventory the user reviews.
    pub report: ImportPreviewReport,
    /// Token binding a run to this exact inventory.
    pub plan_token: String,
    /// Plan contract version ([`IMPORT_PLAN_VERSION`]).
    pub plan_version: u32,
}

/// Preview a path and bind the result into a runnable plan.
pub fn preview_import_plan(
    path: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<ImportPreviewPlan> {
    let report = preview_import_path(path, cancel)?;
    let plan_token = import_plan_token(&report);
    Ok(ImportPreviewPlan {
        report,
        plan_token,
        plan_version: IMPORT_PLAN_VERSION,
    })
}

/// Whether one previewed item may import as log events at all.
///
/// This is the single trusted routing rule shared by every layer: only
/// `role == Log` content with a selectable status becomes events. Supporting
/// material (metrics, attachments, readmes), ignored noise, unsupported
/// content, and blocked entries never do.
pub fn event_importable(item: &ImportPreviewItem) -> bool {
    item.role == ImportItemRole::Log && item.status.is_selectable()
}

/// Re-enumerate a reviewed root and fail closed on any drift before a run.
///
/// Verifies the plan version and token against a fresh bounded preview of
/// `path`, then checks every selected identity still exists and is
/// event-importable. Returns the trusted allowlist the ingest honors.
/// A truncated preview stays importable, but only its itemized identities can
/// ever be selected — unreviewed tail entries are skipped by the allowlist
/// and counted, never silently imported.
pub fn verify_import_plan(
    path: &Path,
    plan_version: u32,
    plan_token: &str,
    selected: &[String],
    cancel: Option<&CancelFlag>,
) -> CoreResult<super::ingest::IngestSelection> {
    if plan_version != IMPORT_PLAN_VERSION {
        return Err(CoreError::Policy(format!(
            "import plan version {plan_version} is not supported by this build (expected {IMPORT_PLAN_VERSION})"
        )));
    }
    if selected.is_empty() {
        return Err(CoreError::Policy(
            "import plan selects nothing that would import as log events".into(),
        ));
    }
    if selected.len() > MAX_IMPORT_PREVIEW_ITEMS {
        return Err(CoreError::Policy(format!(
            "import plan selects {} identities (limit {MAX_IMPORT_PREVIEW_ITEMS})",
            selected.len()
        )));
    }
    let current = preview_import_path(path, cancel)?;
    let current_token = import_plan_token(&current);
    if current_token != plan_token {
        return Err(CoreError::Policy(
            "import plan is stale: the reviewed source state changed on disk since the preview \
             (files were added, removed, replaced, resized, or reclassified) — review the \
             selection again"
                .into(),
        ));
    }
    let by_identity: std::collections::BTreeMap<&str, &ImportPreviewItem> = current
        .items
        .iter()
        .map(|item| (item.identity.as_str(), item))
        .collect();
    let mut allow = std::collections::BTreeSet::new();
    for identity in selected {
        let Some(item) = by_identity.get(identity.as_str()) else {
            return Err(CoreError::Policy(format!(
                "import plan selects an identity the preview does not contain: {identity:?}"
            )));
        };
        if !event_importable(item) {
            return Err(CoreError::Policy(format!(
                "import plan selects {identity:?} which cannot import as log events \
                 (status {:?}, role {:?})",
                item.status, item.role
            )));
        }
        if !allow.insert(identity.clone()) {
            return Err(CoreError::Policy(format!(
                "import plan lists {identity:?} more than once"
            )));
        }
    }
    Ok(super::ingest::IngestSelection::reviewed(
        allow,
        plan_version,
        plan_token.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_of(lines: &[&str]) -> BoundedSample {
        BoundedSample {
            windows: vec![lines.join("\n")],
            binary: false,
            empty: lines.iter().all(|l| l.trim().is_empty()),
            content_fingerprint: String::new(),
        }
    }

    fn windows_of(windows: &[&str]) -> BoundedSample {
        BoundedSample {
            windows: windows.iter().map(|w| (*w).to_string()).collect(),
            binary: false,
            empty: false,
            content_fingerprint: String::new(),
        }
    }

    #[test]
    fn plan_token_binds_inventory_and_fails_closed_on_drift() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "level=info msg=alpha\n").unwrap();
        std::fs::write(logs.join("b.log"), "level=warn msg=beta\n").unwrap();
        let report = preview_import_path(&logs, None).unwrap();
        let token = import_plan_token(&report);
        let selected = vec!["a.log".to_string(), "b.log".to_string()];

        // Happy path: unchanged inventory verifies and returns the allowlist.
        let plan = verify_import_plan(&logs, IMPORT_PLAN_VERSION, &token, &selected, None).unwrap();
        assert_eq!(plan.selected.len(), 2);

        // Unsupported plan version fails closed.
        let err = verify_import_plan(&logs, IMPORT_PLAN_VERSION + 1, &token, &selected, None)
            .unwrap_err();
        assert!(err.to_string().contains("not supported"), "{err}");

        // Same-size, same-format replacement still fails closed: the token is
        // bound to the bounded content evidence, not only file length/status.
        std::fs::write(logs.join("a.log"), "level=warn msg=omega\n").unwrap();
        let err =
            verify_import_plan(&logs, IMPORT_PLAN_VERSION, &token, &selected, None).unwrap_err();
        assert!(err.to_string().contains("stale"), "{err}");
        let same_size_report = preview_import_path(&logs, None).unwrap();
        let same_size_token = import_plan_token(&same_size_report);
        assert_ne!(token, same_size_token);

        // Mutation after preview (content resized) fails closed too.
        std::fs::write(
            logs.join("a.log"),
            "level=info msg=alpha rewritten longer\n",
        )
        .unwrap();
        let err = verify_import_plan(
            &logs,
            IMPORT_PLAN_VERSION,
            &same_size_token,
            &selected,
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("stale"), "{err}");

        // Re-preview after the mutation gives a fresh working token…
        let report2 = preview_import_path(&logs, None).unwrap();
        let token2 = import_plan_token(&report2);
        assert_ne!(token, token2);
        verify_import_plan(&logs, IMPORT_PLAN_VERSION, &token2, &selected, None).unwrap();

        // …and an added unreviewed tail entry breaks that token too.
        std::fs::write(logs.join("c.log"), "level=info msg=tail\n").unwrap();
        let err =
            verify_import_plan(&logs, IMPORT_PLAN_VERSION, &token2, &selected, None).unwrap_err();
        assert!(err.to_string().contains("stale"), "{err}");
    }

    #[test]
    fn verify_import_plan_rejects_role_confusion_unknowns_empty_and_duplicates() {
        // The trusted routing rule itself: manifest-declared supporting
        // material can never import as log events. (Live previews wire the
        // manifest seam in a later slice; the gate is contract-level now.)
        let declared_metrics = item_from_sample(
            "metrics/ops.json",
            256,
            &sample_of(&[r#"{"series":[]}"#]),
            Some(ImportItemRole::OperationalMetrics),
            true,
        );
        assert_eq!(declared_metrics.status, ImportItemStatus::Supporting);
        assert!(!event_importable(&declared_metrics));

        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("app.log"), "level=info msg=alpha\n").unwrap();
        // A binary blob previews as Unsupported with role Unknown — the live
        // path's non-Log rejection case.
        std::fs::write(logs.join("core.dump"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        let report = preview_import_path(&logs, None).unwrap();
        let blob = report
            .items
            .iter()
            .find(|item| item.identity == "core.dump")
            .expect("binary item present");
        assert!(!event_importable(blob));
        let token = import_plan_token(&report);

        // Selecting non-event content fails closed.
        let err = verify_import_plan(
            &logs,
            IMPORT_PLAN_VERSION,
            &token,
            &["app.log".to_string(), "core.dump".to_string()],
            None,
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("cannot import as log events"),
            "{err}"
        );

        // The log source alone verifies.
        let plan = verify_import_plan(
            &logs,
            IMPORT_PLAN_VERSION,
            &token,
            &["app.log".to_string()],
            None,
        )
        .unwrap();
        assert_eq!(plan.selected.len(), 1);

        // Unknown identity fails closed.
        let err = verify_import_plan(
            &logs,
            IMPORT_PLAN_VERSION,
            &token,
            &["ghost.log".to_string()],
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not contain"), "{err}");

        // Empty selection fails closed before any ingest work.
        let err = verify_import_plan(&logs, IMPORT_PLAN_VERSION, &token, &[], None).unwrap_err();
        assert!(err.to_string().contains("selects nothing"), "{err}");

        // Duplicate listing fails closed.
        let err = verify_import_plan(
            &logs,
            IMPORT_PLAN_VERSION,
            &token,
            &["app.log".to_string(), "app.log".to_string()],
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("more than once"), "{err}");
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
    fn plain_text_with_log_or_rotation_name_is_raw_fallback_and_preselected() {
        let sample = sample_of(&["just some prose with no structure at all"]);
        for identity in [
            "service.log",
            "service.log.1",
            "service.log-20260101-120000",
        ] {
            let item = item_from_sample(identity, 64, &sample, None, false);
            assert_eq!(item.status, ImportItemStatus::RawFallback);
            assert!(
                item.selected,
                "raw fallback is honest retained log evidence"
            );
        }
    }

    #[test]
    fn unhinted_text_needs_repeated_structured_event_evidence() {
        let prose = item_from_sample(
            "operator-notes.txt",
            64,
            &sample_of(&["plain prose with no event structure"]),
            None,
            false,
        );
        let one_shot = item_from_sample(
            "probe-output.txt",
            64,
            &sample_of(&["2026-01-01 12:00:00 INFO query completed"]),
            None,
            false,
        );
        let repeated = item_from_sample(
            "event-records.txt",
            128,
            &sample_of(&[
                "2026-01-01 12:00:00 INFO first event",
                "2026-01-01 12:00:01 WARN second event",
            ]),
            None,
            false,
        );

        for item in [&prose, &one_shot] {
            assert_eq!(item.status, ImportItemStatus::Supporting);
            assert_eq!(item.role, ImportItemRole::Attachment);
            assert!(!item.selected);
            assert!(!event_importable(item));
            assert!(item
                .reasons
                .contains(&ImportPreviewReason::InsufficientEventEvidence));
        }
        assert_eq!(repeated.status, ImportItemStatus::Ready);
        assert_eq!(repeated.role, ImportItemRole::Log);
        assert!(repeated.selected);
        assert!(event_importable(&repeated));
    }

    #[test]
    fn duplicate_sampling_windows_do_not_manufacture_repeated_events() {
        let record = "2026-01-01 12:00:00 INFO one sampled event";
        let item = item_from_sample(
            "single-record.txt",
            64,
            &windows_of(&[record, record, record]),
            None,
            false,
        );

        assert_eq!(item.status, ImportItemStatus::Supporting);
        assert!(!item.selected);
        assert!(item
            .reasons
            .contains(&ImportPreviewReason::InsufficientEventEvidence));
    }

    #[test]
    fn html_is_supporting_and_manifest_role_cannot_supply_a_parser() {
        let sample = sample_of(&["<!doctype html><html><body><p>status report</p></body></html>"]);
        for (identity, role, valid) in [
            ("status-page.html", None, false),
            ("status-page.txt", None, false),
            ("declared-page.html", Some(ImportItemRole::Log), true),
        ] {
            let item = item_from_sample(identity, 128, &sample, role, valid);
            assert_eq!(item.status, ImportItemStatus::Supporting);
            assert_eq!(item.role, ImportItemRole::Attachment);
            assert!(!item.selected);
            assert!(!event_importable(&item));
            assert!(item
                .reasons
                .contains(&ImportPreviewReason::HtmlEventParsingUnsupported));
        }
    }

    #[test]
    fn xml_report_and_event_shaped_xml_are_supporting_not_events() {
        let report = item_from_sample(
            "diagnostic-report.xml",
            128,
            &sample_of(&["<report><summary status=\"ok\"/></report>"]),
            None,
            false,
        );
        let event_feed = item_from_sample(
            "structured-feed.xml",
            256,
            &sample_of(&[
                "<events><event level=\"info\">started</event><event level=\"warn\">slow</event></events>",
            ]),
            None,
            false,
        );

        for item in [&report, &event_feed] {
            assert_eq!(item.status, ImportItemStatus::Supporting);
            assert_eq!(item.role, ImportItemRole::Attachment);
            assert!(!item.selected);
            assert!(!event_importable(item));
            assert_eq!(
                item.reasons,
                vec![ImportPreviewReason::XmlEventParsingUnsupported]
            );
        }
    }

    #[test]
    fn xml_shaped_content_cannot_hide_behind_a_text_name() {
        let sample = sample_of(&[
            "\u{feff}<?xml version=\"1.0\"?><settings><enabled>true</enabled></settings>",
        ]);
        let item = item_from_sample("settings-document.txt", 128, &sample, None, false);

        assert_eq!(item.status, ImportItemStatus::Supporting);
        assert_eq!(item.role, ImportItemRole::Attachment);
        assert!(!item.selected);
        assert!(!event_importable(&item));
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
        assert!(item.selected, "reviewable log evidence remains included");
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
    fn validated_manifest_role_cannot_bypass_the_xml_parser_boundary() {
        let sample = sample_of(&["<events><event>started</event></events>"]);
        let item = item_from_sample(
            "declared-feed.xml",
            256,
            &sample,
            Some(ImportItemRole::Log),
            true,
        );

        assert_eq!(item.status, ImportItemStatus::Supporting);
        assert_eq!(item.role, ImportItemRole::Attachment);
        assert!(!item.selected);
        assert!(!event_importable(&item));
        assert_eq!(
            item.reasons,
            vec![
                ImportPreviewReason::ManifestDeclared,
                ImportPreviewReason::XmlEventParsingUnsupported,
            ]
        );
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
    fn preselection_is_exactly_the_event_bearing_log_matrix() {
        let statuses = [
            ImportItemStatus::Ready,
            ImportItemStatus::Review,
            ImportItemStatus::RawFallback,
            ImportItemStatus::Supporting,
            ImportItemStatus::Ignored,
            ImportItemStatus::Unsupported,
            ImportItemStatus::Blocked,
        ];
        let roles = [
            ImportItemRole::Log,
            ImportItemRole::OperationalMetrics,
            ImportItemRole::Attachment,
            ImportItemRole::Readme,
            ImportItemRole::Unknown,
        ];

        for status in statuses {
            for role in roles {
                let expected = role == ImportItemRole::Log
                    && matches!(
                        status,
                        ImportItemStatus::Ready
                            | ImportItemStatus::Review
                            | ImportItemStatus::RawFallback
                    );
                assert_eq!(
                    preselect(status, role),
                    expected,
                    "unexpected preselection for status {status:?}, role {role:?}"
                );
            }
        }
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
        assert_eq!(
            rolled_stem("service.log-20260102-030405").as_deref(),
            Some("service.log")
        );
        assert_eq!(
            rolled_stem("database/service.log-2026-01-02").as_deref(),
            Some("database/service.log")
        );
        assert_eq!(
            rolled_stem("service-2026-01-02_030405.log").as_deref(),
            Some("service.log")
        );
        assert_eq!(
            rolled_stem("worker.4321-2026-01-02_030405.log.1").as_deref(),
            Some("worker.log")
        );
        assert_eq!(
            rolled_stem("service.log.2026-01-02").as_deref(),
            Some("service.log")
        );
        assert_eq!(
            rolled_stem("service.log.7.gz").as_deref(),
            Some("service.log")
        );
        assert!(name_hints_log("service.log-20260102-030405"));
        assert_eq!(rolled_stem("service.log-backup"), None);
        assert!(!name_hints_log("service.log-backup"));
        assert_eq!(rolled_stem("service-2026-01-02_backup.log"), None);
        assert_eq!(rolled_stem("report.1"), None);
        assert_eq!(
            rolled_stem("worker.pid-2026-01-02_030405.log").as_deref(),
            Some("worker.pid.log"),
            "only a decimal pid is stripped"
        );
        assert_eq!(
            rolled_stem("east/service.log.1").as_deref(),
            Some("east/service.log")
        );
        assert_eq!(
            rolled_stem("west/service.log.1").as_deref(),
            Some("west/service.log"),
            "duplicate basenames in different directories keep distinct stems"
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

        let mut timestamped = vec![
            item_from_sample("service.log-20260102-030405", 10, &json, None, false),
            item_from_sample("service.log-20260101-020304", 10, &json, None, false),
        ];
        let groups = build_groups(&mut timestamped);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].member_identities.len(), 2);
        assert!(timestamped.iter().all(|item| item.selected));
    }

    #[test]
    fn rolled_names_with_disagreeing_fingerprints_are_not_grouped() {
        let json = sample_of(&[r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"a"}"#]);
        let syslog = sample_of(&["<34>1 2026-01-01T00:00:00Z host app - - - boot"]);
        let mut items = vec![
            item_from_sample("service.log-2026-01-02", 10, &json, None, false),
            item_from_sample("service.log-2026-01-01", 10, &syslog, None, false),
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
        let mut split_suffix = vec![0x9f, 0xa7, 0xaa];
        assert!(is_binary(&split_suffix));
        split_suffix.extend_from_slice(b" valid text after a split code point");
        assert!(
            !is_binary_window(&split_suffix, false),
            "an interior window may start with the continuation suffix of one UTF-8 code point"
        );
        assert!(is_binary(b"\x00\x01\x02binary"));
        assert!(is_binary(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]));
    }

    #[test]
    fn binary_sniffing_counts_only_actual_invalid_sequences() {
        let mut one_legacy_byte = b"2026-01-01 12:00:00 INFO operator caf".to_vec();
        one_legacy_byte.push(0xe9);
        one_legacy_byte.extend(std::iter::repeat_n(b'x', 13 * 1024));
        assert!(!is_binary(&one_legacy_byte));

        let mut several_legacy_bytes = b"2026-01-01 12:00:01 WARN message ".to_vec();
        for byte in [0x93, 0x96, 0xe9, 0x94] {
            several_legacy_bytes.push(byte);
            several_legacy_bytes.extend_from_slice(b" readable text ");
        }
        assert!(!is_binary(&several_legacy_bytes));
        assert_eq!(invalid_utf8_bytes(&several_legacy_bytes), 4);
    }

    #[test]
    fn binary_sniffing_still_rejects_control_heavy_and_invalid_payloads() {
        let mut controls = Vec::new();
        for _ in 0..128 {
            controls.extend_from_slice(&[0x01, 0x02, 0x03, b'A']);
        }
        assert!(is_binary(&controls));
        assert!(is_binary(&[0xf5; 1024]));
        assert!(is_binary(b"ordinary prefix\0ordinary suffix"));
    }

    #[test]
    fn streaming_utf8_chunk_boundary_matches_seekable_sampling() {
        let prefix = br#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":""#;
        let mut body = prefix.to_vec();
        body.resize(8_191, b'x');
        body.extend_from_slice("🧪".as_bytes());
        body.extend_from_slice(b"\"}\n");
        for index in 0..800 {
            body.extend_from_slice(
                format!(
                    r#"{{"ts":"2026-01-01T00:00:00Z","level":"info","seq":{index},"msg":"generic"}}"#
                )
                .as_bytes(),
            );
            body.push(b'\n');
        }
        assert_eq!(&body[8_191..8_195], "🧪".as_bytes());

        let mut seekable = std::io::Cursor::new(body.clone());
        let bounded = sample_bounded(&mut seekable, body.len() as u64);
        let mut streamed = std::io::Cursor::new(body.clone());
        let SampleOutcome::Sampled(streamed) =
            sample_streaming(&mut streamed, body.len() as u64, None).unwrap()
        else {
            panic!("complete synthetic stream must be sampled");
        };

        assert!(!bounded.binary);
        assert!(!streamed.binary);
        assert_eq!(bounded.windows, streamed.windows);
        let bounded_item =
            item_from_sample("generic.jsonl", body.len() as u64, &bounded, None, false);
        let streamed_item =
            item_from_sample("generic.jsonl", body.len() as u64, &streamed, None, false);
        assert_eq!(bounded_item.status, ImportItemStatus::Ready);
        assert_eq!(streamed_item.status, bounded_item.status);
        assert_eq!(streamed_item.format_id, bounded_item.format_id);
        assert!(streamed_item.selected);
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
        assert_eq!(report.counts.supporting, 1);
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
        // Unhinted prose remains visible but cannot create an empty-looking
        // event corpus from a generic document.
        let supporting = finish_report(
            ImportSourceKind::Directory,
            vec![item_from_sample("a.txt", 4, &text, None, false)],
            false,
            None,
        );
        assert_eq!(supporting.counts.selected, 0);
        assert_eq!(
            supporting.plan_block(),
            Some(ImportPlanBlock::NoImportableSources)
        );
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
        assert!(item.selected, "mixed review evidence remains included");
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
