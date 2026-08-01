//! Host-owned investigation report export (#532).
//!
//! Mirrors the #819 diagnostics gold pattern exactly: the host re-assembles
//! and renders the report itself (the renderer never supplies export text),
//! retains the exact preview bytes under an opaque process-local id in a
//! bounded store, and later writes those same bytes through the shared
//! host-selected, atomic, no-clobber publication machinery. Preview bytes and
//! saved bytes are always identical.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Bounded size of one rendered investigation report export.
///
/// A dedicated bound (not the 64 KiB diagnostics constant): reports carry
/// authored sections and a bounded identity timeline, so they are larger than
/// a diagnostics manifest while still refusing pathological growth.
pub const MAX_INVESTIGATION_REPORT_BYTES: usize = 512 * 1024;
const MAX_REPORTS: usize = 8;
static REPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInvestigationReportExport {
    pub report_id: String,
    pub markdown: String,
    pub bytes: usize,
}

#[derive(Clone, Debug)]
struct StoredReport {
    id: String,
    markdown: String,
}

/// Bounded host-rendered report previews keyed by opaque, process-local ids.
#[derive(Default)]
pub struct InvestigationReportExportStore {
    reports: VecDeque<StoredReport>,
}

impl InvestigationReportExportStore {
    /// Retain one host-rendered markdown report and hand back its opaque id.
    ///
    /// Fails closed — retaining nothing — when the render is empty, exceeds
    /// the export bound, or is not already a secret-scrub fixed point.
    pub fn prepare(
        &mut self,
        markdown: String,
    ) -> Result<PreparedInvestigationReportExport, String> {
        validate_report_content(&markdown)?;
        let id = next_report_id();
        let bytes = markdown.len();
        self.reports.push_back(StoredReport {
            id: id.clone(),
            markdown: markdown.clone(),
        });
        while self.reports.len() > MAX_REPORTS {
            self.reports.pop_front();
        }
        Ok(PreparedInvestigationReportExport {
            report_id: id,
            markdown,
            bytes,
        })
    }

    /// Exact stored preview bytes for one report id.
    pub fn content(&self, report_id: &str) -> Result<&str, String> {
        validate_report_id(report_id)?;
        self.reports
            .iter()
            .find(|report| report.id == report_id)
            .map(|report| report.markdown.as_str())
            .ok_or_else(|| {
                "investigation report preview expired; refresh the preview and try again"
                    .to_string()
            })
    }

    /// Release one preview. Unknown/expired ids are harmless; malformed ids
    /// fail closed.
    pub fn release(&mut self, report_id: &str) -> Result<bool, String> {
        validate_report_id(report_id)?;
        let Some(index) = self
            .reports
            .iter()
            .position(|report| report.id == report_id)
        else {
            return Ok(false);
        };
        self.reports.remove(index);
        Ok(true)
    }
}

/// Host boundary validation for one report artefact, applied both at prepare
/// and again immediately before publication (defense in depth, fail closed).
fn validate_report_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("investigation report render produced no content".into());
    }
    if content.len() > MAX_INVESTIGATION_REPORT_BYTES {
        return Err(format!(
            "investigation report exceeds {MAX_INVESTIGATION_REPORT_BYTES} bytes"
        ));
    }
    // The trusted core renders already-redacted canonical text and finishes
    // with a secret scrub, so scrubbing again must change nothing. Anything
    // else means unreviewed content reached the export boundary — refuse it
    // rather than silently rewriting the preview the user approved.
    if cd_core::redact::scrub_secrets(content) != content {
        return Err(
            "investigation report failed host privacy validation; nothing was written".into(),
        );
    }
    Ok(())
}

/// Atomically publish one prepared report at a host-selected `.md` path.
///
/// Re-validates the exact stored bytes, then reuses the shared diagnostics
/// publication machinery (temp + no-clobber rename, symlink refusal).
pub fn save_investigation_report_at_host_path(
    path: &Path,
    content: &str,
) -> Result<super::log_diagnostics::DiagnosticPublishOutcome, String> {
    validate_report_content(content)?;
    // The shared machinery names its artifact family "diagnostic" in failure
    // strings; a report save must name its own family so the user is never
    // told a different artifact failed.
    super::log_diagnostics::publish_reviewed_markdown_at_host_path(path, content)
        .map_err(|error| error.replace("diagnostic", "investigation report"))
}

fn next_report_id() -> String {
    let sequence = REPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    format!("cdinvreport-{now:016x}-{sequence:016x}")
}

fn validate_report_id(value: &str) -> Result<(), String> {
    let mut parts = value.split('-');
    let valid = parts.next() == Some("cdinvreport")
        && parts.next().is_some_and(is_hex16)
        && parts.next().is_some_and(is_hex16)
        && parts.next().is_none();
    if !valid {
        return Err("invalid investigation report id".into());
    }
    Ok(())
}

