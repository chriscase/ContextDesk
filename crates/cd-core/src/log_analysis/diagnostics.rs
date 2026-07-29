//! Bounded, payload-free diagnostics for failed log-ingest attempts.
//!
//! A failed ingest cannot publish a corpus merely to make troubleshooting data
//! available. This module therefore records typed progress/evidence counters, a
//! stable failure classification, and a capped transcript of core-sanitized
//! final basenames. It never retains parent paths, archive ancestry, progress
//! messages, error strings, or log records.

use crate::process_progress::{
    LogIngestEvidence, LogIngestEvidenceReason, ProcessProgress, ProcessProgressKind,
    ProcessProgressObserver, ProcessProgressPhase,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Schema version for the transient failed-ingest diagnostic DTO.
pub const FAILED_INGEST_DIAGNOSTIC_SCHEMA_VERSION: u32 = 2;

/// Maximum basename/reason observations retained for one failed attempt.
pub const MAX_FAILED_INGEST_EVIDENCE_ENTRIES: usize = 20;

/// Coarse source kind retained without keeping the selected source path.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailedIngestSourceKind {
    /// A directory was selected.
    Directory,
    /// A ZIP archive was selected.
    Zip,
    /// One non-ZIP file was selected.
    File,
    /// The host could not determine the source kind safely.
    Unknown,
}

impl FailedIngestSourceKind {
    /// Classify a selected path without retaining any path component.
    pub fn from_path(path: &Path) -> Self {
        if path.is_dir() {
            return Self::Directory;
        }
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            return Self::Zip;
        }
        if path.is_file() {
            return Self::File;
        }
        Self::Unknown
    }
}

/// Stable, privacy-safe reason for a failed ingest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailedIngestReason {
    /// The user or host requested cancellation before publication.
    Cancelled,
    /// No candidate file entries were discovered.
    NoImportableFiles,
    /// Candidates existed, but none produced a safe event.
    NoSafeEvents,
    /// The selected archive was malformed or unreadable as a ZIP.
    InvalidArchive,
    /// Archive or source structure violated an ingest policy.
    PolicyRejected,
    /// Metadata for the selected source could not be read safely.
    SourceMetadataFailed,
    /// The selected source could not be opened.
    SourceOpenFailed,
    /// A bounded source read failed.
    SourceReadFailed,
    /// The selected source changed while it was being ingested.
    SourceChanged,
    /// The blocking ingest worker itself failed.
    WorkerFailed,
    /// The failure did not match a more specific stable class.
    IngestFailed,
}

impl FailedIngestReason {
    /// User-facing summary that does not interpolate the original error.
    pub fn summary(self) -> &'static str {
        match self {
            Self::Cancelled => "Import cancelled before a corpus was published.",
            Self::NoImportableFiles => {
                "No importable log files were discovered; no corpus was published."
            }
            Self::NoSafeEvents => "No safe log events were found; no corpus was published.",
            Self::InvalidArchive => {
                "The selected archive could not be validated; no corpus was published."
            }
            Self::PolicyRejected => {
                "The selected source was rejected by ingest safety policy; no corpus was published."
            }
            Self::SourceMetadataFailed => {
                "Source metadata could not be read; no corpus was published."
            }
            Self::SourceOpenFailed => {
                "The selected source could not be opened; no corpus was published."
            }
            Self::SourceReadFailed => {
                "The selected source could not be read safely; no corpus was published."
            }
            Self::SourceChanged => {
                "The selected source changed during import; no corpus was published."
            }
            Self::WorkerFailed => {
                "The local ingest worker stopped unexpectedly; no corpus was published."
            }
            Self::IngestFailed => "Import failed before a corpus was published.",
        }
    }
}

