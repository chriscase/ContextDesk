//! Aggregate-only export of a real desktop import; never reruns the importer.
//! Do not serialize raw host DTOs: member locators, raw timestamps, templates,
//! tokens, and user-defined format identifiers are intentionally not fields.
use super::{
    diagnostics::{FailedIngestProgress, FailedIngestSourceKind},
    format_profile::BUILT_IN_FORMAT_PROFILES,
    import_diagnose::{
        reason_key, role_key, status_key, unresolved_key, ImportDiagnosticDiscrepancy,
    },
    import_outcome::{ImportOutcomeClass, ImportOutcomeCounts, ImportOutcomeReport},
    import_preview::{ImportPlanBlock, ImportPreviewPlan},
    ingest::{IngestPhaseTimings, IngestReport},
    ingest_confidence::IngestConfidenceCounts,
};
use crate::process_progress::ProcessProgressPhase;
use serde::Serialize;
use std::collections::BTreeMap;

type Histogram = BTreeMap<&'static str, u64>;
fn add(h: &mut Histogram, key: &'static str, n: u64) {
    let value = h.entry(key).or_default();
    *value = value.saturating_add(n);
}
fn bounded(input: &BTreeMap<String, u64>, allowed: &[&'static str]) -> Histogram {
    let mut result = Histogram::new();
    for (key, n) in input {
        add(
            &mut result,
            allowed
                .iter()
                .copied()
                .find(|k| *k == key)
                .unwrap_or("other"),
            *n,
        );
    }
    result
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    entries: u64,
    observed_declared_bytes: u64,
    inventory_truncated: bool,
    plan_block: Option<ImportPlanBlock>,
    status: Histogram,
    role: Histogram,
    reason: Histogram,
    built_in_format: Histogram,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ingest {
    source_bytes: u64,
    templates: usize,
    parser_format: Histogram,
    timestamp_provenance: Histogram,
    timestamp_basis: Histogram,
    source_confidence: IngestConfidenceCounts,
    unresolved_time_reasons: Histogram,
    phase_timings: IngestPhaseTimings,
}
/// Public, serialize-only projection. No arbitrary renderer strings are accepted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttemptDiagnostic {
    schema_id: &'static str,
    schema_version: u8,
    product_version: &'static str,
    privacy_policy: &'static str,
    source_kind: FailedIngestSourceKind,
    status: &'static str,
    preview: Option<Preview>,
    verified_selected_sources: Option<u64>,
    outcome_counts: Option<ImportOutcomeCounts>,
    defect_codes: Histogram,
    ingest: Option<Ingest>,
    progress: Option<FailedIngestProgress>,
    discrepancies: Vec<ImportDiagnosticDiscrepancy>,
}
impl ImportAttemptDiagnostic {
    /// An attempt whose preview has not yet completed.
    pub fn new(source_kind: FailedIngestSourceKind) -> Self {
        Self {
            schema_id: "contextdesk.desktop_import_attempt.v1",
            schema_version: 1,
            product_version: env!("CARGO_PKG_VERSION"),
            privacy_policy: "aggregate_only_v1",
            source_kind,
            status: "preview",
            preview: None,
            verified_selected_sources: None,
            outcome_counts: None,
            defect_codes: Histogram::new(),
            ingest: None,
            progress: None,
            discrepancies: Vec::new(),
        }
    }
    /// Capture only public counters from the host-verified plan.
    pub fn set_preview(&mut self, plan: &ImportPreviewPlan) {
        let r = &plan.report;
        let mut p = Preview {
            entries: r.counts.total,
            observed_declared_bytes: 0,
            inventory_truncated: r.truncated,
            plan_block: r.plan_block(),
            status: Histogram::new(),
            role: Histogram::new(),
            reason: Histogram::new(),
            built_in_format: Histogram::new(),
        };
        for i in &r.items {
            p.observed_declared_bytes = p.observed_declared_bytes.saturating_add(i.bytes);
            add(&mut p.status, status_key(i.status), 1);
            add(&mut p.role, role_key(i.role), 1);
            for reason in &i.reasons {
                add(&mut p.reason, reason_key(*reason), 1);
            }
            if let Some(id) = &i.format_id {
                let key = BUILT_IN_FORMAT_PROFILES
                    .iter()
                    .find(|f| f.id == id)
                    .map_or("other", |f| f.id);
                add(&mut p.built_in_format, key, 1);
            }
        }
        if r.truncated {
            self.discrepancies = vec![ImportDiagnosticDiscrepancy::PreviewTruncatedUnreviewedTail];
        }
        self.preview = Some(p);
    }
    /// Record a run when verified selection is unavailable.
    pub fn start_run(&mut self) {
        self.status = "running";
    }
    /// Record the host-verified selection count (not the renderer's requested count).
    pub fn selected_count(&mut self, n: u64) {
        self.start_run();
        self.verified_selected_sources = Some(n);
    }
    /// Capture classified outcome and measured timings without operator-only fields.
    pub fn finish_ingest(&mut self, r: &IngestReport, o: &ImportOutcomeReport) {
        self.status = match (o.class, o.published) {
            (ImportOutcomeClass::Complete, true) => "complete",
            (ImportOutcomeClass::Partial, true) => "partial",
            _ => "rejected",
        };
        let mut reasons = Histogram::new();
        for s in &r.confidence.sources {
            for reason in &s.unresolved_reasons {
                add(&mut reasons, unresolved_key(*reason), 1);
            }
        }
        let stats = &r.stats;
        self.capture_outcome(o);
        self.ingest = Some(Ingest {
            source_bytes: stats.source_bytes,
            templates: stats.templates,
            parser_format: bounded(&stats.format_counts, &["json", "plain", "syslog", "logfmt"]),
            timestamp_provenance: bounded(
                &stats.timestamp_provenance_counts,
                &[
                    "explicit_wall",
                    "unresolved_local",
                    "order_only",
                    "legacy_unknown",
                ],
            ),
            timestamp_basis: bounded(
                &stats.active_timestamp_basis_counts,
                &[
                    "explicit_wall",
                    "resolved_local",
                    "order_only",
                    "legacy_unknown",
                ],
            ),
            source_confidence: r.confidence.counts.clone(),
            unresolved_time_reasons: reasons,
            phase_timings: r.phase_timings.clone(),
        });
        if let Some(n) = self.verified_selected_sources {
            if !self.preview.as_ref().is_some_and(|p| p.inventory_truncated)
                && n != o.counts.sources_imported
            {
                self.discrepancies.push(if o.counts.sources_imported == 0 {
                    ImportDiagnosticDiscrepancy::ImportableButZeroImported
                } else {
                    ImportDiagnosticDiscrepancy::SelectedVsImportedCount
                });
            }
            if o.class == ImportOutcomeClass::Partial {
                self.discrepancies
                    .push(ImportDiagnosticDiscrepancy::IngestPartialAgainstSelection);
            }
        }
        self.progress = Some(FailedIngestProgress {
            last_phase: if self.status == "rejected" {
                ProcessProgressPhase::Failed
            } else {
                ProcessProgressPhase::Completed
            },
            lines_processed: Some(stats.lines),
            files_processed: Some(stats.files as u64),
            bytes_processed: Some(stats.source_bytes),
            templates: Some(stats.templates as u64),
            ..Default::default()
        });
    }
    fn capture_outcome(&mut self, o: &ImportOutcomeReport) {
        self.outcome_counts = Some(o.counts.clone());
        self.defect_codes = bounded(
            &o.defect_counts,
            &[
                "archive_unreadable",
                "nested_archive_staging_failed",
                "archive_depth_exceeded",
                "archive_member_unstable",
                "member_metadata_failed",
                "member_open_failed",
                "member_read_failed",
                "member_too_large",
                "member_binary",
                "member_empty",
                "member_symlink",
                "member_non_regular",
                "malformed_structured_record",
                "unclassified",
            ],
        );
    }
    /// Capture a host-classified rejection without propagating its defect locators.
    pub fn finish_rejection(&mut self, o: &ImportOutcomeReport, progress: FailedIngestProgress) {
        self.finish_failure(false, progress);
        if o.class == ImportOutcomeClass::Rejected && !o.published {
            self.status = "rejected";
            self.capture_outcome(o);
        }
    }
    /// Terminal failures do not require error text (which may contain paths).
    pub fn finish_failure(&mut self, cancelled: bool, mut progress: FailedIngestProgress) {
        self.status = if cancelled { "cancelled" } else { "failed" };
        progress.last_phase = if cancelled {
            ProcessProgressPhase::Cancelled
        } else {
            ProcessProgressPhase::Failed
        };
        self.progress = Some(progress);
    }
    /// Serialize the bounded projection. No report identifiers or host paths are embedded.
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string_pretty(self)
    }
}

