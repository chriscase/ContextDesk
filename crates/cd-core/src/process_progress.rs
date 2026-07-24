//! Redacted multi-phase progress for long host operations (#442 / #445).
//!
//! Pattern mirrors workspace backup progress: observer callbacks, no secrets,
//! no unredacted home paths. Used by log corpus ingest and session-context import.

use serde::{Deserialize, Serialize};

/// Which long operation is reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProgressKind {
    /// Log analysis corpus ingest (Drain → DuckDB → embed templates).
    LogIngest,
    /// Session context pack file/zip import.
    SessionContextImport,
}

/// Pipeline phase labels (snake_case on the wire for Tauri/UI).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProgressPhase {
    /// Operation about to start.
    Starting,
    /// Discovering files (log ingest).
    Scan,
    /// Parsing lines / formats.
    Parse,
    /// Drain-style templating.
    Template,
    /// Redacting secrets/PII in messages/params.
    Redact,
    /// Writing events/templates to the event store.
    Store,
    /// Embedding templates only.
    Embed,
    /// Reading source bytes (session context).
    Read,
    /// Cap / policy validation.
    Validate,
    /// Zip extract (session context).
    Extract,
    /// Writing into session context root.
    Write,
    /// Successful terminal state.
    Completed,
    /// Failed terminal state.
    Failed,
    /// User/host cancelled before durable completion.
    Cancelled,
}

impl ProcessProgressPhase {
    /// Stable UI label for pipeline chrome.
    pub fn label(self) -> &'static str {
        match self {
            Self::Starting => "Starting",
            Self::Scan => "Scan",
            Self::Parse => "Parse",
            Self::Template => "Template",
            Self::Redact => "Redact",
            Self::Store => "Store",
            Self::Embed => "Embed",
            Self::Read => "Read",
            Self::Validate => "Validate",
            Self::Extract => "Extract",
            Self::Write => "Write",
            Self::Completed => "Completed",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

/// Redacted progress update safe for IPC and UI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProcessProgress {
    /// Operation kind.
    pub kind: ProcessProgressKind,
    /// Current phase.
    pub phase: ProcessProgressPhase,
    /// Short human message (no secrets / no full paths).
    pub message: String,
    /// Optional 0.0..=1.0 completion fraction.
    pub fraction: Option<f32>,
    /// Lines processed (log ingest).
    pub lines_processed: Option<u64>,
    /// Files processed.
    pub files_processed: Option<u64>,
    /// Bytes processed.
    pub bytes_processed: Option<u64>,
    /// Distinct templates so far (log ingest).
    pub templates: Option<u64>,
    /// Whether the host can still cancel cleanly.
    pub cancellable: bool,
}

impl ProcessProgress {
    /// Builder helper for a phase update.
    pub fn phase(
        kind: ProcessProgressKind,
        phase: ProcessProgressPhase,
        message: impl Into<String>,
        cancellable: bool,
    ) -> Self {
        Self {
            kind,
            phase,
            message: message.into(),
            fraction: None,
            lines_processed: None,
            files_processed: None,
            bytes_processed: None,
            templates: None,
            cancellable,
        }
    }

    /// Set fraction clamped to 0..=1.
    pub fn with_fraction(mut self, fraction: f32) -> Self {
        self.fraction = Some(fraction.clamp(0.0, 1.0));
        self
    }

    /// Attach line count.
    pub fn with_lines(mut self, lines: u64) -> Self {
        self.lines_processed = Some(lines);
        self
    }

    /// Attach file count.
    pub fn with_files(mut self, files: u64) -> Self {
        self.files_processed = Some(files);
        self
    }

    /// Attach byte count.
    pub fn with_bytes(mut self, bytes: u64) -> Self {
        self.bytes_processed = Some(bytes);
        self
    }

    /// Attach template count.
    pub fn with_templates(mut self, templates: u64) -> Self {
        self.templates = Some(templates);
        self
    }
}

/// Observer for redacted progress (core-testable without Tauri).
pub trait ProcessProgressObserver: Send + Sync {
    /// Receive one progress update.
    fn progress(&self, update: ProcessProgress);
}

/// No-op observer.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopProcessProgress;

impl ProcessProgressObserver for NoopProcessProgress {
    fn progress(&self, _update: ProcessProgress) {}
}

/// Recording observer for tests.
#[derive(Default)]
pub struct RecordingProcessProgress {
    /// Captured updates in order.
    pub updates: std::sync::Mutex<Vec<ProcessProgress>>,
}

impl ProcessProgressObserver for RecordingProcessProgress {
    fn progress(&self, update: ProcessProgress) {
        self.updates.lock().expect("lock").push(update);
    }
}

impl RecordingProcessProgress {
    /// Snapshot of recorded phases.
    pub fn phases(&self) -> Vec<ProcessProgressPhase> {
        self.updates
            .lock()
            .expect("lock")
            .iter()
            .map(|u| u.phase)
            .collect()
    }
}

/// Optional cancel token for long ops. Checked between units of work.
#[derive(Clone, Debug, Default)]
pub struct CancelFlag {
    inner: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl CancelFlag {
    /// Fresh flag (not cancelled).
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancel.
    pub fn cancel(&self) {
        self.inner.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether cancel was requested.
    pub fn is_cancelled(&self) -> bool {
        self.inner.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Basename-only display for progress messages (never full home paths).
pub fn progress_basename(path: &std::path::Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "item".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_json_is_snake_case_and_path_free() {
        let p = ProcessProgress::phase(
            ProcessProgressKind::LogIngest,
            ProcessProgressPhase::Template,
            "templating lines",
            true,
        )
        .with_fraction(0.4)
        .with_lines(100);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "log_ingest");
        assert_eq!(v["phase"], "template");
        assert!(v.get("path").is_none());
        assert_eq!(v["cancellable"], true);
    }

    #[test]
    fn basename_never_leaks_parent() {
        let p = std::path::Path::new("/Users/secret-user/incidents/app.log");
        assert_eq!(progress_basename(p), "app.log");
    }

    #[test]
    fn cancel_flag_toggles() {
        let f = CancelFlag::new();
        assert!(!f.is_cancelled());
        f.cancel();
        assert!(f.is_cancelled());
    }
}