/// Last bounded progress counters observed before ingest stopped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedIngestProgress {
    /// Last typed pipeline phase observed.
    pub last_phase: ProcessProgressPhase,
    /// Maximum line counter emitted by the ingest pipeline.
    pub lines_processed: Option<u64>,
    /// Maximum file counter emitted by the ingest pipeline.
    pub files_processed: Option<u64>,
    /// Maximum byte counter emitted by the ingest pipeline.
    pub bytes_processed: Option<u64>,
    /// Maximum template counter emitted by the ingest pipeline.
    pub templates: Option<u64>,
    /// Saturating count of progress updates, useful for host-flow diagnosis.
    pub updates_seen: u16,
}

impl Default for FailedIngestProgress {
    fn default() -> Self {
        Self {
            last_phase: ProcessProgressPhase::Starting,
            lines_processed: None,
            files_processed: None,
            bytes_processed: None,
            templates: None,
            updates_seen: 0,
        }
    }
}

/// Separate typed scan counters for the literal failed-ingest evidence contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedIngestScanCounts {
    /// NUL-bearing sources classified as binary.
    pub binary: u64,
    /// Completely read sources with no non-blank events.
    pub empty: u64,
    /// Hidden files or archive members ignored by policy.
    pub hidden: u64,
    /// Sources excluded by the member-size cap.
    pub oversized: u64,
    /// Metadata, open, or bounded source read failures.
    pub read_failed: u64,
    /// Source-line or archive parse failures.
    pub parse_failed: u64,
}

impl FailedIngestScanCounts {
    fn record(&mut self, reason: LogIngestEvidenceReason) {
        let counter = match reason {
            LogIngestEvidenceReason::Binary => &mut self.binary,
            LogIngestEvidenceReason::Empty => &mut self.empty,
            LogIngestEvidenceReason::Hidden => &mut self.hidden,
            LogIngestEvidenceReason::Oversized => &mut self.oversized,
            LogIngestEvidenceReason::ReadFailed => &mut self.read_failed,
            LogIngestEvidenceReason::ParseFailed => &mut self.parse_failed,
        };
        *counter = counter.saturating_add(1);
    }
}

/// Bounded, typed omission/failure evidence retained only for a failed attempt.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedIngestEvidenceSummary {
    /// Complete counters, even when the transcript example cap is reached.
    pub scan_counts: FailedIngestScanCounts,
    /// First bounded basename/reason observations in deterministic ingest order.
    pub transcript: Vec<LogIngestEvidence>,
    /// Number of additional observations omitted after the transcript cap.
    pub omitted_entries: u64,
}

impl FailedIngestEvidenceSummary {
    fn record(&mut self, evidence: LogIngestEvidence) {
        self.scan_counts.record(evidence.reason);
        if self.transcript.len() < MAX_FAILED_INGEST_EVIDENCE_ENTRIES {
            self.transcript.push(evidence);
        } else {
            self.omitted_entries = self.omitted_entries.saturating_add(1);
        }
    }
}

/// One in-memory failed-ingest diagnostic safe to send to the trusted UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedIngestDiagnostic {
    /// DTO schema version.
    pub schema_version: u32,
    /// Unix seconds when the host finalized the failed attempt.
    pub generated_at: i64,
    /// Coarse source kind; the source path is never retained.
    pub source_kind: FailedIngestSourceKind,
    /// Stable failure class; the original error text is never retained.
    pub reason_code: FailedIngestReason,
    /// Safe summary derived only from [`Self::reason_code`].
    pub summary: String,
    /// Whether the terminal condition was cancellation.
    pub cancelled: bool,
    /// Bounded typed progress counters.
    pub progress: FailedIngestProgress,
    /// Bounded scan counters and basename/reason examples from typed callbacks.
    pub evidence: FailedIngestEvidenceSummary,
    /// Confirms that only the allowlisted typed fields are present.
    pub redacted: bool,
}

/// Progress observer that intentionally discards every free-form message.
#[derive(Debug, Default)]
pub struct FailedIngestDiagnosticRecorder {
    progress: Mutex<FailedIngestProgress>,
    evidence: Mutex<FailedIngestEvidenceSummary>,
}