fn is_hex16(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAFE_REPORT: &str = "# Investigation report: checkout-cascade\n\n\
## Incident scope & window\n\n- Evidence items: 1\n";

    #[test]
    fn prepare_returns_exact_stored_bytes_and_reported_size() {
        let mut store = InvestigationReportExportStore::default();
        let prepared = store.prepare(SAFE_REPORT.to_string()).expect("prepare");
        assert_eq!(prepared.bytes, SAFE_REPORT.len());
        assert_eq!(prepared.markdown, SAFE_REPORT);
        assert_eq!(
            store.content(&prepared.report_id).expect("stored bytes"),
            prepared.markdown
        );
    }

    #[test]
    fn prepare_fails_closed_on_empty_oversized_or_unscrubbed_content() {
        let mut store = InvestigationReportExportStore::default();
        assert!(store.prepare(String::new()).is_err());
        let oversized = "x".repeat(MAX_INVESTIGATION_REPORT_BYTES + 1);
        assert!(store
            .prepare(oversized)
            .expect_err("oversized")
            .contains("exceeds"));
        // Assemble the test value at runtime so source-control secret scanners
        // do not mistake this deliberate negative-path fixture for a leaked key.
        let provider_key = ["sk", "-", "abcdefghijklmnopqrstuvwxyz123456"].concat();
        let leaking = format!("{SAFE_REPORT}\n- token: {provider_key}\n");
        let error = store.prepare(leaking).expect_err("secret must fail closed");
        assert!(error.contains("privacy validation"), "{error}");
        assert!(
            store.reports.is_empty(),
            "failed prepare must retain nothing"
        );
    }

    #[test]
    fn report_ids_are_strict_and_store_is_bounded_with_idempotent_release() {
        let mut store = InvestigationReportExportStore::default();
        let first = store.prepare(SAFE_REPORT.to_string()).expect("first");
        for _ in 0..MAX_REPORTS {
            store.prepare(SAFE_REPORT.to_string()).expect("next");
        }
        assert!(
            store.content(&first.report_id).is_err(),
            "LRU evicts oldest"
        );
        for invalid in [
            "cdlogdiag-0000000000000000-0000000000000000",
            "cdinvreport-short-0000000000000000",
            "cdinvreport-0000000000000000-0000000000000000-extra",
            "arbitrary",
        ] {
            assert!(store.content(invalid).is_err(), "{invalid}");
            assert!(store.release(invalid).is_err(), "{invalid}");
        }
        let latest = store.prepare(SAFE_REPORT.to_string()).expect("latest");
        assert!(store.release(&latest.report_id).expect("release"));
        assert!(!store
            .release(&latest.report_id)
            .expect("release is idempotent"));
    }

    #[test]
    fn save_reuses_shared_atomic_machinery_and_re_checks_the_boundary() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("report.md");
        save_investigation_report_at_host_path(&destination, SAFE_REPORT).expect("save");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read"),
            SAFE_REPORT
        );

        // Boundary re-check fails closed without touching the destination.
        let leaking = format!("{SAFE_REPORT}Bearer secret-token-value\n");
        let error = save_investigation_report_at_host_path(&destination, &leaking)
            .expect_err("unscrubbed content refused");
        assert!(error.contains("privacy validation"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read unchanged"),
            SAFE_REPORT
        );

        // Wrong extension is refused by the shared destination validation.
        let error =
            save_investigation_report_at_host_path(&root.path().join("report.txt"), SAFE_REPORT)
                .expect_err("wrong extension");
        assert!(error.contains(".md"), "{error}");

        // No temp siblings survive.
        let leftovers = std::fs::read_dir(root.path())
            .expect("read temp root")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".contextdesk-diagnostic-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn save_failures_name_the_report_family_not_diagnostics() {
        let root = tempfile::tempdir().expect("temp root");
        let missing_parent = root.path().join("no-such-dir").join("report.md");
        let error = save_investigation_report_at_host_path(&missing_parent, SAFE_REPORT)
            .expect_err("missing parent must fail");
        assert!(error.contains("investigation report"), "{error}");
        assert!(!error.contains("diagnostic"), "{error}");
    }

    #[test]
    fn oversize_bound_is_wider_than_diagnostics_but_still_finite() {
        assert_eq!(MAX_INVESTIGATION_REPORT_BYTES, 512 * 1024);
        const {
            assert!(
                MAX_INVESTIGATION_REPORT_BYTES
                    > super::super::log_diagnostics::MAX_DIAGNOSTIC_BYTES
            );
        }
    }
}