impl ImportAttemptDiagnostic {
    /// Atomically publish a new report at a host-selected path. Never replace
    /// a file (including a symbolic link); errors contain no destination names.
    pub fn write_new(&self, output: &std::path::Path) -> crate::error::CoreResult<()> {
        use crate::error::CoreError;
        use std::io::Write;
        let json = self
            .to_json()
            .map_err(|_| CoreError::Message("Cannot serialize import diagnostic.".into()))?;
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| CoreError::Message("Cannot stage import diagnostic.".into()))?;
        staged
            .write_all(json.as_bytes())
            .and_then(|()| staged.as_file().sync_all())
            .map_err(|_| CoreError::Message("Cannot write import diagnostic.".into()))?;
        staged
            .persist_noclobber(output)
            .map_err(|_| CoreError::Message("Destination exists or cannot be created.".into()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::import_preview::preview_import_plan;
    use super::*;

    #[test]
    fn real_success_retains_measured_counts_but_no_private_strings() {
        use super::super::ingest::ingest_path;
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("PRIVATE-corpus.jsonl");
        std::fs::write(&input, "{\"level\":\"info\",\"message\":\"PRIVATE-message\",\"timestamp\":\"2024-12-01T01:02:03Z\"}\n").unwrap();
        let plan = preview_import_plan(&input, None).unwrap();
        let mut r = ingest_path(
            &temp.path().join("cache"),
            &input,
            "PRIVATE-display",
            None,
            "",
        )
        .unwrap();
        r.stats.format_counts.insert("PRIVATE-parser".into(), 1);
        r.stats
            .active_timestamp_basis_counts
            .insert("PRIVATE-basis".into(), 1);
        let mut o = ImportOutcomeReport::published(&r.corpus_id, &r.stats, &r.stats.defects);
        o.defect_counts.insert("PRIVATE-defect".into(), 1);
        let mut a = ImportAttemptDiagnostic::new(FailedIngestSourceKind::File);
        a.set_preview(&plan);
        a.selected_count(1);
        a.finish_ingest(&r, &o);
        let json = a.to_json().unwrap();
        for forbidden in [
            "PRIVATE",
            "2024-12-01",
            r.corpus_id.as_str(),
            o.manifest_digest.as_str(),
            plan.plan_token.as_str(),
        ] {
            assert!(!json.contains(forbidden), "unexpected private field");
        }
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["status"], "complete");
        assert_eq!(v["outcomeCounts"]["sourcesImported"], 1);
        assert_eq!(v["ingest"]["parserFormat"]["other"], 1);
        assert_eq!(v["ingest"]["timestampBasis"]["other"], 1);
        assert_eq!(v["defectCodes"]["other"], 1);
    }
    #[test]
    fn rejected_error_exports_only_aggregate_classification() {
        let e = crate::error::CoreError::Message(
            "zip open: PRIVATE-member.zip [member=PRIVATE]".into(),
        );
        let o = ImportOutcomeReport::rejected_from_error(&e);
        let mut a = ImportAttemptDiagnostic::new(FailedIngestSourceKind::Zip);
        a.finish_rejection(&o, FailedIngestProgress::default());
        let json = a.to_json().unwrap();
        assert!(!json.contains("PRIVATE"));
        assert!(!json.contains(&o.manifest_digest));
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["status"], "rejected");
        assert!(v["ingest"].is_null());
    }
    #[test]
    fn private_input_never_enters_serialized_preview_or_error() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("private-canary-member.jsonl");
        std::fs::write(
            &input,
            "{\"message\":\"private-canary-payload\",\"ts\":\"2024-09-01T12:00:00Z\"}\n",
        )
        .unwrap();
        let mut plan = preview_import_plan(&input, None).unwrap();
        assert!(!plan.report.items.is_empty());
        plan.report.items[0].format_id = Some("private-canary-grammar".into());
        let mut report = ImportAttemptDiagnostic::new(FailedIngestSourceKind::File);
        report.set_preview(&plan);
        let json = report.to_json().unwrap();
        assert!(!json.contains("private-canary"));
        assert!(!json.contains("2024-09-01"));
        assert!(!json.contains(&plan.plan_token));
        assert!(json.contains("\"other\": 1"));
        assert_eq!(report.to_json().unwrap(), json);
        let error = report.write_new(&input).unwrap_err().to_string();
        assert!(!error.contains("private-canary"));
        assert!(std::fs::read_to_string(&input)
            .unwrap()
            .contains("private-canary-payload"));
        let out = temp.path().join("report.json");
        report.write_new(&out).unwrap();
        assert_eq!(std::fs::read_to_string(out).unwrap(), json);
    }
    #[test]
    fn unrecognized_metric_keys_collapse_without_exposure_or_overflow() {
        let input = BTreeMap::from([
            ("json".to_owned(), 5),
            ("private-first".to_owned(), u64::MAX),
            ("private-second".to_owned(), 1),
        ]);
        assert_eq!(
            bounded(&input, &["json"]),
            BTreeMap::from([("json", 5), ("other", u64::MAX)])
        );
    }
    #[test]
    fn failures_and_cancellations_are_not_success_or_a_cleanup_claim() {
        for (cancelled, status) in [(true, "cancelled"), (false, "failed")] {
            let mut report = ImportAttemptDiagnostic::new(FailedIngestSourceKind::Unknown);
            report.start_run();
            report.finish_failure(
                cancelled,
                FailedIngestProgress {
                    files_processed: Some(3),
                    ..Default::default()
                },
            );
            let doc: serde_json::Value = serde_json::from_str(&report.to_json().unwrap()).unwrap();
            assert_eq!(doc["status"], status);
            assert_eq!(doc["progress"]["filesProcessed"], 3);
            assert!(doc["ingest"].is_null());
            assert!(doc["verifiedSelectedSources"].is_null());
            assert!(doc.get("temporaryCorpusDeleted").is_none());
        }
    }
}