impl FailedIngestDiagnosticRecorder {
    /// Build one finalized diagnostic from an internal error classification.
    ///
    /// The supplied error is inspected but never copied into the returned DTO.
    pub fn finish(
        &self,
        error: &str,
        source_kind: FailedIngestSourceKind,
        generated_at: i64,
    ) -> FailedIngestDiagnostic {
        let reason_code = classify_failed_ingest(error);
        let mut progress = self
            .progress
            .lock()
            .expect("failed ingest progress")
            .clone();
        if reason_code == FailedIngestReason::Cancelled {
            progress.last_phase = ProcessProgressPhase::Cancelled;
        }
        FailedIngestDiagnostic {
            schema_version: FAILED_INGEST_DIAGNOSTIC_SCHEMA_VERSION,
            generated_at,
            source_kind,
            reason_code,
            summary: reason_code.summary().into(),
            cancelled: reason_code == FailedIngestReason::Cancelled,
            progress,
            evidence: self
                .evidence
                .lock()
                .expect("failed ingest evidence")
                .clone(),
            redacted: true,
        }
    }
}

impl ProcessProgressObserver for FailedIngestDiagnosticRecorder {
    fn progress(&self, update: ProcessProgress) {
        if update.kind != ProcessProgressKind::LogIngest {
            return;
        }
        let mut progress = self.progress.lock().expect("failed ingest progress");
        progress.last_phase = update.phase;
        progress.lines_processed = max_optional(progress.lines_processed, update.lines_processed);
        progress.files_processed = max_optional(progress.files_processed, update.files_processed);
        progress.bytes_processed = max_optional(progress.bytes_processed, update.bytes_processed);
        progress.templates = max_optional(progress.templates, update.templates);
        progress.updates_seen = progress.updates_seen.saturating_add(1);
    }

    fn log_ingest_evidence(&self, evidence: LogIngestEvidence) {
        self.evidence
            .lock()
            .expect("failed ingest evidence")
            .record(evidence);
    }
}

fn max_optional(current: Option<u64>, next: Option<u64>) -> Option<u64> {
    match (current, next) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Classify an internal ingest error into a stable payload-free reason.
pub fn classify_failed_ingest(error: &str) -> FailedIngestReason {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("cancel") {
        FailedIngestReason::Cancelled
    } else if normalized.contains("no importable log file") {
        FailedIngestReason::NoImportableFiles
    } else if normalized.contains("no safe/importable log event") {
        FailedIngestReason::NoSafeEvents
    } else if normalized.contains("ingest task join") {
        FailedIngestReason::WorkerFailed
    } else if normalized.contains("changed after")
        || normalized.contains("changed during")
        || normalized.contains("source identity changed")
    {
        FailedIngestReason::SourceChanged
    } else if normalized.contains("read source metadata")
        || normalized.contains("opened source metadata")
    {
        FailedIngestReason::SourceMetadataFailed
    } else if normalized.contains("open source") {
        FailedIngestReason::SourceOpenFailed
    } else if normalized.contains("read failed") || normalized.contains("source read") {
        FailedIngestReason::SourceReadFailed
    } else if (normalized.contains("zip") || normalized.contains("archive"))
        && (normalized.contains("open")
            || normalized.contains("invalid")
            || normalized.contains("missing end")
            || normalized.contains("truncated"))
    {
        FailedIngestReason::InvalidArchive
    } else if normalized.contains("policy")
        || normalized.contains("rejected")
        || normalized.contains("exceeds")
        || normalized.contains("too large")
        || normalized.contains("encrypted")
    {
        FailedIngestReason::PolicyRejected
    } else {
        FailedIngestReason::IngestFailed
    }
}

/// One-slot lifecycle store for transient failed-ingest diagnostics.
///
/// Starting any later attempt clears the previous value. A stale overlapping
/// attempt cannot overwrite the newer attempt's slot.
#[derive(Debug, Default)]
pub struct FailedIngestDiagnosticStore {
    attempt: u64,
    current: Option<FailedIngestDiagnostic>,
}

impl FailedIngestDiagnosticStore {
    /// Begin a new attempt, clearing the previous transient diagnostic.
    pub fn begin_attempt(&mut self) -> u64 {
        self.attempt = self.attempt.wrapping_add(1);
        if self.attempt == 0 {
            self.attempt = 1;
        }
        self.current = None;
        self.attempt
    }

    /// Publish a failure only if it belongs to the newest attempt.
    pub fn record_failure(&mut self, attempt: u64, diagnostic: FailedIngestDiagnostic) -> bool {
        if attempt != self.attempt {
            return false;
        }
        self.current = Some(diagnostic);
        true
    }

    /// Mark the newest attempt successful and keep the transient slot empty.
    pub fn record_success(&mut self, attempt: u64) -> bool {
        if attempt != self.attempt {
            return false;
        }
        self.current = None;
        true
    }

    /// Clone the current transient diagnostic for trusted UI preview.
    pub fn snapshot(&self) -> Option<FailedIngestDiagnostic> {
        self.current.clone()
    }

    /// Explicitly clear the current transient diagnostic.
    pub fn clear(&mut self) -> bool {
        self.current.take().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(reason: &str, generated_at: i64) -> FailedIngestDiagnostic {
        FailedIngestDiagnosticRecorder::default().finish(
            reason,
            FailedIngestSourceKind::Directory,
            generated_at,
        )
    }

    #[test]
    fn recorder_keeps_only_typed_maxima_and_never_free_form_messages() {
        let recorder = FailedIngestDiagnosticRecorder::default();
        recorder.progress(
            ProcessProgress::phase(
                ProcessProgressKind::LogIngest,
                ProcessProgressPhase::Scan,
                "opening /Users/private/secret.log Bearer forbidden-token",
                true,
            )
            .with_files(8)
            .with_bytes(4_096),
        );
        recorder.progress(
            ProcessProgress::phase(
                ProcessProgressKind::LogIngest,
                ProcessProgressPhase::Parse,
                "payload=customer-private-value",
                true,
            )
            .with_files(3)
            .with_lines(120)
            .with_templates(7),
        );
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::ReadFailed,
            Path::new("/Users/private/secret.log"),
        ));

        let diagnostic = recorder.finish(
            "read failed at /Users/private/secret.log",
            FailedIngestSourceKind::Directory,
            123,
        );
        assert_eq!(diagnostic.reason_code, FailedIngestReason::SourceReadFailed);
        assert_eq!(diagnostic.progress.files_processed, Some(8));
        assert_eq!(diagnostic.progress.lines_processed, Some(120));
        assert_eq!(diagnostic.progress.bytes_processed, Some(4_096));
        assert_eq!(diagnostic.progress.templates, Some(7));
        assert_eq!(diagnostic.evidence.scan_counts.read_failed, 1);
        assert_eq!(diagnostic.evidence.transcript[0].basename, "secret.log");
        let serialized = serde_json::to_string(&diagnostic).expect("serialize");
        for forbidden in [
            "/Users/",
            "forbidden-token",
            "customer-private-value",
            "read failed",
        ] {
            assert!(!serialized.contains(forbidden), "{serialized}");
        }
        assert!(serialized.len() < 2_048, "{serialized}");
    }

    #[test]
    fn evidence_counters_remain_complete_when_transcript_is_bounded() {
        let recorder = FailedIngestDiagnosticRecorder::default();
        for index in 0..(MAX_FAILED_INGEST_EVIDENCE_ENTRIES + 7) {
            recorder.log_ingest_evidence(LogIngestEvidence::from_source(
                LogIngestEvidenceReason::Binary,
                Path::new(&format!("binary-{index}.log")),
            ));
        }
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::Empty,
            Path::new("empty.log"),
        ));
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::Hidden,
            Path::new(".hidden.log"),
        ));
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::Oversized,
            Path::new("large.log"),
        ));
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::ReadFailed,
            Path::new("unreadable.log"),
        ));
        recorder.log_ingest_evidence(LogIngestEvidence::from_source(
            LogIngestEvidenceReason::ParseFailed,
            Path::new("malformed.log"),
        ));

        let diagnostic = recorder.finish(
            "no safe/importable log events were found",
            FailedIngestSourceKind::Directory,
            123,
        );
        assert_eq!(
            diagnostic.evidence.transcript.len(),
            MAX_FAILED_INGEST_EVIDENCE_ENTRIES
        );
        assert_eq!(diagnostic.evidence.scan_counts.binary, 27);
        assert_eq!(diagnostic.evidence.scan_counts.empty, 1);
        assert_eq!(diagnostic.evidence.scan_counts.hidden, 1);
        assert_eq!(diagnostic.evidence.scan_counts.oversized, 1);
        assert_eq!(diagnostic.evidence.scan_counts.read_failed, 1);
        assert_eq!(diagnostic.evidence.scan_counts.parse_failed, 1);
        assert_eq!(diagnostic.evidence.omitted_entries, 12);
    }

    #[test]
    fn classifies_cancel_zero_safe_archive_policy_and_worker_failures() {
        assert_eq!(
            classify_failed_ingest("ingest cancelled during parse"),
            FailedIngestReason::Cancelled
        );
        assert_eq!(
            classify_failed_ingest("no importable log file entries discovered"),
            FailedIngestReason::NoImportableFiles
        );
        assert_eq!(
            classify_failed_ingest("no safe/importable log events were found"),
            FailedIngestReason::NoSafeEvents
        );
        assert_eq!(
            classify_failed_ingest("zip open: missing end record"),
            FailedIngestReason::InvalidArchive
        );
        assert_eq!(
            classify_failed_ingest("encrypted raw log zip entries are not supported"),
            FailedIngestReason::PolicyRejected
        );
        assert_eq!(
            classify_failed_ingest("ingest task join: worker panic"),
            FailedIngestReason::WorkerFailed
        );
    }

    #[test]
    fn source_kind_never_serializes_a_private_path() {
        let private = Path::new("/Users/employee/private.internal/incident.zip");
        let diagnostic = FailedIngestDiagnosticRecorder::default().finish(
            "zip open: invalid archive",
            FailedIngestSourceKind::from_path(private),
            123,
        );
        let serialized = serde_json::to_string(&diagnostic).expect("serialize");
        assert_eq!(diagnostic.source_kind, FailedIngestSourceKind::Zip);
        assert!(!serialized.contains("/Users/"), "{serialized}");
        assert!(!serialized.contains("private.internal"), "{serialized}");
        assert!(!serialized.contains("incident.zip"), "{serialized}");
    }

    #[test]
    fn transient_store_replaces_clears_and_rejects_stale_attempts() {
        let mut store = FailedIngestDiagnosticStore::default();
        let first = store.begin_attempt();
        assert!(store.record_failure(first, failed("no safe/importable log events", 1)));
        assert_eq!(store.snapshot().map(|value| value.generated_at), Some(1));

        let second = store.begin_attempt();
        assert!(
            store.snapshot().is_none(),
            "new attempt must clear prior failure"
        );
        assert!(
            !store.record_failure(first, failed("ingest cancelled", 2)),
            "older attempt must not overwrite the newer slot"
        );
        assert!(store.snapshot().is_none());
        assert!(store.record_failure(second, failed("zip open: invalid", 3)));
        assert_eq!(store.snapshot().map(|value| value.generated_at), Some(3));
        assert!(store.clear());
        assert!(!store.clear());

        let third = store.begin_attempt();
        assert!(store.record_failure(third, failed("unknown failure", 4)));
        assert!(store.record_success(third));
        assert!(store.snapshot().is_none());
    }
}
